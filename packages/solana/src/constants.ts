/**
 * Values mirrored from the on-chain program.
 *
 * These must match `programs/programs/arena/src/constants.rs` exactly. A drift
 * in a seed produces a PDA the program will not recognise, which surfaces as a
 * generic `ConstraintSeeds` failure with no hint about the cause — so both
 * sides are changed together and covered by tests.
 */

export const CONFIG_SEED = Buffer.from('config');
export const POOL_SEED = Buffer.from('pool');
export const TREASURY_SEED = Buffer.from('treasury');
export const PLAYER_SEED = Buffer.from('player');
export const ROOM_SEED = Buffer.from('room');
export const ROOM_VAULT_SEED = Buffer.from('room_vault');
export const ROOM_PLAYER_SEED = Buffer.from('room_player');

export const BPS_DENOMINATOR = 10_000n;
export const MAX_FEE_BPS = 1_000;
/** Withdrawal fee ceiling. Tighter than the rake — it taxes the player's own money. */
export const MAX_WITHDRAWAL_FEE_BPS = 200;

/** Room ids are fixed-width so they can be used directly as PDA seeds. */
export const ROOM_ID_LEN = 16;

export const MAX_WINNERS_PER_DISTRIBUTION = 8;

export const MIN_DEPOSIT_LAMPORTS = 10_000n;
export const MIN_WITHDRAWAL_LAMPORTS = 10_000n;
export const MIN_ENTRY_FEE_LAMPORTS = 1_000n;

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Anchor error codes start at 6000 and are assigned in declaration order.
 * Mapping them back to names turns an opaque `custom program error: 0x1771`
 * into something an operator can act on.
 */
export const ARENA_ERROR_CODES: Readonly<Record<number, string>> = Object.freeze({
  6000: 'ProgramPaused',
  6001: 'UnauthorizedAdmin',
  6002: 'UnauthorizedSettlement',
  6003: 'NoPendingAdmin',
  6004: 'NotPendingAdmin',
  6005: 'FeeTooHigh',
  6006: 'TreasuryMismatch',
  6007: 'DepositTooSmall',
  6008: 'WithdrawalTooSmall',
  6009: 'InsufficientBalance',
  6010: 'InsufficientVaultFunds',
  6011: 'WouldBreakRentExemption',
  6012: 'PlayerOwnerMismatch',
  6013: 'RoomNotOpen',
  6014: 'RoomNotInProgress',
  6015: 'PrizeNotUnlocked',
  6016: 'RoomAlreadySettled',
  6017: 'RoomCancelled',
  6018: 'RoomNotCancelled',
  6019: 'RoomFull',
  6020: 'InvalidRoomCapacity',
  6021: 'EntryFeeTooSmall',
  6022: 'EntryFeesNotLocked',
  6023: 'CancelDelayNotElapsed',
  6024: 'EntryFeeAlreadyLocked',
  6025: 'EntryFeeNotLocked',
  6026: 'AlreadyPaid',
  6027: 'AlreadyRefunded',
  6028: 'RoomPlayerMismatch',
  6029: 'RoomPlayerOwnerMismatch',
  6030: 'NoWinners',
  6031: 'TooManyWinners',
  6032: 'WinnerAccountMismatch',
  6033: 'PayoutMismatch',
  6034: 'ZeroPayout',
  6035: 'DuplicateWinner',
  6036: 'Overflow',
  6037: 'Underflow',
  6038: 'RoomNotFinished',
  6039: 'PlayerNotFinished',
});

/** Errors worth retrying — the transaction never committed. */
export const RETRYABLE_RPC_ERRORS = [
  'BlockhashNotFound',
  'Blockhash not found',
  'block height exceeded',
  'Node is behind',
  'was not confirmed',
  'Transaction simulation failed: Blockhash',
  'failed to get recent blockhash',
  'socket hang up',
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOTFOUND',
  'fetch failed',
  '429',
  'Too Many Requests',
  '502',
  '503',
  '504',
] as const;
