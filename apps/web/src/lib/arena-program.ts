import { createEnterRoomInstruction, findRoomPda, roomIdFromUuid } from '@arena/solana';
import { PublicKey, type Connection, type TransactionInstruction } from '@solana/web3.js';

import { env } from './env';

/**
 * Whether this match's room has actually been opened on chain.
 *
 * `enter_room` writes to the room account, so if the backend never created it
 * the transaction cannot even be simulated — and what the player sees is their
 * wallet refusing a transfer with "Failed to simulate the results of this
 * request", which reads as the game trying to do something dangerous rather
 * than as a room that is not ready.
 *
 * Checked before the wallet is asked for anything, so an unopened room is a
 * message instead of a scary dialog.
 */
export async function roomExistsOnChain(connection: Connection, gameId: string): Promise<boolean> {
  const [room] = findRoomPda(new PublicKey(env.arenaProgramId), roomIdFromUuid(gameId));
  return (await connection.getAccountInfo(room)) !== null;
}

/**
 * Builds the transaction that pays a room's entry fee.
 *
 * Built in the browser because only the player can sign it — the backend never
 * holds a player key, which is what makes "the fee leaves your wallet under
 * your own signature" true rather than a claim.
 *
 * The amount is deliberately not a parameter. The program reads the fee from
 * the room account, so a modified client cannot enter the five-SOL room for one
 * lamport: the instruction carries no amount to tamper with.
 */
export function buildEnterRoomInstruction(
  player: PublicKey,
  gameId: string,
): TransactionInstruction {
  return createEnterRoomInstruction({
    programId: new PublicKey(env.arenaProgramId),
    player,
    // The on-chain room id is derived from the game id, so the fee can only
    // land in the vault belonging to the match being played.
    roomId: roomIdFromUuid(gameId),
  });
}
