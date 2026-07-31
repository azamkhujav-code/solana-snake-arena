use anchor_lang::prelude::*;

use crate::constants::ROOM_ID_LEN;

/// Global program configuration. Exactly one, at PDA `[b"config"]`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// May pause the program, change fees and withdraw treasury funds.
    pub admin: Pubkey,
    /// Two-step admin handover. A single-step transfer to a mistyped address
    /// permanently bricks the program, so the new admin must accept.
    pub pending_admin: Option<Pubkey>,
    /// Hot key held by the backend; may create rooms and settle results.
    /// Separate from `admin` so it can be rotated after a compromise without
    /// touching the account that controls the money.
    pub settlement_authority: Pubkey,
    /// Seed-derived rake vault. Retained for withdrawal fees, which accrue in
    /// small amounts and are swept, rather than being worth a transfer each.
    pub treasury: Pubkey,
    /// Wallet that receives the match platform fee **directly**.
    ///
    /// Deliberately an ordinary wallet rather than the treasury PDA: the fee is
    /// the game owner's revenue, and routing it through a vault they then have
    /// to withdraw from adds a manual step and a window in which the money is
    /// held by the program rather than by them. Changing it is an admin action
    /// and emits `ConfigUpdated`.
    pub fee_destination: Pubkey,
    /// House rake in basis points. Capped at `MAX_FEE_BPS`.
    pub fee_bps: u16,
    /// Fee charged on withdrawal, routed to the treasury. Capped at
    /// `MAX_WITHDRAWAL_FEE_BPS`.
    pub withdrawal_fee_bps: u16,
    /// Blocks deposits, joins and locks without needing a program upgrade.
    /// Withdrawals and refunds stay open by design — a pause must never trap
    /// player funds.
    pub paused: bool,
    pub total_rooms: u64,
    pub bump: u8,
    pub pool_bump: u8,
    pub treasury_bump: u8,
}

/// A player's custody record at PDA `[b"player", owner]`.
///
/// Holds the accounting only; the lamports themselves live in the single pool
/// vault. One vault instead of one per player keeps rent cost constant as the
/// player base grows.
#[account]
#[derive(InitSpace)]
pub struct PlayerAccount {
    pub owner: Pubkey,
    /// Withdrawable balance. Entry fees are deducted from here at lock time.
    pub balance: u64,
    pub total_deposited: u64,
    pub total_withdrawn: u64,
    pub total_wagered: u64,
    pub total_winnings: u64,
    pub rooms_joined: u32,
    pub bump: u8,
}

/// A wagered match at PDA `[b"room", room_id]`.
#[account]
#[derive(InitSpace)]
pub struct Room {
    pub room_id: [u8; ROOM_ID_LEN],
    pub creator: Pubkey,
    pub status: RoomStatus,
    pub entry_fee: u64,
    pub max_players: u16,
    pub player_count: u16,
    /// How many players have actually escrowed their entry fee.
    pub locked_count: u16,
    /// Total lamports escrowed in this room's vault.
    pub total_locked: u64,
    /// Set by `unlock_prize`: what is available to winners after rake.
    pub prize_pool: u64,
    /// Set by `unlock_prize`: what the treasury receives.
    pub rake_amount: u64,
    /// Running total paid out, so a partial distribution can resume.
    pub distributed: u64,
    pub winners_paid: u16,
    /// Fee snapshot taken at creation. A later config change must not alter
    /// the economics of a room players have already entered.
    pub fee_bps: u16,
    pub created_at: i64,
    pub unlocked_at: i64,
    pub settled_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RoomStatus {
    /// Accepting joins and entry-fee locks.
    Open,
    /// Joins closed, match running.
    InProgress,
    /// Results are in; the prize pool is committed and payable.
    Unlocked,
    /// Fully distributed.
    Settled,
    /// Abandoned; players may claim refunds.
    Cancelled,
}

/// One player's participation in one room, at PDA `[b"room_player", room, player]`.
///
/// Its existence is what makes joining idempotent — a second join hits the
/// account-already-initialised error rather than charging twice.
#[account]
#[derive(InitSpace)]
pub struct RoomPlayer {
    pub room: Pubkey,
    pub player: Pubkey,
    /// Lamports escrowed by this player. Zero until `lock_entry_fee`.
    pub locked_amount: u64,
    /// Lamports received from `distribute_winnings`.
    pub payout: u64,
    pub joined_at: i64,
    pub state: PlayerRoomState,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PlayerRoomState {
    /// Seat reserved, entry fee not yet escrowed.
    Joined,
    /// Entry fee escrowed in the room vault.
    Locked,
    /// Winnings credited.
    Paid,
    /// Entry fee returned after cancellation.
    Refunded,
}
