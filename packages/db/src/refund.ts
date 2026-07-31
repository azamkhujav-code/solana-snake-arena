import {
  GameStatus,
  PoolAccountKind,
  type Prisma,
  type PrismaClient,
  SettlementStatus,
  TransactionDirection,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

/**
 * Cancelling a match and handing the pot back.
 *
 * `consumeReservations` is the point of no return: at `close-lobby` each
 * player's stake leaves their custody account and lands in the game's escrow
 * pool. Everything after that — placing the room, playing it, settling it — can
 * still fail, and until this file existed a failure there left the pot sitting
 * in an escrow account with no way out. The money was neither the players' nor
 * the platform's; it was simply stuck, and the only record of it was a
 * `GAME_ESCROW` balance nobody was watching.
 *
 * This is the inverse leg of `consumeReservations`, and it is deliberately
 * shaped the same way:
 *
 *  1. **Double-entry.** Every lamport that leaves the escrow lands in a custody
 *     account, and both movements are posted. A single-sided write here would
 *     break `SUM(pool balances) == SUM(posted entries)`, which is the one
 *     property that makes the ledger checkable at all.
 *  2. **Idempotent on `refund:{gameId}:{userId}`.** The cycle retries stages and
 *     an operator can click twice; a second attempt must collide on the unique
 *     index rather than pay the pot back a second time.
 *  3. **It refuses rather than improvises.** A settled game, or an escrow that
 *     holds less than is owed, throws. Paying out what is not there would
 *     invent lamports, which is strictly worse than a stuck pot an operator can
 *     still see.
 */

/** The game has already paid out. Refunding it would double-spend the pot. */
export class GameAlreadySettledError extends Error {
  constructor(readonly gameId: string) {
    super(`Game ${gameId} has already been settled; refund would double-spend the pot`);
    this.name = 'GameAlreadySettledError';
  }
}

/**
 * The escrow holds less than the entry fees posted against it.
 *
 * Its own type because the operator response is specific: this is not a retry,
 * it is a reconciliation. Something took money out of the escrow without
 * recording it, and refunding the difference anyway would create the lamports
 * to cover it.
 */
export class RefundShortfallError extends Error {
  constructor(
    readonly gameId: string,
    readonly owedLamports: bigint,
    readonly availableLamports: bigint,
  ) {
    super(
      `Escrow for game ${gameId} holds ${availableLamports} lamports but ${owedLamports} is owed in refunds`,
    );
    this.name = 'RefundShortfallError';
  }
}

export class GameNotFoundError extends Error {
  constructor(readonly gameId: string) {
    super(`Game ${gameId} not found`);
    this.name = 'GameNotFoundError';
  }
}

export interface RefundLeg {
  userId: string;
  lamports: bigint;
}

export interface CancelGameResult {
  gameId: string;
  /** False when the game was already CANCELLED — a retry, not a no-op error. */
  cancelled: boolean;
  /** Refunds posted by *this* call. Empty on a retry. */
  refunds: RefundLeg[];
  totalLamports: bigint;
  /** Players an earlier attempt had already repaid. */
  alreadyRefundedCount: number;
}

export interface CancelGameParams {
  gameId: string;
  /** Recorded on the game and in the audit trail. Required: an unexplained
   *  cancellation is unreviewable. */
  reason: string;
  /** Epoch ms, for a caller with an injected clock. */
  now?: number;
  /**
   * Runs inside the same transaction as the refund.
   *
   * The gateway writes its audit row through this rather than after the call,
   * so there is no window where money moved and the trail says otherwise — the
   * same rule `writeAudit` enforces by taking a transaction client.
   */
  audit?: (tx: Prisma.TransactionClient) => Promise<void>;
}

/**
 * Cancels a game and returns every entry fee it consumed.
 *
 * Amounts come from the **ledger**, not from `GamePlayer.entryPaidLamports`:
 * the posted `ENTRY_FEE` credits against this game's escrow are the record of
 * what actually entered it, and they exist for every stake by construction —
 * `consumeReservations` writes them in the same transaction as the balance
 * move. `GamePlayer` rows are written later in the cycle, so a match that died
 * between `close-lobby` and placement has a funded escrow and no participant
 * rows at all. Refunding from the copy would silently pay back nothing in
 * exactly the case this function exists for.
 */
export async function cancelGameAndRefund(
  prisma: PrismaClient,
  params: CancelGameParams,
): Promise<CancelGameResult> {
  const { gameId, reason } = params;
  const at = new Date(params.now ?? Date.now());

  return prisma.$transaction(async (tx) => {
    const game = await tx.game.findUnique({
      where: { id: gameId },
      select: { id: true, status: true, endedAt: true },
    });
    if (!game) throw new GameNotFoundError(gameId);
    if (game.status === GameStatus.COMPLETED) throw new GameAlreadySettledError(gameId);

    /**
     * Looked up by foreign key, not by the `escrow:{gameId}` name.
     *
     * `PoolAccount.gameId` is unique — one escrow per game — and it is the
     * relation the schema actually models. Matching on the name convention is
     * what let an earlier bug create the account under one string and look it
     * up under another.
     */
    const escrow = await tx.poolAccount.findUnique({ where: { gameId } });

    // A free tier never creates one, so there is nothing to hand back. The game
    // is still cancelled: the status is the player-visible half of this.
    if (!escrow) {
      const updated = await cancelRow(tx, gameId, game, reason, at);
      await params.audit?.(tx);
      return {
        gameId,
        cancelled: updated,
        refunds: [],
        totalLamports: 0n,
        alreadyRefundedCount: 0,
      };
    }

    // A paid-out game is not refundable even if its status says otherwise —
    // status is set by one write, the payout by another, and only the ledger is
    // authoritative about where the pot went.
    const paidOut = await tx.transaction.findFirst({
      where: {
        gameId,
        type: { in: [TransactionType.PAYOUT, TransactionType.RAKE] },
        status: TransactionStatus.POSTED,
      },
      select: { id: true },
    });
    if (paidOut) throw new GameAlreadySettledError(gameId);

    const staked = await tx.transaction.groupBy({
      by: ['userId'],
      where: {
        gameId,
        poolAccountId: escrow.id,
        type: TransactionType.ENTRY_FEE,
        direction: TransactionDirection.CREDIT,
        status: TransactionStatus.POSTED,
      },
      _sum: { amountLamports: true },
    });

    // Whoever an earlier attempt already repaid. The unique index on
    // `idempotencyKey` is the real guarantee; this only keeps a retry from
    // failing the whole transaction on a collision it could have skipped.
    const settled = await tx.transaction.findMany({
      where: {
        gameId,
        poolAccountId: escrow.id,
        type: TransactionType.REFUND,
        direction: TransactionDirection.DEBIT,
      },
      select: { userId: true },
    });
    const alreadyRefunded = new Set(settled.map((row) => row.userId));

    const owed: RefundLeg[] = [];
    for (const row of staked) {
      const amount = row._sum.amountLamports ?? 0n;
      // A stake leg always carries its payer; a null here would be a leg this
      // function cannot attribute, and guessing an owner is not an option.
      if (!row.userId || amount <= 0n) continue;
      if (alreadyRefunded.has(row.userId)) continue;
      owed.push({ userId: row.userId, lamports: amount });
    }

    const total = owed.reduce((sum, leg) => sum + leg.lamports, 0n);
    if (total > escrow.balanceLamports) {
      throw new RefundShortfallError(gameId, total, escrow.balanceLamports);
    }

    let escrowBalance = escrow.balanceLamports;

    for (const leg of owed) {
      const custody = await getCustodyAccount(tx, leg.userId);

      escrowBalance -= leg.lamports;
      const custodyAfter = custody.balanceLamports + leg.lamports;
      const entryGroupId = randomUUID();

      await tx.poolAccount.update({
        where: { id: custody.id, version: custody.version },
        data: { balanceLamports: custodyAfter, version: { increment: 1 } },
      });

      // Two legs summing to zero: the stake leaves the pot and returns to the
      // player it came from. Keys mirror `stake:{gameId}:{userId}` so the round
      // trip reads as a pair in the transaction log.
      await tx.transaction.createMany({
        data: [
          {
            entryGroupId,
            type: TransactionType.REFUND,
            direction: TransactionDirection.DEBIT,
            amountLamports: leg.lamports,
            balanceAfterLamports: escrowBalance,
            userId: leg.userId,
            poolAccountId: escrow.id,
            gameId,
            idempotencyKey: `refund:${gameId}:${leg.userId}:escrow`,
            description: 'Entry fee refunded: match cancelled',
          },
          {
            entryGroupId,
            type: TransactionType.REFUND,
            direction: TransactionDirection.CREDIT,
            amountLamports: leg.lamports,
            balanceAfterLamports: custodyAfter,
            userId: leg.userId,
            poolAccountId: custody.id,
            gameId,
            idempotencyKey: `refund:${gameId}:${leg.userId}`,
            description: 'Entry fee refunded: match cancelled',
          },
        ],
      });
    }

    if (owed.length > 0) {
      await tx.poolAccount.update({
        where: { id: escrow.id, version: escrow.version },
        data: { balanceLamports: escrowBalance, version: { increment: 1 } },
      });
    }

    const cancelled = await cancelRow(tx, gameId, game, reason, at);
    await params.audit?.(tx);

    return {
      gameId,
      cancelled,
      refunds: owed,
      totalLamports: total,
      alreadyRefundedCount: alreadyRefunded.size,
    };
  });
}

/**
 * Moves the game to CANCELLED.
 *
 * `settlementStatus` goes to NOT_REQUIRED because after a refund there is
 * genuinely nothing left to settle — and because leaving it FAILED would leave
 * the admin "retry settlement" button armed on a game whose escrow is now
 * empty. `potLamports` is left alone: it is the historical fact of what was
 * staked, and the refund is recorded in the ledger rather than by editing the
 * record of the stake.
 *
 * Returns false when the game was already cancelled, which a retry must treat
 * as success.
 */
async function cancelRow(
  tx: Prisma.TransactionClient,
  gameId: string,
  before: { status: GameStatus; endedAt: Date | null },
  reason: string,
  at: Date,
): Promise<boolean> {
  await tx.game.update({
    where: { id: gameId },
    data: {
      status: GameStatus.CANCELLED,
      endedAt: before.endedAt ?? at,
      settlementStatus: SettlementStatus.NOT_REQUIRED,
      settlementError: reason.slice(0, 500),
    },
  });
  return before.status !== GameStatus.CANCELLED;
}

/**
 * The player's custody account.
 *
 * Created if absent rather than skipped. A missing account should be
 * impossible — the stake was debited from it — but skipping would leave that
 * player's lamports in the escrow with the game marked cancelled, which is the
 * exact failure this file exists to remove.
 */
async function getCustodyAccount(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<{ id: string; balanceLamports: bigint; version: number }> {
  const existing = await tx.poolAccount.findFirst({
    where: { ownerUserId: userId },
    select: { id: true, balanceLamports: true, version: true },
  });
  if (existing) return existing;

  return tx.poolAccount.create({
    data: {
      name: `custody:${userId}`,
      kind: PoolAccountKind.USER_CUSTODY,
      ownerUserId: userId,
    },
    select: { id: true, balanceLamports: true, version: true },
  });
}
