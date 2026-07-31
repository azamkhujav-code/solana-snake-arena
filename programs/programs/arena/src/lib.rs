//! Slither Arena — on-chain custody, room escrow and prize settlement.
//!
//! # Scope
//!
//! Gameplay is simulated off-chain by the realtime nodes; putting movement
//! on-chain is neither fast enough nor affordable. This program does three
//! things: it custodies player funds, it escrows entry fees for a wagered
//! room, and it pays the pot out against a result signed by the settlement
//! authority.
//!
//! # Trust model
//!
//! The backend is trusted to *report* who won. That trust is deliberately
//! bounded by what the program enforces, so a compromised settlement key
//! cannot steal funds — only misreport a winner:
//!
//! * Payouts must sum to the prize pool exactly, committed by `unlock_prize`
//!   before any lamports move. The authority cannot under-pay and keep the
//!   remainder, nor over-pay and drain another room's escrow.
//!
//! * The rake is capped at [`constants::MAX_FEE_BPS`] and snapshotted per room
//!   at creation, so a config change cannot retroactively tax a running game.
//!
//! * A room settles at most once — status flips to `Settled` in the same
//!   instruction that transfers, so a replay hits the state check.
//!
//! * `cancel_room` is permissionless after a delay, and refunds are
//!   crankable by anyone, so players can always recover funds without the
//!   backend's cooperation.
//!
//! * The admin authority is separate from the settlement authority and moves
//!   through a two-step handover.
//!
//! # Account layout
//!
//! Vaults (`pool`, `treasury`, `room_vault`) are PDAs with **no data**, so they
//! remain owned by the System Program and lamports move via CPI signed with
//! their seeds. State accounts (`Config`, `PlayerAccount`, `Room`,
//! `RoomPlayer`) are owned by this program and never hold lamports beyond rent.
//! Keeping those two roles in separate accounts avoids the entire class of
//! "cannot debit an account with data" failures.
//!
//! ```text
//!   [b"config"]                            -> Config
//!   [b"pool"]                              -> shared custody vault
//!   [b"treasury"]                          -> rake vault
//!   [b"player",      owner]                -> PlayerAccount
//!   [b"room",        room_id]              -> Room
//!   [b"room_vault",  room_id]              -> per-room escrow vault
//!   [b"room_player", room, player]         -> RoomPlayer
//! ```
//!
//! # Lifecycle
//!
//! ```text
//!   deposit ──► join_room ──► lock_entry_fee ──► start_room
//!                                                    │
//!                                                    ▼
//!                                              unlock_prize
//!                                                    │
//!                                                    ▼
//!                                          distribute_winnings ──► withdraw
//!
//!   any point before Settled:  cancel_room ──► claim_refund ──► withdraw
//! ```

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod settlement_math;
pub mod state;
pub mod utils;

use constants::ROOM_ID_LEN;
use instructions::*;

declare_id!("4y2eaLGzqmfFrMTAhVzruQ4BeuHsBZCdAR52FBFkJ9hc");

#[program]
pub mod arena {
    use super::*;

    // ---- Administration --------------------------------------------------

    /// One-time setup: creates the config PDA and funds the pool and treasury
    /// vaults to rent exemption.
    ///
    /// `fee_destination` is the wallet that receives the platform fee directly
    /// on every settlement — the game owner's, not a program-held vault.
    pub fn initialize(
        ctx: Context<Initialize>,
        settlement_authority: Pubkey,
        fee_destination: Pubkey,
        fee_bps: u16,
        withdrawal_fee_bps: u16,
    ) -> Result<()> {
        instructions::admin::initialize(
            ctx,
            settlement_authority,
            fee_destination,
            fee_bps,
            withdrawal_fee_bps,
        )
    }

    /// Updates fee, settlement authority, fee destination and/or pause state.
    /// Admin only.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        fee_bps: Option<u16>,
        withdrawal_fee_bps: Option<u16>,
        settlement_authority: Option<Pubkey>,
        fee_destination: Option<Pubkey>,
        paused: Option<bool>,
    ) -> Result<()> {
        instructions::admin::update_config(
            ctx,
            fee_bps,
            withdrawal_fee_bps,
            settlement_authority,
            fee_destination,
            paused,
        )
    }

    /// Nominates a new admin. Takes effect only once they call `accept_admin`.
    pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::transfer_admin(ctx, new_admin)
    }

    /// Completes the admin handover.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::accept_admin(ctx)
    }

    /// Moves accumulated rake out of the treasury vault. Admin only.
    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        instructions::admin::withdraw_treasury(ctx, amount)
    }

    // ---- Custody ---------------------------------------------------------

    /// Funds a player's custody balance from their wallet.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::custody::deposit(ctx, amount)
    }

    /// Returns lamports from a player's custody balance to their wallet.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::custody::withdraw(ctx, amount)
    }

    // ---- Rooms -----------------------------------------------------------

    /// Opens a wagered room and its escrow vault. Settlement authority only.
    pub fn create_room(
        ctx: Context<CreateRoom>,
        room_id: [u8; ROOM_ID_LEN],
        entry_fee: u64,
        max_players: u16,
    ) -> Result<()> {
        instructions::room::create_room(ctx, room_id, entry_fee, max_players)
    }

    /// Reserves a seat. Idempotent: a second call fails on account creation.
    pub fn join_room(ctx: Context<JoinRoom>) -> Result<()> {
        instructions::room::join_room(ctx)
    }

    /// Takes a seat and escrows the entry fee in one transaction.
    ///
    /// The direct-entry path: the fee moves from the player's own wallet into
    /// this match's vault, with no custody balance in between. `join_room` and
    /// `lock_entry_fee` remain for the custodial flow.
    pub fn enter_room(ctx: Context<EnterRoom>) -> Result<()> {
        instructions::room::enter_room(ctx)
    }

    /// Escrows the entry fee from custody into the room vault.
    pub fn lock_entry_fee(ctx: Context<LockEntryFee>) -> Result<()> {
        instructions::room::lock_entry_fee(ctx)
    }

    /// Closes joining. Settlement authority only.
    pub fn start_room(ctx: Context<StartRoom>) -> Result<()> {
        instructions::room::start_room(ctx)
    }

    // ---- Settlement ------------------------------------------------------

    /// Commits the prize/rake split. Moves no lamports.
    pub fn unlock_prize(ctx: Context<UnlockPrize>) -> Result<()> {
        instructions::settle::unlock_prize(ctx)
    }

    /// Credits every winner and sweeps the rake, atomically.
    pub fn distribute_winnings<'info>(
        ctx: Context<'_, '_, 'info, 'info, DistributeWinnings<'info>>,
        payouts: Vec<u64>,
    ) -> Result<()> {
        instructions::settle::distribute_winnings(ctx, payouts)
    }

    /// Pays the last surviving player directly to their own wallet.
    ///
    /// The direct-entry settlement path. `distribute_winnings` credits custody
    /// balances instead, which is right for the custodial model and wrong here.
    pub fn settle_to_winner(ctx: Context<SettleToWinner>) -> Result<()> {
        instructions::settle::settle_to_winner(ctx)
    }

    /// Aborts a room. Permissionless after the cancel delay.
    pub fn cancel_room(ctx: Context<CancelRoom>) -> Result<()> {
        instructions::settle::cancel_room(ctx)
    }

    /// Returns one player's escrowed entry fee after cancellation.
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        instructions::settle::claim_refund(ctx)
    }
}
