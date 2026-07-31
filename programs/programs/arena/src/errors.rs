use anchor_lang::prelude::*;

#[error_code]
pub enum ArenaError {
    // ---- Authority / lifecycle -------------------------------------------
    #[msg("Program is paused")]
    ProgramPaused,
    #[msg("Caller is not the admin authority")]
    UnauthorizedAdmin,
    #[msg("Caller is not the settlement authority")]
    UnauthorizedSettlement,
    #[msg("No pending admin transfer to accept")]
    NoPendingAdmin,
    #[msg("Caller is not the pending admin")]
    NotPendingAdmin,

    // ---- Config -----------------------------------------------------------
    #[msg("Fee exceeds the maximum allowed basis points")]
    FeeTooHigh,
    #[msg("Treasury account does not match the configured treasury")]
    TreasuryMismatch,

    // ---- Custody ----------------------------------------------------------
    #[msg("Deposit is below the minimum allowed amount")]
    DepositTooSmall,
    #[msg("Withdrawal is below the minimum allowed amount")]
    WithdrawalTooSmall,
    #[msg("Insufficient custody balance")]
    InsufficientBalance,
    #[msg("Vault has insufficient lamports")]
    InsufficientVaultFunds,
    #[msg("Transfer would leave the account below rent exemption")]
    WouldBreakRentExemption,
    #[msg("Player account owner does not match the signer")]
    PlayerOwnerMismatch,

    // ---- Rooms ------------------------------------------------------------
    #[msg("Room is not accepting new players")]
    RoomNotOpen,
    #[msg("Room is not in progress")]
    RoomNotInProgress,
    #[msg("Room prize has not been unlocked")]
    PrizeNotUnlocked,
    #[msg("Room has already been settled")]
    RoomAlreadySettled,
    #[msg("Room has been cancelled")]
    RoomCancelled,
    #[msg("Room is not cancelled")]
    RoomNotCancelled,
    #[msg("Room is full")]
    RoomFull,
    #[msg("Room capacity is outside the allowed range")]
    InvalidRoomCapacity,
    #[msg("Entry fee is below the minimum allowed amount")]
    EntryFeeTooSmall,
    #[msg("Room still has players who have not locked their entry fee")]
    EntryFeesNotLocked,
    #[msg("Cancel delay has not elapsed")]
    CancelDelayNotElapsed,

    // ---- Participation ----------------------------------------------------
    #[msg("Player has already locked their entry fee")]
    EntryFeeAlreadyLocked,
    #[msg("Player has not locked an entry fee")]
    EntryFeeNotLocked,
    #[msg("Player has already been paid")]
    AlreadyPaid,
    #[msg("Player has already been refunded")]
    AlreadyRefunded,
    #[msg("Room player record does not belong to this room")]
    RoomPlayerMismatch,
    #[msg("Room player record does not belong to this player")]
    RoomPlayerOwnerMismatch,

    // ---- Distribution -----------------------------------------------------
    #[msg("No winners supplied")]
    NoWinners,
    #[msg("Too many winners for a single distribution")]
    TooManyWinners,
    #[msg("Winner account list does not match the payout list")]
    WinnerAccountMismatch,
    #[msg("Payouts do not sum to the unlocked prize pool")]
    PayoutMismatch,
    #[msg("Payout amount must be greater than zero")]
    ZeroPayout,
    #[msg("Duplicate winner in payout list")]
    DuplicateWinner,

    // ---- Arithmetic -------------------------------------------------------
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Arithmetic underflow")]
    Underflow,
}
