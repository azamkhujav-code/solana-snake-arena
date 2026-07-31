import { describe, expect, it } from 'vitest';

import { consumeReservations, StakeMismatchError } from './stake.js';
import type { PrismaClient } from './client.js';

/**
 * A staked total that disagrees with the field must move nothing.
 *
 * The order of these two operations is the entire point. `close-lobby` used to
 * consume the reservations and *then* compare the total against the queued
 * players, aborting the cycle on a mismatch — but the consume had already
 * committed, so the abort left every stake sitting in the escrow of a match
 * that would never run. No refund path, no way for a player to recover it, and
 * the cycle logged "aborting" as though nothing had happened.
 *
 * Asserted with a recording fake rather than a database because the property is
 * about *ordering*: that the guard runs before the first write, not that the
 * arithmetic is right. A fake makes "no write was issued" directly observable,
 * where against a real database it could only be inferred from final balances —
 * which would also pass if the writes happened and were rolled back, and
 * rolling back correctly is Postgres's job, not this function's.
 */

interface Recorded {
  updates: string[];
  transactions: number;
}

function fakePrisma(reservations: Array<{ userId: string; lamports: bigint }>): {
  prisma: PrismaClient;
  recorded: Recorded;
} {
  const recorded: Recorded = { updates: [], transactions: 0 };

  const tx = {
    stakeReservation: {
      findMany: async () =>
        reservations.map((row, index) => ({
          id: `res-${index}`,
          userId: row.userId,
          tierId: 'gold',
          lamports: row.lamports,
          createdAt: new Date(),
        })),
      deleteMany: async () => {
        recorded.updates.push('stakeReservation.deleteMany');
        return { count: 0 };
      },
    },
    poolAccount: {
      findUniqueOrThrow: async () => ({
        id: 'escrow-1',
        balanceLamports: 0n,
        reservedLamports: 0n,
        version: 1,
      }),
      findFirst: async () => ({
        id: 'custody-1',
        balanceLamports: 10_000_000_000n,
        reservedLamports: 0n,
        version: 1,
      }),
      update: async () => {
        recorded.updates.push('poolAccount.update');
        return {};
      },
    },
    transaction: {
      createMany: async () => {
        recorded.updates.push('transaction.createMany');
        return { count: 0 };
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => {
      recorded.transactions += 1;
      return fn(tx);
    },
  } as unknown as PrismaClient;

  return { prisma, recorded };
}

const FEE = 100_000_000n; // 0.1 SOL, the gold room

describe('consumeReservations expectation guard', () => {
  it('refuses a total that does not match the field, before touching a balance', async () => {
    // Three reservations but only two players queued — an orphan left by an
    // earlier failure, which is exactly how this arose in practice.
    const { prisma, recorded } = fakePrisma([
      { userId: 'a', lamports: FEE },
      { userId: 'b', lamports: FEE },
      { userId: 'orphan', lamports: FEE },
    ]);

    await expect(
      consumeReservations(prisma, {
        tierId: 'gold',
        gameId: 'game-1',
        escrowAccountId: 'escrow-1',
        expectedLamports: FEE * 2n,
      }),
    ).rejects.toBeInstanceOf(StakeMismatchError);

    // The assertion that matters. Anything here means money moved for a match
    // that was then refused.
    expect(recorded.updates).toEqual([]);
  });

  it('reports both figures, so the mismatch is diagnosable', async () => {
    const { prisma } = fakePrisma([
      { userId: 'a', lamports: FEE },
      { userId: 'orphan', lamports: FEE },
    ]);

    let error: unknown;
    try {
      await consumeReservations(prisma, {
        tierId: 'gold',
        gameId: 'game-1',
        escrowAccountId: 'escrow-1',
        expectedLamports: FEE,
      });
    } catch (cause) {
      error = cause;
    }

    // Narrowed by the assertion, so the field reads below are type-safe rather
    // than cast — a cast would also have accepted the success result.
    expect(error).toBeInstanceOf(StakeMismatchError);
    if (!(error instanceof StakeMismatchError)) throw new Error('unreachable');

    expect(error.staked).toBe(FEE * 2n);
    expect(error.expected).toBe(FEE);
    expect(error.tierId).toBe('gold');
  });

  it('proceeds when the total matches', async () => {
    const { prisma, recorded } = fakePrisma([
      { userId: 'a', lamports: FEE },
      { userId: 'b', lamports: FEE },
    ]);

    const result = await consumeReservations(prisma, {
      tierId: 'gold',
      gameId: 'game-1',
      escrowAccountId: 'escrow-1',
      expectedLamports: FEE * 2n,
    });

    expect(result.totalLamports).toBe(FEE * 2n);
    expect(recorded.updates).toContain('poolAccount.update');
  });

  it('still works when no expectation is given', async () => {
    // The parameter is optional, so existing callers are unaffected.
    const { prisma } = fakePrisma([{ userId: 'a', lamports: FEE }]);

    const result = await consumeReservations(prisma, {
      tierId: 'gold',
      gameId: 'game-1',
      escrowAccountId: 'escrow-1',
    });

    expect(result.totalLamports).toBe(FEE);
  });
});
