import {
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
  type PublicKey,
} from '@solana/web3.js';

import {
  BPS_DENOMINATOR,
  MAX_WINNERS_PER_DISTRIBUTION,
  MAX_WITHDRAWAL_FEE_BPS,
  ROOM_ID_LEN,
} from './constants.js';
import { SolanaServiceError } from './errors.js';
import {
  findConfigPda,
  findPlayerPda,
  findPoolPda,
  findRoomPda,
  findRoomPlayerPda,
  findRoomVaultPda,
  findTreasuryPda,
  normalizeRoomId,
} from './pda.js';
import {
  encodeFixedBytes,
  encodeInstruction,
  encodeU16,
  encodeU64,
  encodeVec,
} from './tx/encode.js';

/**
 * Instruction builders for the arena program.
 *
 * Hand-encoded rather than generated, so the backend has no runtime dependency
 * on `anchor build` artifacts. Account **order** here must match the
 * `#[derive(Accounts)]` struct field order in the program exactly — Anchor
 * matches positionally, not by name.
 */

const readonly = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: false,
});
const writable = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: true,
});
const signer = (pubkey: PublicKey, isWritable = false): AccountMeta => ({
  pubkey,
  isSigner: true,
  isWritable,
});

export interface ArenaAddresses {
  programId: PublicKey;
}

/** Funds a player's custody balance. Signed by the player. */
export function createDepositInstruction(params: {
  programId: PublicKey;
  player: PublicKey;
  lamports: bigint;
}): TransactionInstruction {
  const { programId, player, lamports } = params;
  const [config] = findConfigPda(programId);
  const [playerAccount] = findPlayerPda(programId, player);
  const [pool] = findPoolPda(programId);

  return new TransactionInstruction({
    programId,
    keys: [
      readonly(config),
      writable(playerAccount),
      writable(pool),
      signer(player, true),
      readonly(SystemProgram.programId),
    ],
    data: encodeInstruction('deposit', encodeU64(lamports)),
  });
}

/**
 * Returns lamports from custody to the player's wallet. Signed by the player.
 *
 * `lamports` is the GROSS debit. The player receives `lamports - fee` and the
 * treasury receives `fee`, where the rate is `config.withdrawal_fee_bps`. Use
 * {@link splitWithdrawal} to show the player what they will actually receive
 * before they sign.
 */
export function createWithdrawInstruction(params: {
  programId: PublicKey;
  player: PublicKey;
  lamports: bigint;
}): TransactionInstruction {
  const { programId, player, lamports } = params;
  const [config] = findConfigPda(programId);
  const [playerAccount] = findPlayerPda(programId, player);
  const [pool] = findPoolPda(programId);
  const [treasury] = findTreasuryPda(programId);

  return new TransactionInstruction({
    programId,
    keys: [
      readonly(config),
      writable(playerAccount),
      writable(pool),
      writable(treasury),
      signer(player, true),
      readonly(SystemProgram.programId),
    ],
    data: encodeInstruction('withdraw', encodeU64(lamports)),
  });
}

/**
 * Splits a gross withdrawal into the net payout and the treasury fee.
 *
 * Mirrors the program's `apply_bps`: multiply first, then divide, so the result
 * matches on-chain exactly. Computing the fee as `gross * (bps/10000)` in
 * floating point drifts by a lamport and makes the UI disagree with the chain.
 */
export function splitWithdrawal(
  grossLamports: bigint,
  withdrawalFeeBps: number,
): { gross: bigint; fee: bigint; net: bigint } {
  if (grossLamports < 0n) throw new SolanaServiceError('Withdrawal amount must be positive');
  if (withdrawalFeeBps < 0 || withdrawalFeeBps > MAX_WITHDRAWAL_FEE_BPS) {
    throw new SolanaServiceError(
      `Withdrawal fee must be between 0 and ${MAX_WITHDRAWAL_FEE_BPS} bps`,
    );
  }

  const fee = (grossLamports * BigInt(withdrawalFeeBps)) / BPS_DENOMINATOR;
  return { gross: grossLamports, fee, net: grossLamports - fee };
}

/**
 * One-time program setup. Creates the config PDA and funds the pool and
 * treasury vaults — this is the "pool PDA creation" step.
 */
export function createInitializeInstruction(params: {
  programId: PublicKey;
  admin: PublicKey;
  settlementAuthority: PublicKey;
  /**
   * Wallet that receives the platform fee.
   *
   * Sent as its own argument because the program stores it on `Config` and
   * transfers the rake straight there at settlement, rather than parking it in
   * a treasury PDA someone later has to sweep.
   *
   * This was missing from the encoded data while the program had already been
   * changed to take it, so `initialize` failed with `InstructionDidNotDeserialize`
   * — 36 bytes of arguments against the 68 the program expected. Nothing caught
   * it because the program had never been deployed: every test either mocked
   * the service or exercised the Rust directly, and the two sides can only
   * disagree at a real runtime boundary.
   */
  feeDestination: PublicKey;
  feeBps: number;
  withdrawalFeeBps: number;
}): TransactionInstruction {
  const { programId, admin, settlementAuthority, feeDestination, feeBps, withdrawalFeeBps } =
    params;
  const [config] = findConfigPda(programId);
  const [pool] = findPoolPda(programId);
  const [treasury] = findTreasuryPda(programId);

  return new TransactionInstruction({
    programId,
    keys: [
      writable(config),
      writable(pool),
      writable(treasury),
      signer(admin, true),
      readonly(SystemProgram.programId),
    ],
    // Argument order must match the Rust signature exactly: Anchor deserialises
    // positionally and a swap of two same-width fields would be silent.
    data: encodeInstruction(
      'initialize',
      Buffer.from(settlementAuthority.toBytes()),
      Buffer.from(feeDestination.toBytes()),
      encodeU16(feeBps),
      encodeU16(withdrawalFeeBps),
    ),
  });
}

/** Opens a wagered room and its escrow vault. Signed by the settlement authority. */
export function createRoomInstruction(params: {
  programId: PublicKey;
  settlementAuthority: PublicKey;
  roomId: Uint8Array;
  entryFeeLamports: bigint;
  maxPlayers: number;
}): TransactionInstruction {
  const { programId, settlementAuthority, entryFeeLamports, maxPlayers } = params;
  const roomId = normalizeRoomId(params.roomId);
  const [config] = findConfigPda(programId);
  const [room] = findRoomPda(programId, roomId);
  const [roomVault] = findRoomVaultPda(programId, roomId);

  return new TransactionInstruction({
    programId,
    keys: [
      writable(config),
      writable(room),
      writable(roomVault),
      signer(settlementAuthority, true),
      readonly(SystemProgram.programId),
    ],
    data: encodeInstruction(
      'create_room',
      encodeFixedBytes(roomId, ROOM_ID_LEN),
      encodeU64(entryFeeLamports),
      encodeU16(maxPlayers),
    ),
  });
}

/** Reserves a seat. Signed by the player. */
export function createJoinRoomInstruction(params: {
  programId: PublicKey;
  player: PublicKey;
  roomId: Uint8Array;
}): TransactionInstruction {
  const { programId, player } = params;
  const roomId = normalizeRoomId(params.roomId);
  const [config] = findConfigPda(programId);
  const [room] = findRoomPda(programId, roomId);
  const [roomPlayer] = findRoomPlayerPda(programId, room, player);
  const [playerAccount] = findPlayerPda(programId, player);

  return new TransactionInstruction({
    programId,
    keys: [
      readonly(config),
      writable(room),
      writable(roomPlayer),
      writable(playerAccount),
      signer(player, true),
      readonly(SystemProgram.programId),
    ],
    data: encodeInstruction('join_room'),
  });
}

/** Escrows the entry fee from custody into the room vault. Signed by the player. */
export function createLockEntryFeeInstruction(params: {
  programId: PublicKey;
  player: PublicKey;
  roomId: Uint8Array;
}): TransactionInstruction {
  const { programId, player } = params;
  const roomId = normalizeRoomId(params.roomId);
  const [config] = findConfigPda(programId);
  const [room] = findRoomPda(programId, roomId);
  const [roomPlayer] = findRoomPlayerPda(programId, room, player);
  const [playerAccount] = findPlayerPda(programId, player);
  const [pool] = findPoolPda(programId);
  const [roomVault] = findRoomVaultPda(programId, roomId);

  return new TransactionInstruction({
    programId,
    keys: [
      readonly(config),
      writable(room),
      writable(roomPlayer),
      writable(playerAccount),
      writable(pool),
      writable(roomVault),
      signer(player),
      readonly(SystemProgram.programId),
    ],
    data: encodeInstruction('lock_entry_fee'),
  });
}

/** Closes joining. Signed by the settlement authority. */
export function createStartRoomInstruction(params: {
  programId: PublicKey;
  settlementAuthority: PublicKey;
  roomId: Uint8Array;
}): TransactionInstruction {
  const { programId, settlementAuthority } = params;
  const roomId = normalizeRoomId(params.roomId);
  const [config] = findConfigPda(programId);
  const [room] = findRoomPda(programId, roomId);

  return new TransactionInstruction({
    programId,
    keys: [readonly(config), writable(room), signer(settlementAuthority)],
    data: encodeInstruction('start_room'),
  });
}

/** Commits the prize/rake split. Signed by the settlement authority. */
export function createUnlockPrizeInstruction(params: {
  programId: PublicKey;
  settlementAuthority: PublicKey;
  roomId: Uint8Array;
}): TransactionInstruction {
  const { programId, settlementAuthority } = params;
  const roomId = normalizeRoomId(params.roomId);
  const [config] = findConfigPda(programId);
  const [room] = findRoomPda(programId, roomId);

  return new TransactionInstruction({
    programId,
    keys: [readonly(config), writable(room), signer(settlementAuthority)],
    data: encodeInstruction('unlock_prize'),
  });
}

export interface WinnerPayout {
  player: PublicKey;
  lamports: bigint;
}

/**
 * Pays every winner and sweeps the rake.
 *
 * Winner accounts ride in `remaining_accounts` as `[RoomPlayer, PlayerAccount]`
 * pairs, in the same order as `payouts`. The program re-derives and checks both
 * PDAs, so a mismatched pair is rejected rather than silently crediting the
 * wrong account — but the order still has to be right for the call to succeed.
 */
export function createDistributeWinningsInstruction(params: {
  programId: PublicKey;
  settlementAuthority: PublicKey;
  roomId: Uint8Array;
  winners: readonly WinnerPayout[];
}): TransactionInstruction {
  const { programId, settlementAuthority, winners } = params;

  if (winners.length === 0) {
    throw new SolanaServiceError('At least one winner is required');
  }
  if (winners.length > MAX_WINNERS_PER_DISTRIBUTION) {
    throw new SolanaServiceError(
      `At most ${MAX_WINNERS_PER_DISTRIBUTION} winners per distribution, got ${winners.length}`,
    );
  }

  const seen = new Set<string>();
  for (const winner of winners) {
    const key = winner.player.toBase58();
    if (seen.has(key)) {
      throw new SolanaServiceError(`Duplicate winner in payout list: ${key}`);
    }
    seen.add(key);
    if (winner.lamports <= 0n) {
      throw new SolanaServiceError(`Payout for ${key} must be greater than zero`);
    }
  }

  const roomId = normalizeRoomId(params.roomId);
  const [config] = findConfigPda(programId);
  const [room] = findRoomPda(programId, roomId);
  const [roomVault] = findRoomVaultPda(programId, roomId);
  const [pool] = findPoolPda(programId);
  const [treasury] = findTreasuryPda(programId);

  const remaining: AccountMeta[] = winners.flatMap((winner) => {
    const [roomPlayer] = findRoomPlayerPda(programId, room, winner.player);
    const [playerAccount] = findPlayerPda(programId, winner.player);
    return [writable(roomPlayer), writable(playerAccount)];
  });

  return new TransactionInstruction({
    programId,
    keys: [
      readonly(config),
      writable(room),
      writable(roomVault),
      writable(pool),
      writable(treasury),
      signer(settlementAuthority),
      readonly(SystemProgram.programId),
      ...remaining,
    ],
    data: encodeInstruction(
      'distribute_winnings',
      encodeVec(
        winners.map((w) => w.lamports),
        encodeU64,
      ),
    ),
  });
}

/** Aborts a room. Permissionless after the on-chain cancel delay. */
export function createCancelRoomInstruction(params: {
  programId: PublicKey;
  signer: PublicKey;
  roomId: Uint8Array;
}): TransactionInstruction {
  const { programId } = params;
  const roomId = normalizeRoomId(params.roomId);
  const [config] = findConfigPda(programId);
  const [room] = findRoomPda(programId, roomId);

  return new TransactionInstruction({
    programId,
    keys: [readonly(config), writable(room), signer(params.signer)],
    data: encodeInstruction('cancel_room'),
  });
}

/** Returns one player's escrowed entry fee. Crankable by anyone. */
export function createClaimRefundInstruction(params: {
  programId: PublicKey;
  player: PublicKey;
  claimant: PublicKey;
  roomId: Uint8Array;
}): TransactionInstruction {
  const { programId, player, claimant } = params;
  const roomId = normalizeRoomId(params.roomId);
  const [config] = findConfigPda(programId);
  const [room] = findRoomPda(programId, roomId);
  const [roomPlayer] = findRoomPlayerPda(programId, room, player);
  const [playerAccount] = findPlayerPda(programId, player);
  const [roomVault] = findRoomVaultPda(programId, roomId);
  const [pool] = findPoolPda(programId);

  return new TransactionInstruction({
    programId,
    keys: [
      readonly(config),
      writable(room),
      writable(roomPlayer),
      writable(playerAccount),
      writable(roomVault),
      writable(pool),
      readonly(player),
      signer(claimant, true),
      readonly(SystemProgram.programId),
    ],
    data: encodeInstruction('claim_refund'),
  });
}

/** Moves accumulated rake out of the treasury. Signed by the admin. */
export function createWithdrawTreasuryInstruction(params: {
  programId: PublicKey;
  admin: PublicKey;
  destination: PublicKey;
  lamports: bigint;
}): TransactionInstruction {
  const { programId, admin, destination, lamports } = params;
  const [config] = findConfigPda(programId);
  const [treasury] = findTreasuryPda(programId);

  return new TransactionInstruction({
    programId,
    keys: [
      readonly(config),
      writable(treasury),
      writable(destination),
      signer(admin),
      readonly(SystemProgram.programId),
    ],
    data: encodeInstruction('withdraw_treasury', encodeU64(lamports)),
  });
}

/**
 * Takes a seat and escrows the entry fee in one player-signed transaction.
 *
 * The direct-entry path: lamports move from the player's own wallet straight
 * into this match's vault, with no custody balance in between. Contrast
 * `createJoinRoomInstruction` + `createLockEntryFeeInstruction`, which together
 * do the same job for the custodial model in two steps via the shared pool.
 *
 * The amount is not a parameter. The program reads it from the room, so a
 * client cannot enter a five-SOL room for one lamport.
 */
export function createEnterRoomInstruction(params: {
  programId: PublicKey;
  player: PublicKey;
  roomId: Uint8Array;
}): TransactionInstruction {
  const { programId, player } = params;
  const roomId = normalizeRoomId(params.roomId);
  const [config] = findConfigPda(programId);
  const [room] = findRoomPda(programId, roomId);
  const [roomPlayer] = findRoomPlayerPda(programId, room, player);
  const [roomVault] = findRoomVaultPda(programId, roomId);

  return new TransactionInstruction({
    programId,
    keys: [
      readonly(config),
      writable(room),
      writable(roomPlayer),
      writable(roomVault),
      signer(player),
      readonly(SystemProgram.programId),
    ],
    data: encodeInstruction('enter_room'),
  });
}

/**
 * Pays the last surviving player directly to their wallet, and sweeps the rake.
 *
 * Signed by the settlement authority. `unlock_prize` must have run first — it
 * fixes the prize/rake split, so the amounts cannot move between a failed
 * attempt and a retry.
 */
export function createSettleToWinnerInstruction(params: {
  programId: PublicKey;
  settlementAuthority: PublicKey;
  feeDestination: PublicKey;
  winner: PublicKey;
  roomId: Uint8Array;
}): TransactionInstruction {
  const { programId, settlementAuthority, feeDestination, winner } = params;
  const roomId = normalizeRoomId(params.roomId);
  const [config] = findConfigPda(programId);
  const [room] = findRoomPda(programId, roomId);
  const [roomVault] = findRoomVaultPda(programId, roomId);
  const [winnerRoomPlayer] = findRoomPlayerPda(programId, room, winner);

  return new TransactionInstruction({
    programId,
    keys: [
      readonly(config),
      writable(room),
      writable(roomVault),
      writable(winnerRoomPlayer),
      writable(winner),
      writable(feeDestination),
      signer(settlementAuthority),
      readonly(SystemProgram.programId),
    ],
    data: encodeInstruction('settle_to_winner'),
  });
}
