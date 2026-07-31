//! Lamport movement helpers.
//!
//! Two distinct mechanisms are needed, and mixing them up is a common source of
//! "instruction failed" with no useful message:
//!
//!   * Vaults (`pool`, `treasury`, `room_vault`) are PDAs that hold lamports
//!     but carry **no data**, so they stay owned by the System Program. Moving
//!     lamports out of them therefore goes through a System Program CPI signed
//!     with the PDA's seeds.
//!   * Data accounts (`Config`, `Room`, …) are owned by this program. The
//!     System Program refuses to debit those, so they would need direct lamport
//!     arithmetic instead. This program never moves lamports out of a data
//!     account, which keeps that whole class of bug out of scope.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::errors::ArenaError;

/// Transfers lamports **into** a vault from a user wallet.
pub fn transfer_to_vault<'info>(
    from: &Signer<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    system_program: &Program<'info, System>,
) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            system_program.to_account_info(),
            Transfer {
                from: from.to_account_info(),
                to: to.clone(),
            },
        ),
        amount,
    )
}

/// Transfers lamports **out of** a program-derived vault.
///
/// Refuses to leave the vault below rent exemption. A vault drained to zero is
/// garbage-collected by the runtime, and the next deposit would then land in a
/// freshly created account — silently losing the association.
pub fn transfer_from_vault<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    system_program: &Program<'info, System>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let rent_exempt_minimum = Rent::get()?.minimum_balance(0);
    let balance = from.lamports();

    let remaining = balance
        .checked_sub(amount)
        .ok_or(ArenaError::InsufficientVaultFunds)?;
    require!(
        remaining >= rent_exempt_minimum,
        ArenaError::WouldBreakRentExemption
    );

    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            Transfer {
                from: from.clone(),
                to: to.clone(),
            },
            signer_seeds,
        ),
        amount,
    )
}

/// Ensures a freshly seeded vault holds enough lamports to be rent exempt.
///
/// Vaults are plain system accounts, so they only start existing once funded.
/// Every vault is topped up at creation by the instruction that introduces it.
pub fn fund_rent_exemption<'info>(
    payer: &Signer<'info>,
    vault: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
) -> Result<u64> {
    let required = Rent::get()?.minimum_balance(0);
    let current = vault.lamports();

    if current >= required {
        return Ok(0);
    }

    let top_up = required.checked_sub(current).ok_or(ArenaError::Underflow)?;
    transfer_to_vault(payer, vault, top_up, system_program)?;
    Ok(top_up)
}

/// Checked add that surfaces a named error instead of a generic panic.
pub fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| ArenaError::Overflow.into())
}

/// Checked subtract.
pub fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or_else(|| ArenaError::Underflow.into())
}

/// `amount * bps / 10_000`, widened to u128 so the multiply cannot overflow
/// before the divide.
pub fn apply_bps(amount: u64, bps: u16) -> Result<u64> {
    let product = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(ArenaError::Overflow)?;
    let result = product
        .checked_div(crate::constants::BPS_DENOMINATOR as u128)
        .ok_or(ArenaError::Overflow)?;
    u64::try_from(result).map_err(|_| ArenaError::Overflow.into())
}
