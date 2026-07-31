import { PublicKey } from '@solana/web3.js';

import {
  CONFIG_SEED,
  PLAYER_SEED,
  POOL_SEED,
  ROOM_ID_LEN,
  ROOM_PLAYER_SEED,
  ROOM_SEED,
  ROOM_VAULT_SEED,
  TREASURY_SEED,
} from './constants.js';

/**
 * Program-derived address helpers.
 *
 * Seeds mirror `#[account(seeds = ...)]` in the Rust program. Every derivation
 * returns the bump too, because instructions that sign as a PDA need it.
 */

export type Pda = readonly [PublicKey, number];

/** Global config. */
export function findConfigPda(programId: PublicKey): Pda {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

/** Shared custody vault holding every player's balance. */
export function findPoolPda(programId: PublicKey): Pda {
  return PublicKey.findProgramAddressSync([POOL_SEED], programId);
}

/** Rake vault. */
export function findTreasuryPda(programId: PublicKey): Pda {
  return PublicKey.findProgramAddressSync([TREASURY_SEED], programId);
}

/** A player's custody record. */
export function findPlayerPda(programId: PublicKey, owner: PublicKey): Pda {
  return PublicKey.findProgramAddressSync([PLAYER_SEED, owner.toBuffer()], programId);
}

/** A wagered room. */
export function findRoomPda(programId: PublicKey, roomId: Uint8Array): Pda {
  return PublicKey.findProgramAddressSync([ROOM_SEED, normalizeRoomId(roomId)], programId);
}

/** Escrow vault for one room. */
export function findRoomVaultPda(programId: PublicKey, roomId: Uint8Array): Pda {
  return PublicKey.findProgramAddressSync([ROOM_VAULT_SEED, normalizeRoomId(roomId)], programId);
}

/** One player's participation record in one room. */
export function findRoomPlayerPda(programId: PublicKey, room: PublicKey, player: PublicKey): Pda {
  return PublicKey.findProgramAddressSync(
    [ROOM_PLAYER_SEED, room.toBuffer(), player.toBuffer()],
    programId,
  );
}

/**
 * Room ids are a fixed 16 bytes on-chain.
 *
 * Passing a shorter buffer would derive a different address than the program
 * computes from its padded `[u8; 16]`, so the length is normalised here rather
 * than left to each call site.
 */
export function normalizeRoomId(roomId: Uint8Array): Buffer {
  if (roomId.length > ROOM_ID_LEN) {
    throw new RangeError(`Room id must be at most ${ROOM_ID_LEN} bytes, got ${roomId.length}`);
  }
  const padded = Buffer.alloc(ROOM_ID_LEN);
  padded.set(roomId);
  return padded;
}

/** Builds a padded room id from a UTF-8 string (e.g. a database UUID prefix). */
export function roomIdFromString(value: string): Buffer {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > ROOM_ID_LEN) {
    throw new RangeError(`Room id "${value}" exceeds ${ROOM_ID_LEN} bytes when UTF-8 encoded`);
  }
  return normalizeRoomId(encoded);
}

/** Room ids from a UUID, using its 16 raw bytes — a natural exact fit. */
export function roomIdFromUuid(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new RangeError(`Invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}
