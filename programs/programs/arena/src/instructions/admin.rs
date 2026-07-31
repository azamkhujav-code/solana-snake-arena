//! Program setup and administration.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::ArenaError;
use crate::events::*;
use crate::state::*;
use crate::utils::*;

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    /// CHECK: System-owned lamport vault holding all player custody funds.
    /// Validated by seeds; never deserialised, so it carries no data and stays
    /// owned by the System Program (which is what makes CPI transfers work).
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: System-owned lamport vault holding accumulated rake.
    #[account(mut, seeds = [TREASURY_SEED], bump)]
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize(
    ctx: Context<Initialize>,
    settlement_authority: Pubkey,
    fee_destination: Pubkey,
    fee_bps: u16,
    withdrawal_fee_bps: u16,
) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, ArenaError::FeeTooHigh);
    require!(
        withdrawal_fee_bps <= MAX_WITHDRAWAL_FEE_BPS,
        ArenaError::FeeTooHigh
    );

    // Vaults are plain system accounts and only begin to exist once funded.
    // Doing it here means no later instruction has to handle a missing vault.
    fund_rent_exemption(
        &ctx.accounts.admin,
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.system_program,
    )?;
    fund_rent_exemption(
        &ctx.accounts.admin,
        &ctx.accounts.treasury.to_account_info(),
        &ctx.accounts.system_program,
    )?;

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.pending_admin = None;
    config.settlement_authority = settlement_authority;
    config.fee_destination = fee_destination;
    config.treasury = ctx.accounts.treasury.key();
    config.fee_bps = fee_bps;
    config.withdrawal_fee_bps = withdrawal_fee_bps;
    config.paused = false;
    config.total_rooms = 0;
    config.bump = ctx.bumps.config;
    config.pool_bump = ctx.bumps.pool;
    config.treasury_bump = ctx.bumps.treasury;

    emit!(ProgramInitialized {
        admin: config.admin,
        settlement_authority: config.settlement_authority,
        treasury: config.treasury,
        fee_bps: config.fee_bps,
        withdrawal_fee_bps: config.withdrawal_fee_bps,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// update_config
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ArenaError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,
}

/// Every field is optional so a caller can change one without restating the
/// rest — restating is how a stale client accidentally reverts a setting.
pub fn update_config(
    ctx: Context<UpdateConfig>,
    fee_bps: Option<u16>,
    withdrawal_fee_bps: Option<u16>,
    settlement_authority: Option<Pubkey>,
    fee_destination: Option<Pubkey>,
    paused: Option<bool>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(bps) = fee_bps {
        require!(bps <= MAX_FEE_BPS, ArenaError::FeeTooHigh);
        config.fee_bps = bps;
    }
    if let Some(bps) = withdrawal_fee_bps {
        require!(bps <= MAX_WITHDRAWAL_FEE_BPS, ArenaError::FeeTooHigh);
        config.withdrawal_fee_bps = bps;
    }
    if let Some(authority) = settlement_authority {
        config.settlement_authority = authority;
    }
    if let Some(destination) = fee_destination {
        // Rotatable without a program upgrade: the owner's wallet is the most
        // likely thing to change, and needing a redeploy to change it would
        // mean not changing it.
        config.fee_destination = destination;
    }
    if let Some(is_paused) = paused {
        config.paused = is_paused;
    }

    emit!(ConfigUpdated {
        admin: config.admin,
        settlement_authority: config.settlement_authority,
        treasury: config.treasury,
        fee_bps: config.fee_bps,
        withdrawal_fee_bps: config.withdrawal_fee_bps,
        paused: config.paused,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// transfer_admin / accept_admin
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ArenaError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,
}

/// Step one of a two-step handover. A single-step transfer to a mistyped
/// address permanently bricks administration, so the new key must prove it can
/// sign before it takes effect.
pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.pending_admin = Some(new_admin);

    emit!(AdminTransferInitiated {
        current_admin: config.admin,
        pending_admin: new_admin,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub new_admin: Signer<'info>,
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;

    let pending = config.pending_admin.ok_or(ArenaError::NoPendingAdmin)?;
    require_keys_eq!(
        pending,
        ctx.accounts.new_admin.key(),
        ArenaError::NotPendingAdmin
    );

    let previous = config.admin;
    config.admin = pending;
    config.pending_admin = None;

    emit!(AdminTransferAccepted {
        previous_admin: previous,
        new_admin: config.admin,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// withdraw_treasury
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ArenaError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,

    /// CHECK: Seed-validated rake vault. Also matched against config.treasury
    /// so a caller cannot substitute a different PDA.
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump = config.treasury_bump,
        constraint = treasury.key() == config.treasury @ ArenaError::TreasuryMismatch
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Arbitrary destination chosen by the admin.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
    let treasury_bump = ctx.accounts.config.treasury_bump;
    let bump_seed = [treasury_bump];
    let seeds: &[&[u8]] = &[TREASURY_SEED, &bump_seed];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    transfer_from_vault(
        &ctx.accounts.treasury.to_account_info(),
        &ctx.accounts.destination.to_account_info(),
        amount,
        &ctx.accounts.system_program,
        signer_seeds,
    )?;

    emit!(TreasuryWithdrawn {
        destination: ctx.accounts.destination.key(),
        amount,
        remaining: ctx.accounts.treasury.lamports(),
    });

    Ok(())
}
