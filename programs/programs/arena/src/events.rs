//! Events are the indexer's contract.
//!
//! The off-chain settlement worker reconciles Postgres against the chain by
//! replaying these logs, so every state transition that moves value emits one.
//! Adding a field is safe; reordering or removing one breaks consumers.

use anchor_lang::prelude::*;

#[event]
pub struct ProgramInitialized {
    pub admin: Pubkey,
    pub settlement_authority: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub withdrawal_fee_bps: u16,
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub settlement_authority: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub withdrawal_fee_bps: u16,
    pub paused: bool,
}

#[event]
pub struct AdminTransferInitiated {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminTransferAccepted {
    pub previous_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct Deposited {
    pub player: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct Withdrawn {
    pub player: Pubkey,
    /// Gross amount debited from the custody balance.
    pub amount: u64,
    /// Portion routed to the treasury.
    pub fee: u64,
    /// What actually reached the player's wallet.
    pub net: u64,
    pub new_balance: u64,
}

#[event]
pub struct RoomCreated {
    pub room: Pubkey,
    pub room_id: [u8; 16],
    pub creator: Pubkey,
    pub entry_fee: u64,
    pub max_players: u16,
    pub fee_bps: u16,
}

#[event]
pub struct RoomStarted {
    pub room: Pubkey,
    pub player_count: u16,
    pub total_locked: u64,
}

#[event]
pub struct PlayerJoined {
    pub room: Pubkey,
    pub player: Pubkey,
    pub player_count: u16,
}

#[event]
pub struct EntryFeeLocked {
    pub room: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub total_locked: u64,
    pub locked_count: u16,
}

#[event]
pub struct PrizeUnlocked {
    pub room: Pubkey,
    pub total_locked: u64,
    pub prize_pool: u64,
    pub rake_amount: u64,
}

#[event]
pub struct WinnerPaid {
    pub room: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
}

#[event]
pub struct WinningsDistributed {
    pub room: Pubkey,
    pub winners_paid: u16,
    pub total_distributed: u64,
    pub rake_amount: u64,
}

#[event]
pub struct RoomCancelled {
    pub room: Pubkey,
    pub cancelled_by: Pubkey,
    pub permissionless: bool,
    pub total_locked: u64,
}

#[event]
pub struct RefundClaimed {
    pub room: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TreasuryWithdrawn {
    pub destination: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}
