import * as anchor from '@coral-xyz/anchor';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';

export const CONFIG_SEED = Buffer.from('config');
export const POOL_SEED = Buffer.from('pool');
export const TREASURY_SEED = Buffer.from('treasury');
export const PLAYER_SEED = Buffer.from('player');
export const ROOM_SEED = Buffer.from('room');
export const ROOM_VAULT_SEED = Buffer.from('room_vault');
export const ROOM_PLAYER_SEED = Buffer.from('room_player');

export const MAX_FEE_BPS = 1_000;
export const MIN_DEPOSIT = 10_000;
export const MIN_WITHDRAWAL = 10_000;

export function pda(seeds: Buffer[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export const configPda = (p: PublicKey) => pda([CONFIG_SEED], p);
export const poolPda = (p: PublicKey) => pda([POOL_SEED], p);
export const treasuryPda = (p: PublicKey) => pda([TREASURY_SEED], p);
export const playerPda = (p: PublicKey, owner: PublicKey) =>
  pda([PLAYER_SEED, owner.toBuffer()], p);
export const roomPda = (p: PublicKey, roomId: Buffer) => pda([ROOM_SEED, roomId], p);
export const roomVaultPda = (p: PublicKey, roomId: Buffer) => pda([ROOM_VAULT_SEED, roomId], p);
export const roomPlayerPda = (p: PublicKey, room: PublicKey, player: PublicKey) =>
  pda([ROOM_PLAYER_SEED, room.toBuffer(), player.toBuffer()], p);

/** Room ids are fixed 16-byte seeds on-chain. */
export function roomId(label: string): Buffer {
  const buf = Buffer.alloc(16);
  buf.write(label.slice(0, 16));
  return buf;
}

export async function airdrop(
  connection: anchor.web3.Connection,
  to: PublicKey,
  sol = 10,
): Promise<void> {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
}

export async function fundedKeypair(
  connection: anchor.web3.Connection,
  sol = 10,
): Promise<Keypair> {
  const kp = Keypair.generate();
  await airdrop(connection, kp.publicKey, sol);
  return kp;
}

/**
 * Asserts that a transaction fails with a specific Anchor error code.
 *
 * Checking the code rather than the message matters: messages are cosmetic and
 * change freely, but a test that only asserts "it threw" will happily pass when
 * the instruction fails for a completely unrelated reason.
 */
export async function expectAnchorError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const anchorError = error as { error?: { errorCode?: { code?: string } } };
    const actual = anchorError?.error?.errorCode?.code;

    if (actual === code || message.includes(code)) return;
    throw new Error(`Expected error "${code}" but got: ${actual ?? message}`);
  }
  throw new Error(`Expected error "${code}" but the instruction succeeded`);
}

export { SystemProgram };

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Structural type for the workspace program.
 *
 * `anchor build` generates `target/types/arena.ts`, and once it exists this
 * should be replaced with `Program<Arena>` for real instruction- and
 * account-level typing. Until then `Program<any>` cannot resolve the account
 * namespace (`program.account.room`) and blows the type instantiation depth
 * limit, so the surface actually used by the tests is declared explicitly.
 */
export interface ArenaProgram {
  programId: PublicKey;
  methods: Record<string, (...args: any[]) => any>;
  account: Record<string, { fetch(address: PublicKey): Promise<any> }>;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
