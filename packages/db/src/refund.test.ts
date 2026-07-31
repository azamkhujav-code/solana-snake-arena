import { describe, expect, it } from 'vitest';

import {
  cancelGameAndRefund,
  GameAlreadySettledError,
  GameNotFoundError,
  RefundShortfallError,
} from './refund.js';
import type { PrismaClient } from './client.js';

/**
 * Handing the pot back when a paid match is abandoned.
 *
 * The properties asserted here are the ones that decide whether the ledger
 * survives a cancellation, and they are all about *what is written* rather than
 * about arithmetic — so a recording fake shows them directly where a database
 * could only show the end state. In particular "the refusal paths move nothing"
 * is only observable as an absence of writes; against Postgres it would also
 * pass if the writes happened and were rolled back, and rolling back is not
 * this function's job to prove.
 *
 * The one case worth calling out is `entryPaidLamports`. It is the obvious
 * field to refund from and it is the wrong one: `GamePlayer` rows are written
 * later in the cycle than `close-lobby`, so a match that died in between has a
 * funded escrow and no participant rows. Refunding from the ledger is what
 * makes that case — the most common one in practice — pay anything at all.
 */

const FEE = 100_000_000n; // 0.1 SOL, the gold room
const GAME = 'game-1';

interface Written {
  legs: Array<{
    type: string;
    direction: string;
    amountLamports: bigint;
    balanceAfterLamports: bigint;
    poolAccountId: string;
    userId: string | null;
    idempotencyKey: string;
    entryGroupId: string;
  }>;
  balances: Array<{ id: string; balanceLamports: bigint }>;
  gameUpdates: Array<Record<string, unknown>>;
  audits: number;
}

interface FakeOptions {
  /** Posted ENTRY_FEE credits against the escrow, by payer. */
  staked?: Array<{ userId: string | null; lamports: bigint }>;
  /** Payers an earlier attempt already repaid. */
  refunded?: string[];
  escrowBalance?: bigint;
  /** Null models a free tier, which never created an escrow account. */
  escrow?: boolean;
  gameStatus?: string;
  /** A posted PAYOUT leg, i.e. the pot has already gone to a winner. */
  paidOut?: boolean;
  gameMissing?: boolean;
  custodyMissing?: boolean;
}

function fakePrisma(options: FakeOptions = {}): { prisma: PrismaClient; written: Written } {
  const {
    staked = [],
    refunded = [],
    escrowBalance = staked.reduce((sum, row) => sum + row.lamports, 0n),
    escrow = true,
    gameStatus = 'RUNNING',
    paidOut = false,
    gameMissing = false,
    custodyMissing = false,
  } = options;

  const written: Written = { legs: [], balances: [], gameUpdates: [], audits: 0 };

  const tx = {
    game: {
      findUnique: async () =>
        gameMissing ? null : { id: GAME, status: gameStatus, endedAt: null },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        written.gameUpdates.push(data);
        return {};
      },
    },
    poolAccount: {
      findUnique: async () =>
        escrow ? { id: 'escrow-1', balanceLamports: escrowBalance, version: 3 } : null,
      findFirst: async ({ where }: { where: { ownerUserId: string } }) =>
        custodyMissing
          ? null
          : { id: `custody-${where.ownerUserId}`, balanceLamports: 1_000n, version: 7 },
      create: async ({ data }: { data: { ownerUserId: string } }) => ({
        id: `custody-${data.ownerUserId}`,
        balanceLamports: 0n,
        version: 0,
      }),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { balanceLamports: bigint };
      }) => {
        written.balances.push({ id: where.id, balanceLamports: data.balanceLamports });
        return {};
      },
    },
    transaction: {
      findFirst: async () => (paidOut ? { id: 'payout-1' } : null),
      groupBy: async () =>
        staked.map((row) => ({ userId: row.userId, _sum: { amountLamports: row.lamports } })),
      findMany: async () => refunded.map((userId) => ({ userId })),
      createMany: async ({ data }: { data: Written['legs'] }) => {
        written.legs.push(...data);
        return { count: data.length };
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;

  return { prisma, written };
}

const params = (extra: Record<string, unknown> = {}) => ({
  gameId: GAME,
  reason: 'realtime node never reported a result',
  now: 1_700_000_000_000,
  ...extra,
});

describe('cancelGameAndRefund', () => {
  it('returns each stake to the account it came from, in balanced pairs', async () => {
    const { prisma, written } = fakePrisma({
      staked: [
        { userId: 'alice', lamports: FEE },
        { userId: 'bob', lamports: FEE },
      ],
    });

    const result = await cancelGameAndRefund(prisma, params());

    expect(result.totalLamports).toBe(FEE * 2n);
    expect(result.refunds).toEqual([
      { userId: 'alice', lamports: FEE },
      { userId: 'bob', lamports: FEE },
    ]);

    // Four legs: one debit off the escrow and one credit to custody per player.
    expect(written.legs).toHaveLength(4);
    for (const leg of written.legs) {
      expect(leg.type).toBe('REFUND');
      expect(leg.amountLamports).toBe(FEE);
    }

    // The property the whole ledger rests on: every group sums to zero.
    const byGroup = new Map<string, bigint>();
    for (const leg of written.legs) {
      const signed = leg.direction === 'CREDIT' ? leg.amountLamports : -leg.amountLamports;
      byGroup.set(leg.entryGroupId, (byGroup.get(leg.entryGroupId) ?? 0n) + signed);
    }
    expect([...byGroup.values()]).toEqual([0n, 0n]);
  });

  it('keys every leg so a retry collides instead of paying twice', async () => {
    const { prisma, written } = fakePrisma({ staked: [{ userId: 'alice', lamports: FEE }] });

    await cancelGameAndRefund(prisma, params());

    expect(written.legs.map((leg) => leg.idempotencyKey)).toEqual([
      `refund:${GAME}:alice:escrow`,
      `refund:${GAME}:alice`,
    ]);
  });

  it('drains the escrow exactly and credits each player', async () => {
    const { prisma, written } = fakePrisma({
      staked: [
        { userId: 'alice', lamports: FEE },
        { userId: 'bob', lamports: FEE },
      ],
      escrowBalance: FEE * 2n,
    });

    await cancelGameAndRefund(prisma, params());

    // Custody accounts start at 1_000 in the fake, so each lands at fee + 1_000.
    expect(written.balances).toEqual([
      { id: 'custody-alice', balanceLamports: FEE + 1_000n },
      { id: 'custody-bob', balanceLamports: FEE + 1_000n },
      { id: 'escrow-1', balanceLamports: 0n },
    ]);

    // `balanceAfterLamports` has to be the running figure, not the opening one,
    // or an auditor replaying the escrow's history sees it pay the same lamport
    // out twice.
    const escrowLegs = written.legs.filter((leg) => leg.poolAccountId === 'escrow-1');
    expect(escrowLegs.map((leg) => leg.balanceAfterLamports)).toEqual([FEE, 0n]);
  });

  it('refunds from the ledger, so a match with no participant rows still pays', async () => {
    // The shape of a cycle that died between `close-lobby` and placement: the
    // entry fees are in escrow and `GamePlayer` was never written. Nothing in
    // this fake supplies `entryPaidLamports` — if the implementation read it,
    // this refunds nothing.
    const { prisma } = fakePrisma({
      staked: [
        { userId: 'alice', lamports: FEE },
        { userId: 'bob', lamports: FEE },
      ],
    });

    const result = await cancelGameAndRefund(prisma, params());

    expect(result.totalLamports).toBe(FEE * 2n);
  });

  it('skips a player an earlier attempt already repaid', async () => {
    const { prisma, written } = fakePrisma({
      staked: [
        { userId: 'alice', lamports: FEE },
        { userId: 'bob', lamports: FEE },
      ],
      // Alice was repaid before the process died; the escrow holds bob's stake.
      refunded: ['alice'],
      escrowBalance: FEE,
    });

    const result = await cancelGameAndRefund(prisma, params());

    expect(result.refunds).toEqual([{ userId: 'bob', lamports: FEE }]);
    expect(result.alreadyRefundedCount).toBe(1);
    expect(written.legs.every((leg) => leg.userId === 'bob')).toBe(true);
  });

  it('reports a repeat call as already cancelled without paying again', async () => {
    const { prisma, written } = fakePrisma({
      staked: [{ userId: 'alice', lamports: FEE }],
      refunded: ['alice'],
      escrowBalance: 0n,
      gameStatus: 'CANCELLED',
    });

    const result = await cancelGameAndRefund(prisma, params());

    expect(result.cancelled).toBe(false);
    expect(result.totalLamports).toBe(0n);
    expect(written.legs).toEqual([]);
    expect(written.balances).toEqual([]);
  });

  it('cancels the game and stops it being settled afterwards', async () => {
    const { prisma, written } = fakePrisma({ staked: [{ userId: 'alice', lamports: FEE }] });

    await cancelGameAndRefund(prisma, params());

    expect(written.gameUpdates).toEqual([
      {
        status: 'CANCELLED',
        endedAt: new Date(1_700_000_000_000),
        // Not FAILED: leaving it there arms the admin "retry settlement"
        // button on a game whose escrow is now empty.
        settlementStatus: 'NOT_REQUIRED',
        settlementError: 'realtime node never reported a result',
      },
    ]);
  });

  it('refuses a settled game and moves nothing', async () => {
    const { prisma, written } = fakePrisma({
      staked: [{ userId: 'alice', lamports: FEE }],
      gameStatus: 'COMPLETED',
    });

    await expect(cancelGameAndRefund(prisma, params())).rejects.toBeInstanceOf(
      GameAlreadySettledError,
    );
    expect(written.legs).toEqual([]);
    expect(written.gameUpdates).toEqual([]);
  });

  it('refuses when the pot was already paid out, whatever the status says', async () => {
    // Status is one write and the payout is another. Only the ledger knows.
    const { prisma, written } = fakePrisma({
      staked: [{ userId: 'alice', lamports: FEE }],
      gameStatus: 'RUNNING',
      paidOut: true,
    });

    await expect(cancelGameAndRefund(prisma, params())).rejects.toBeInstanceOf(
      GameAlreadySettledError,
    );
    expect(written.legs).toEqual([]);
  });

  it('refuses to refund more than the escrow holds', async () => {
    const { prisma, written } = fakePrisma({
      staked: [
        { userId: 'alice', lamports: FEE },
        { userId: 'bob', lamports: FEE },
      ],
      // Something took half the pot without recording a refund. Paying both
      // players in full would create the missing lamports.
      escrowBalance: FEE,
    });

    let error: unknown;
    try {
      await cancelGameAndRefund(prisma, params());
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(RefundShortfallError);
    if (!(error instanceof RefundShortfallError)) throw new Error('unreachable');
    expect(error.owedLamports).toBe(FEE * 2n);
    expect(error.availableLamports).toBe(FEE);
    expect(written.legs).toEqual([]);
  });

  it('cancels a free match, which has no escrow to drain', async () => {
    const { prisma, written } = fakePrisma({ escrow: false });

    const result = await cancelGameAndRefund(prisma, params());

    expect(result.totalLamports).toBe(0n);
    expect(result.cancelled).toBe(true);
    expect(written.legs).toEqual([]);
    expect(written.gameUpdates).toHaveLength(1);
  });

  it('ignores a stake leg with no payer rather than guessing an owner', async () => {
    const { prisma, written } = fakePrisma({
      staked: [
        { userId: 'alice', lamports: FEE },
        { userId: null, lamports: FEE },
      ],
      escrowBalance: FEE * 2n,
    });

    const result = await cancelGameAndRefund(prisma, params());

    expect(result.refunds).toEqual([{ userId: 'alice', lamports: FEE }]);
    // The unattributable lamports stay in the escrow, visible, rather than
    // being paid to whoever happened to be first in the list.
    expect(written.balances.at(-1)).toEqual({ id: 'escrow-1', balanceLamports: FEE });
  });

  it('creates a custody account rather than stranding a refund', async () => {
    const { prisma, written } = fakePrisma({
      staked: [{ userId: 'alice', lamports: FEE }],
      custodyMissing: true,
    });

    await cancelGameAndRefund(prisma, params());

    expect(written.balances).toEqual([
      { id: 'custody-alice', balanceLamports: FEE },
      { id: 'escrow-1', balanceLamports: 0n },
    ]);
  });

  it('rejects an unknown game', async () => {
    const { prisma } = fakePrisma({ gameMissing: true });

    await expect(cancelGameAndRefund(prisma, params())).rejects.toBeInstanceOf(GameNotFoundError);
  });

  it('writes the audit row inside the same transaction as the money', async () => {
    const { prisma, written } = fakePrisma({ staked: [{ userId: 'alice', lamports: FEE }] });

    await cancelGameAndRefund(
      prisma,
      params({
        audit: async () => {
          // Recorded at call time, so its position relative to the legs is what
          // is being asserted: the trail cannot be written after a commit that
          // already moved the balances.
          written.audits = written.legs.length;
        },
      }),
    );

    expect(written.audits).toBe(2);
  });
});
