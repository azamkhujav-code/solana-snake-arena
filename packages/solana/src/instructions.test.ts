import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { MAX_WINNERS_PER_DISTRIBUTION, ROOM_ID_LEN } from './constants.js';
import { SolanaServiceError } from './errors.js';
import {
  createCloseRoomInstruction,
  createCloseRoomPlayerInstruction,
  createDepositInstruction,
  createDistributeWinningsInstruction,
  createJoinRoomInstruction,
  createLockEntryFeeInstruction,
  createWithdrawInstruction,
} from './instructions.js';
import {
  findConfigPda,
  findPlayerPda,
  findPoolPda,
  findRoomPda,
  findRoomPlayerPda,
  findRoomVaultPda,
  normalizeRoomId,
  roomIdFromString,
  roomIdFromUuid,
} from './pda.js';
import { instructionDiscriminator } from './tx/encode.js';

const programId = new PublicKey('Arena111111111111111111111111111111111111111');
const player = Keypair.generate().publicKey;
const roomId = roomIdFromString('room-1');

describe('PDA derivation', () => {
  it('is deterministic', () => {
    expect(findPoolPda(programId)[0].toBase58()).toBe(findPoolPda(programId)[0].toBase58());
  });

  it('produces distinct addresses per namespace', () => {
    const addresses = new Set([
      findConfigPda(programId)[0].toBase58(),
      findPoolPda(programId)[0].toBase58(),
      findPlayerPda(programId, player)[0].toBase58(),
      findRoomPda(programId, roomId)[0].toBase58(),
    ]);
    expect(addresses.size).toBe(4);
  });

  it('derives a different player PDA per owner', () => {
    const other = Keypair.generate().publicKey;
    expect(findPlayerPda(programId, player)[0].toBase58()).not.toBe(
      findPlayerPda(programId, other)[0].toBase58(),
    );
  });

  it('returns a canonical bump in range', () => {
    const [, bump] = findPoolPda(programId);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });
});

describe('room id normalisation', () => {
  it('pads to exactly the on-chain width', () => {
    // A short buffer would derive a different PDA than the program's [u8; 16].
    expect(normalizeRoomId(Buffer.from('abc'))).toHaveLength(ROOM_ID_LEN);
    expect(roomIdFromString('room-1')).toHaveLength(ROOM_ID_LEN);
  });

  it('makes padded and unpadded ids derive the same address', () => {
    const short = Buffer.from('room-1', 'utf8');
    expect(findRoomPda(programId, short)[0].toBase58()).toBe(
      findRoomPda(programId, roomIdFromString('room-1'))[0].toBase58(),
    );
  });

  it('rejects an over-long id instead of silently truncating', () => {
    expect(() => normalizeRoomId(Buffer.alloc(17))).toThrow(RangeError);
    expect(() => roomIdFromString('this-string-is-far-too-long')).toThrow(RangeError);
  });

  it('uses a UUID raw 16 bytes exactly', () => {
    const id = roomIdFromUuid('123e4567-e89b-12d3-a456-426614174000');
    expect(id).toHaveLength(16);
    expect(id.toString('hex')).toBe('123e4567e89b12d3a456426614174000');
    expect(() => roomIdFromUuid('nope')).toThrow(RangeError);
  });
});

describe('createDepositInstruction', () => {
  const ix = createDepositInstruction({ programId, player, lamports: 1_000_000n });

  it('targets the arena program', () => {
    expect(ix.programId.toBase58()).toBe(programId.toBase58());
  });

  it('encodes the discriminator and amount', () => {
    expect(ix.data.subarray(0, 8)).toEqual(instructionDiscriminator('deposit'));
    expect(ix.data.readBigUInt64LE(8)).toBe(1_000_000n);
  });

  it('orders accounts to match the Rust struct', () => {
    // Anchor matches accounts positionally, so order is part of the contract.
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      findConfigPda(programId)[0].toBase58(),
      findPlayerPda(programId, player)[0].toBase58(),
      findPoolPda(programId)[0].toBase58(),
      player.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
  });

  it('marks the payer as the only signer, and the mutated accounts writable', () => {
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([
      player.toBase58(),
    ]);
    expect(ix.keys[0]?.isWritable).toBe(false); // config is read-only
    expect(ix.keys[1]?.isWritable).toBe(true); // player account
    expect(ix.keys[2]?.isWritable).toBe(true); // pool vault
  });
});

describe('createWithdrawInstruction', () => {
  it('uses a different discriminator to deposit', () => {
    const withdraw = createWithdrawInstruction({ programId, player, lamports: 1n });
    const deposit = createDepositInstruction({ programId, player, lamports: 1n });
    expect(withdraw.data.subarray(0, 8)).not.toEqual(deposit.data.subarray(0, 8));
  });
});

describe('createJoinRoomInstruction / createLockEntryFeeInstruction', () => {
  it('derives the room-player PDA from the room address, not the room id', () => {
    const ix = createJoinRoomInstruction({ programId, player, roomId });
    const [room] = findRoomPda(programId, roomId);
    const [roomPlayer] = findRoomPlayerPda(programId, room, player);

    expect(ix.keys[2]?.pubkey.toBase58()).toBe(roomPlayer.toBase58());
  });

  it('carries no arguments beyond the discriminator', () => {
    expect(createJoinRoomInstruction({ programId, player, roomId }).data).toHaveLength(8);
    expect(createLockEntryFeeInstruction({ programId, player, roomId }).data).toHaveLength(8);
  });
});

describe('createDistributeWinningsInstruction', () => {
  const settlementAuthority = Keypair.generate().publicKey;
  const winners = [
    { player: Keypair.generate().publicKey, lamports: 700_000n },
    { player: Keypair.generate().publicKey, lamports: 300_000n },
  ];

  it('appends two remaining accounts per winner', () => {
    const ix = createDistributeWinningsInstruction({
      programId,
      settlementAuthority,
      roomId,
      winners,
    });

    // 7 fixed accounts + 2 per winner.
    expect(ix.keys).toHaveLength(7 + winners.length * 2);

    const [room] = findRoomPda(programId, roomId);
    const first = winners[0]!;
    expect(ix.keys[7]?.pubkey.toBase58()).toBe(
      findRoomPlayerPda(programId, room, first.player)[0].toBase58(),
    );
    expect(ix.keys[8]?.pubkey.toBase58()).toBe(
      findPlayerPda(programId, first.player)[0].toBase58(),
    );
  });

  it('marks every winner account writable', () => {
    const ix = createDistributeWinningsInstruction({
      programId,
      settlementAuthority,
      roomId,
      winners,
    });
    expect(ix.keys.slice(7).every((k) => k.isWritable)).toBe(true);
    expect(ix.keys.slice(7).every((k) => !k.isSigner)).toBe(true);
  });

  it('encodes payouts as a Vec<u64> in winner order', () => {
    const ix = createDistributeWinningsInstruction({
      programId,
      settlementAuthority,
      roomId,
      winners,
    });

    expect(ix.data.subarray(0, 8)).toEqual(instructionDiscriminator('distribute_winnings'));
    expect(ix.data.readUInt32LE(8)).toBe(2);
    expect(ix.data.readBigUInt64LE(12)).toBe(700_000n);
    expect(ix.data.readBigUInt64LE(20)).toBe(300_000n);
  });

  it('rejects a duplicate winner client-side', () => {
    const duplicate = winners[0]!;
    expect(() =>
      createDistributeWinningsInstruction({
        programId,
        settlementAuthority,
        roomId,
        winners: [duplicate, duplicate],
      }),
    ).toThrow(SolanaServiceError);
  });

  it('rejects an empty or oversized winner list', () => {
    expect(() =>
      createDistributeWinningsInstruction({ programId, settlementAuthority, roomId, winners: [] }),
    ).toThrow(SolanaServiceError);

    const tooMany = Array.from({ length: MAX_WINNERS_PER_DISTRIBUTION + 1 }, () => ({
      player: Keypair.generate().publicKey,
      lamports: 1n,
    }));
    expect(() =>
      createDistributeWinningsInstruction({
        programId,
        settlementAuthority,
        roomId,
        winners: tooMany,
      }),
    ).toThrow(SolanaServiceError);
  });

  it('rejects a zero payout', () => {
    expect(() =>
      createDistributeWinningsInstruction({
        programId,
        settlementAuthority,
        roomId,
        winners: [{ player: Keypair.generate().publicKey, lamports: 0n }],
      }),
    ).toThrow(SolanaServiceError);
  });
});

/**
 * Rent reclamation.
 *
 * Account order is the whole risk here: Anchor matches `#[derive(Accounts)]`
 * fields positionally, so a builder that lists them in the wrong order compiles
 * on both sides and fails only against a real cluster. These pin the order and
 * the writability against the Rust structs.
 */
describe('close_room', () => {
  const settlementAuthority = Keypair.generate().publicKey;

  it('lists accounts in the order the program declares them', () => {
    const ix = createCloseRoomInstruction({ programId, settlementAuthority, roomId });

    const [config, room, vault, authority] = ix.keys;
    expect(config?.pubkey.toBase58()).toBe(findConfigPda(programId)[0].toBase58());
    expect(room?.pubkey.toBase58()).toBe(findRoomPda(programId, roomId)[0].toBase58());
    expect(vault?.pubkey.toBase58()).toBe(findRoomVaultPda(programId, roomId)[0].toBase58());
    expect(authority?.pubkey.toBase58()).toBe(settlementAuthority.toBase58());
  });

  it('marks everything it mutates as writable', () => {
    // The room is closed, the vault is drained and the authority receives both
    // deposits — a read-only marking on any of them fails at execution.
    const ix = createCloseRoomInstruction({ programId, settlementAuthority, roomId });
    const [config, ...rest] = ix.keys;

    expect(config?.isWritable).toBe(false);
    for (const key of rest) expect(key.isWritable).toBe(true);
  });

  it('needs no signature', () => {
    // The lamports go to the authority named in config regardless of who sends
    // it, so requiring a signature would only stop anyone else cranking it.
    const ix = createCloseRoomInstruction({ programId, settlementAuthority, roomId });
    expect(ix.keys.some((key) => key.isSigner)).toBe(false);
  });
});

describe('close_room_player', () => {
  it('derives the entry record from the room and the player', () => {
    const player = Keypair.generate().publicKey;
    const ix = createCloseRoomPlayerInstruction({ programId, player, roomId });

    const [room] = findRoomPda(programId, roomId);
    const [expected] = findRoomPlayerPda(programId, room, player);

    expect(ix.keys[0]?.pubkey.toBase58()).toBe(room.toBase58());
    expect(ix.keys[1]?.pubkey.toBase58()).toBe(expected.toBase58());
    expect(ix.keys[2]?.pubkey.toBase58()).toBe(player.toBase58());
  });

  it('returns the rent to the player without their signature', () => {
    // Bound by the record's own seeds, so it cannot be redirected — which is
    // what makes it safe for anyone to crank on a player's behalf.
    const player = Keypair.generate().publicKey;
    const ix = createCloseRoomPlayerInstruction({ programId, player, roomId });

    expect(ix.keys.some((key) => key.isSigner)).toBe(false);
    expect(ix.keys[2]?.isWritable).toBe(true);
  });
});
