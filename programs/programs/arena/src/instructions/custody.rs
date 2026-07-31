//! Player custody: moving lamports in and out of the shared pool vault.
//!
//! All player funds sit in one `pool` PDA; per-player amounts are tracked as
//! numbers on `PlayerAccount`. One vault rather than one per player keeps rent
//! cost constant as the player base grows, and makes an entry-fee lock a
//! bookkeeping change plus a single vault-to-vault transfer.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::ArenaError;
use crate::events::*;
use crate::state::*;
use crate::utils::*;

// ---------------------------------------------------------------------------
// deposit
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ ArenaError::ProgramPaused
    )]
    pub config: Account<'info, Config>,

    /// `init_if_needed` is safe here because the seeds bind this PDA to exactly
    /// one signer, so there is no address a caller could aim it at that they do
    /// not already own. The owner field is still asserted below.
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PlayerAccount::INIT_SPACE,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump
    )]
    pub player_account: Account<'info, PlayerAccount>,

    /// CHECK: Seed-validated custody vault.
    #[account(mut, seeds = [POOL_SEED], bump = config.pool_bump)]
    pub pool: UncheckedAccount<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount >= MIN_DEPOSIT_LAMPORTS, ArenaError::DepositTooSmall);

    let player_key = ctx.accounts.player.key();
    let player_account = &mut ctx.accounts.player_account;

    // Freshly initialised accounts are zeroed, so a default owner means this is
    // the first deposit.
    if player_account.owner == Pubkey::default() {
        player_account.owner = player_key;
        player_account.bump = ctx.bumps.player_account;
    }
    require_keys_eq!(
        player_account.owner,
        player_key,
        ArenaError::PlayerOwnerMismatch
    );

    transfer_to_vault(
        &ctx.accounts.player,
        &ctx.accounts.pool.to_account_info(),
        amount,
        &ctx.accounts.system_program,
    )?;

    player_account.balance = add(player_account.balance, amount)?;
    player_account.total_deposited = add(player_account.total_deposited, amount)?;

    emit!(Deposited {
        player: player_key,
        amount,
        new_balance: player_account.balance,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// Withdrawals are deliberately NOT gated on `paused`. A pause is for
    /// stopping new risk, not for trapping funds that already belong to players.
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump = player_account.bump,
        constraint = player_account.owner == player.key() @ ArenaError::PlayerOwnerMismatch
    )]
    pub player_account: Account<'info, PlayerAccount>,

    /// CHECK: Seed-validated custody vault.
    #[account(mut, seeds = [POOL_SEED], bump = config.pool_bump)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: Seed-validated rake vault, matched against config.treasury so a
    /// caller cannot redirect the fee to an account they control.
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump = config.treasury_bump,
        constraint = treasury.key() == config.treasury @ ArenaError::TreasuryMismatch
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Returns lamports to the player's wallet, less the withdrawal fee.
///
/// `amount` is the gross debit from the custody balance; the player receives
/// `amount - fee` and the treasury receives `fee`. Debiting the gross figure
/// is what keeps the books balanced — the two transfers below sum exactly to
/// what left the player's balance, so the pool cannot drift.
pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(
        amount >= MIN_WITHDRAWAL_LAMPORTS,
        ArenaError::WithdrawalTooSmall
    );

    let fee = apply_bps(amount, ctx.accounts.config.withdrawal_fee_bps)?;
    let net = sub(amount, fee)?;

    let player_account = &mut ctx.accounts.player_account;
    require!(
        player_account.balance >= amount,
        ArenaError::InsufficientBalance
    );

    // Balance is debited before the transfer. Solana has no reentrancy in the
    // EVM sense, but keeping state-then-transfer ordering means a failed CPI
    // rolls back the whole instruction rather than leaving a credited balance.
    player_account.balance = sub(player_account.balance, amount)?;
    player_account.total_withdrawn = add(player_account.total_withdrawn, amount)?;

    let pool_bump = ctx.accounts.config.pool_bump;
    let bump_seed = [pool_bump];
    let seeds: &[&[u8]] = &[POOL_SEED, &bump_seed];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    transfer_from_vault(
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.player.to_account_info(),
        net,
        &ctx.accounts.system_program,
        signer_seeds,
    )?;

    // `transfer_from_vault` is a no-op at zero, so a zero-fee config costs
    // nothing here.
    transfer_from_vault(
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
        fee,
        &ctx.accounts.system_program,
        signer_seeds,
    )?;

    emit!(Withdrawn {
        player: ctx.accounts.player.key(),
        amount,
        fee,
        net,
        new_balance: player_account.balance,
    });

    Ok(())
}
