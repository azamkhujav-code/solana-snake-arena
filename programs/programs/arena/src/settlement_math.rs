//! Pure settlement arithmetic.
//!
//! Extracted from `instructions/settle.rs` so it can be tested without a
//! validator. The account plumbing there — ownership checks, discriminators,
//! PDA derivation — genuinely needs a runtime. The *arithmetic* does not, and
//! the arithmetic is where a wrong answer silently pays the wrong amount rather
//! than failing loudly.
//!
//! Every function here is total: it either returns a value or a named error,
//! and never panics. A panic inside a Solana instruction aborts the transaction
//! with a message that says nothing about which invariant broke.

use crate::constants::{BPS_DENOMINATOR, MAX_FEE_BPS, MAX_WINNERS_PER_DISTRIBUTION};
use crate::errors::ArenaError;
use anchor_lang::prelude::*;

/// Sums a payout list and checks it against the prize pool.
///
/// The equality is the core safety property of the whole program: the backend
/// decides *who* wins and *how much* each gets, but cannot change the total.
/// A backend that has been compromised can misallocate a pot; it cannot mint
/// lamports or skim one.
///
/// Zero payouts are rejected rather than skipped. A zero entry consumes a
/// winner slot and emits a `WinnerPaid` event for nothing, which makes the
/// event stream lie about what happened.
pub fn validate_payouts(payouts: &[u64], prize_pool: u64) -> Result<u64> {
    require!(!payouts.is_empty(), ArenaError::NoWinners);
    require!(
        payouts.len() <= MAX_WINNERS_PER_DISTRIBUTION,
        ArenaError::TooManyWinners
    );

    let mut total: u64 = 0;
    for amount in payouts {
        require!(*amount > 0, ArenaError::ZeroPayout);
        total = total.checked_add(*amount).ok_or(ArenaError::Overflow)?;
    }

    require!(total == prize_pool, ArenaError::PayoutMismatch);
    Ok(total)
}

/// Splits a pot into rake and prize pool.
///
/// Integer division truncates, so the rake rounds **down** and the remainder
/// stays with the players. That direction is deliberate: rounding the house's
/// cut up would take a lamport from the pot on every single match, and across
/// millions of matches "a rounding error in the house's favour" is a phrase
/// that ends up in a regulator's report.
///
/// The fee cap is re-checked here rather than trusted from config. Config is
/// written by an admin key; if that key is compromised, this is the line that
/// still holds.
pub fn split_pot(pot: u64, fee_bps: u16) -> Result<(u64, u64)> {
    require!(fee_bps <= MAX_FEE_BPS, ArenaError::FeeTooHigh);

    let rake = (pot as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(ArenaError::Overflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(ArenaError::Overflow)?;

    let rake = u64::try_from(rake).map_err(|_| ArenaError::Overflow)?;
    let prize = pot.checked_sub(rake).ok_or(ArenaError::Underflow)?;

    Ok((rake, prize))
}

/// Total escrow required for a room at capacity.
///
/// Used to size the vault before players join. Overflow here would understate
/// the requirement, which surfaces much later as a room that cannot pay out.
pub fn total_escrow(entry_fee: u64, players: u16) -> Result<u64> {
    entry_fee
        .checked_mul(players as u64)
        .ok_or_else(|| ArenaError::Overflow.into())
}

/// Whether a refund claim is within what the room actually escrowed.
///
/// A refund larger than the entry fee would let a cancelled room drain the
/// vault of somebody else's stake.
pub fn validate_refund(claimed: u64, entry_paid: u64) -> Result<()> {
    require!(claimed > 0, ArenaError::ZeroPayout);
    require!(claimed <= entry_paid, ArenaError::PayoutMismatch);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Anchor errors compare by their numeric code.
    fn code_of(error: Error) -> u32 {
        match error {
            Error::AnchorError(inner) => inner.error_code_number,
            Error::ProgramError(inner) => format!("{inner:?}").len() as u32,
        }
    }

    fn expect_error(result: Result<impl std::fmt::Debug>, expected: ArenaError) {
        let error = result.expect_err("expected this to fail");
        assert_eq!(code_of(error), expected as u32 + 6000);
    }

    mod validate_payouts {
        use super::*;

        #[test]
        fn accepts_a_single_winner_taking_the_pool() {
            assert_eq!(validate_payouts(&[1_000], 1_000).unwrap(), 1_000);
        }

        #[test]
        fn accepts_a_split_that_sums_exactly() {
            assert_eq!(validate_payouts(&[500, 300, 200], 1_000).unwrap(), 1_000);
        }

        #[test]
        fn rejects_an_empty_winner_list() {
            expect_error(validate_payouts(&[], 1_000), ArenaError::NoWinners);
        }

        #[test]
        fn rejects_paying_out_more_than_the_pool() {
            // The property that stops a compromised backend minting lamports.
            expect_error(
                validate_payouts(&[600, 500], 1_000),
                ArenaError::PayoutMismatch,
            );
        }

        #[test]
        fn rejects_paying_out_less_than_the_pool() {
            // Under-paying is equally wrong: the remainder would be stranded in
            // the vault with no instruction able to release it.
            expect_error(
                validate_payouts(&[400, 500], 1_000),
                ArenaError::PayoutMismatch,
            );
        }

        #[test]
        fn rejects_a_zero_payout() {
            // A zero entry burns a winner slot and emits an event for nothing.
            expect_error(validate_payouts(&[1_000, 0], 1_000), ArenaError::ZeroPayout);
        }

        #[test]
        fn rejects_more_winners_than_one_call_can_pay() {
            let many = vec![1u64; MAX_WINNERS_PER_DISTRIBUTION + 1];
            expect_error(
                validate_payouts(&many, many.len() as u64),
                ArenaError::TooManyWinners,
            );
        }

        #[test]
        fn accepts_exactly_the_maximum_winners() {
            let many = vec![1u64; MAX_WINNERS_PER_DISTRIBUTION];
            assert_eq!(
                validate_payouts(&many, MAX_WINNERS_PER_DISTRIBUTION as u64).unwrap(),
                MAX_WINNERS_PER_DISTRIBUTION as u64
            );
        }

        #[test]
        fn reports_overflow_rather_than_wrapping() {
            // Wrapping would let two enormous payouts sum to a small number that
            // matches the pool — paying out far more than was escrowed.
            expect_error(
                validate_payouts(&[u64::MAX, u64::MAX], 0),
                ArenaError::Overflow,
            );
        }

        #[test]
        fn rejects_a_zero_pool_even_with_a_zero_total() {
            // Reached only via an empty list, which NoWinners already rejects.
            expect_error(validate_payouts(&[], 0), ArenaError::NoWinners);
        }
    }

    mod split_pot {
        use super::*;

        #[test]
        fn takes_no_rake_at_zero_bps() {
            assert_eq!(split_pot(1_000, 0).unwrap(), (0, 1_000));
        }

        #[test]
        fn takes_the_stated_percentage() {
            // 500 bps is 5%.
            assert_eq!(split_pot(10_000, 500).unwrap(), (500, 9_500));
        }

        #[test]
        fn rounds_the_rake_down() {
            // 1% of 1_001 is 10.01. The house gets 10 and the extra lamport
            // stays with the players — rounding the other way would take a
            // lamport from every pot on the platform.
            assert_eq!(split_pot(1_001, 100).unwrap(), (10, 991));
        }

        #[test]
        fn always_sums_back_to_the_pot() {
            for pot in [0u64, 1, 7, 999, 1_000_000, u64::MAX / 2] {
                for bps in [0u16, 1, 250, 999, MAX_FEE_BPS] {
                    let (rake, prize) = split_pot(pot, bps).unwrap();
                    assert_eq!(rake + prize, pot, "pot={pot} bps={bps}");
                }
            }
        }

        #[test]
        fn accepts_the_cap_exactly() {
            assert!(split_pot(1_000, MAX_FEE_BPS).is_ok());
        }

        #[test]
        fn rejects_a_fee_above_the_cap() {
            // Re-checked here rather than trusted from config: if the admin key
            // is compromised, this is the line that still holds.
            expect_error(split_pot(1_000, MAX_FEE_BPS + 1), ArenaError::FeeTooHigh);
        }

        #[test]
        fn rejects_a_hundred_percent_fee() {
            expect_error(split_pot(1_000, 10_000), ArenaError::FeeTooHigh);
        }

        #[test]
        fn handles_the_largest_pot_without_overflowing() {
            // The multiply is widened to u128 precisely so this does not wrap.
            let (rake, prize) = split_pot(u64::MAX, MAX_FEE_BPS).unwrap();
            assert_eq!(rake + prize, u64::MAX);
        }
    }

    mod total_escrow {
        use super::*;

        #[test]
        fn multiplies_fee_by_capacity() {
            assert_eq!(total_escrow(1_000, 16).unwrap(), 16_000);
        }

        #[test]
        fn is_zero_for_a_free_room() {
            assert_eq!(total_escrow(0, 128).unwrap(), 0);
        }

        #[test]
        fn reports_overflow_rather_than_understating_the_requirement() {
            // Wrapping would size the vault too small, surfacing much later as a
            // room that cannot pay its winners.
            expect_error(total_escrow(u64::MAX, 2), ArenaError::Overflow);
        }
    }

    mod validate_refund {
        use super::*;

        #[test]
        fn accepts_a_full_refund() {
            assert!(validate_refund(1_000, 1_000).is_ok());
        }

        #[test]
        fn accepts_a_partial_refund() {
            assert!(validate_refund(400, 1_000).is_ok());
        }

        #[test]
        fn rejects_claiming_more_than_was_staked() {
            // Otherwise a cancelled room drains somebody else's stake.
            expect_error(validate_refund(1_001, 1_000), ArenaError::PayoutMismatch);
        }

        #[test]
        fn rejects_a_zero_claim() {
            expect_error(validate_refund(0, 1_000), ArenaError::ZeroPayout);
        }
    }
}
