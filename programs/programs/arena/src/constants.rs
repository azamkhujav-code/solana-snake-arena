//! Seeds and tunable limits.
//!
//! Seeds are mirrored in `packages/solana/src/pda.ts`. If they drift, every
//! instruction fails with a constraint violation, so the two must be changed
//! together and are covered by tests.

/// PDA seeds.
pub const CONFIG_SEED: &[u8] = b"config";
pub const POOL_SEED: &[u8] = b"pool";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const PLAYER_SEED: &[u8] = b"player";
pub const ROOM_SEED: &[u8] = b"room";
pub const ROOM_VAULT_SEED: &[u8] = b"room_vault";
pub const ROOM_PLAYER_SEED: &[u8] = b"room_player";

/// Basis-point denominator.
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Hard ceiling on the house rake (10%).
///
/// Enforced on every fee write so a compromised admin key cannot set the rake
/// to 100% and drain a prize pool. The cap is a constant rather than config
/// precisely so changing it requires a program upgrade.
pub const MAX_FEE_BPS: u16 = 1_000;

/// Hard ceiling on the withdrawal fee (2%).
///
/// Much tighter than the room rake: a rake is taken once from a pot the player
/// chose to enter, whereas a withdrawal fee is charged on the player's own
/// money on the way out. A high one is indistinguishable from an exit tax.
pub const MAX_WITHDRAWAL_FEE_BPS: u16 = 200;

/// Room identifiers are fixed-width so they can be used directly as PDA seeds.
pub const ROOM_ID_LEN: usize = 16;

/// Upper bound on room capacity.
///
/// `u16::MAX` rather than a chosen number, because rooms have no seat limit and
/// this is the only ceiling that is real: `Room::player_count` is a `u16`, so
/// 65,535 is where the type runs out.
///
/// It used to be 128, and a comment elsewhere claimed the escrow account could
/// not hold more participants than that. It could: `Room` stores only
/// fixed-size scalars, and each participant is a separate `room_player` PDA, so
/// the account is exactly the same size whether two play or two thousand.
pub const MAX_PLAYERS_PER_ROOM: u16 = u16::MAX;

/// A match needs an opponent. Below two there is nobody to outlive.
pub const MIN_PLAYERS_PER_ROOM: u16 = 2;

/// Winners paid in a single `distribute_winnings` call.
///
/// Bounded by the transaction account limit: each winner costs two accounts
/// (their room-player record and their custody account). Eight keeps the
/// instruction comfortably inside one transaction.
pub const MAX_WINNERS_PER_DISTRIBUTION: usize = 8;

/// Dust guards. Below these, rent and fees exceed the amount being moved.
pub const MIN_DEPOSIT_LAMPORTS: u64 = 10_000;
pub const MIN_WITHDRAWAL_LAMPORTS: u64 = 10_000;
pub const MIN_ENTRY_FEE_LAMPORTS: u64 = 1_000;

/// How long after creation a stuck room may be cancelled by anyone.
///
/// This is the players' escape hatch: without a permissionless path, funds
/// would be recoverable only if the backend chose to act.
pub const PERMISSIONLESS_CANCEL_DELAY_SECONDS: i64 = 3_600;
