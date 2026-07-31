import {
  PoolAccountKind,
  type PrismaClient,
  TransactionDirection,
  TransactionType,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

/**
 * Thrown when a player cannot cover the stake. A named class rather than a
 * generic Error so the gateway can map it to a 409 without string matching.
 */
export class InsufficientBalanceError extends Error {
  constructor(
    readonly requiredLamports: bigint,
    readonly availableLamports: bigint,
  ) {
    super(
      `Insufficient balance: need ${requiredLamports} lamports, have ${availableLamports} spendable`,
    );
    this.name = 'InsufficientBalanceError';
  }
}

/** Spendable = balance - reserved. Reserved covers in-flight commitments. */
function spendable(account: { balanceLamports: bigint; reservedLamports: bigint }): bigint {
  const value = account.balanceLamports - account.reservedLamports;
  return value > 0n ? value : 0n;
}

/** The user's custody pool account, created on first use. */
async function getOrCreateCustodyAccount(
  prisma: PrismaClient,
  userId: string,
): Promise<{ id: string; balanceLamports: bigint; reservedLamports: bigint }> {
  const name = `custody:${userId}`;

  const existing = await prisma.poolAccount.findUnique({
    where: { name },
    select: { id: true, balanceLamports: true, reservedLamports: true },
  });
  if (existing) return existing;

  try {
    return await prisma.poolAccount.create({
      data: { name, kind: PoolAccountKind.USER_CUSTODY, ownerUserId: userId },
      select: { id: true, balanceLamports: true, reservedLamports: true },
    });
  } catch {
    // Lost a race with a concurrent request; the row now exists.
    return prisma.poolAccount.findUniqueOrThrow({
      where: { name },
      select: { id: true, balanceLamports: true, reservedLamports: true },
    });
  }
}

/**
 * Entry-fee reservation.
 *
 * Joining a paid room commits the player's stake before the match exists. That
 * commitment is a **reservation**, not a transfer: the lamports stay in the
 * player's custody account but stop being spendable, so they cannot queue for
 * three rooms on one balance or withdraw the money out from under a match that
 * is about to start.
 *
 * The actual movement happens later — on chain via `lock_entry_fee` when the
 * match starts, and in the ledger when it settles. Reserving first is what
 * makes those steps safe to attempt: by the time the chain is involved, the
 * money is already known to be there and already spoken for.
 *
 * Two properties this file exists to guarantee:
 *
 *  1. **A reservation is idempotent per player per room.** A double-clicked
 *     join must reserve once. Enforced by reading the existing reservation
 *     inside the same transaction as the write.
 *  2. **Releasing never over-releases.** Leaving a lobby twice, or leaving
 *     after the stake was already consumed by settlement, must not hand back
 *     lamports that were never reserved.
 */

/** Where a reservation is recorded. Keyed by player and room. */
export interface StakeReservation {
  userId: string;
  tierId: string;
  lamports: bigint;
}

/**
 * Reserves an entry fee.
 *
 * Returns `already` when the player had already staked this room, so the caller
 * can treat a retry as success rather than charging twice.
 */
export async function reserveEntryFee(
  prisma: PrismaClient,
  params: StakeReservation,
): Promise<{ reserved: bigint; already: boolean; spendableAfter: bigint }> {
  if (params.lamports < 0n) throw new RangeError('Entry fee cannot be negative');

  // Free rooms reserve nothing. Returning early keeps a practice join off the
  // money path entirely rather than posting a zero-value reservation.
  if (params.lamports === 0n) {
    const custody = await getOrCreateCustodyAccount(prisma, params.userId);
    return { reserved: 0n, already: false, spendableAfter: spendable(custody) };
  }

  const custody = await getOrCreateCustodyAccount(prisma, params.userId);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.stakeReservation.findUnique({
      where: { userId_tierId: { userId: params.userId, tierId: params.tierId } },
    });

    if (existing) {
      const account = await tx.poolAccount.findUniqueOrThrow({ where: { id: custody.id } });
      return {
        reserved: existing.lamports,
        already: true,
        spendableAfter: spendable(account),
      };
    }

    // Re-read inside the transaction: the balance may have moved since the
    // check above, and a stale read here is how a player stakes money they no
    // longer have.
    const account = await tx.poolAccount.findUniqueOrThrow({ where: { id: custody.id } });
    const available = spendable(account);

    if (available < params.lamports) {
      throw new InsufficientBalanceError(params.lamports, available);
    }

    await tx.poolAccount.update({
      where: { id: account.id, version: account.version },
      data: {
        reservedLamports: account.reservedLamports + params.lamports,
        version: { increment: 1 },
      },
    });

    await tx.stakeReservation.create({
      data: { userId: params.userId, tierId: params.tierId, lamports: params.lamports },
    });

    return {
      reserved: params.lamports,
      already: false,
      spendableAfter: available - params.lamports,
    };
  });
}

/**
 * Releases a reservation.
 *
 * Called when a player leaves a lobby, and when a match is cancelled. Silent on
 * a missing reservation: leaving a room you never staked is not an error, and a
 * client that lost track of its own state must be able to call this safely.
 */
export async function releaseEntryFee(
  prisma: PrismaClient,
  params: { userId: string; tierId: string },
): Promise<{ released: bigint }> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.stakeReservation.findUnique({
      where: { userId_tierId: { userId: params.userId, tierId: params.tierId } },
    });

    if (!existing) return { released: 0n };

    const custody = await tx.poolAccount.findFirst({
      where: { ownerUserId: params.userId },
    });

    if (custody) {
      // Clamped at zero. If the reservation and the account ever disagree,
      // handing back more than was reserved would create lamports out of
      // nothing — far worse than under-releasing, which an operator can fix.
      const next =
        custody.reservedLamports > existing.lamports
          ? custody.reservedLamports - existing.lamports
          : 0n;

      await tx.poolAccount.update({
        where: { id: custody.id, version: custody.version },
        data: { reservedLamports: next, version: { increment: 1 } },
      });
    }

    await tx.stakeReservation.delete({ where: { id: existing.id } });
    return { released: existing.lamports };
  });
}

/** Every stake currently held for a room. Read by the match-start stage. */
export async function reservationsForTier(
  prisma: PrismaClient,
  tierId: string,
): Promise<{ userId: string; lamports: bigint }[]> {
  const rows = await prisma.stakeReservation.findMany({
    where: { tierId },
    select: { userId: true, lamports: true },
  });
  return rows;
}

/**
 * Consumes reservations into a game's escrow, posting the ledger legs.
 *
 * This is the moment a stake stops being the player's money and becomes the
 * pot. It must be **double-entry**: every lamport that leaves a custody account
 * lands in the escrow account, and both movements are recorded.
 *
 * An earlier version updated balances directly with no `transactions` rows.
 * That silently broke the invariant the whole ledger design exists to make
 * checkable — `SUM(pool balances) == SUM(posted entries)` — and the treasury
 * page would have reported drift equal to every stake ever taken.
 *
 * Idempotent on `stake:{gameId}:{userId}`: a retried stage collides on the
 * unique index rather than charging a second time.
 */
/**
 * The staked total did not match the field about to play.
 *
 * Its own type so the caller can tell it apart from a genuine failure and abort
 * the cycle quietly rather than retrying a stage that will fail identically.
 */
export class StakeMismatchError extends Error {
  constructor(
    readonly tierId: string,
    readonly staked: bigint,
    readonly expected: bigint,
  ) {
    super(
      `Staked total for ${tierId} is ${staked} lamports but the queued field is worth ${expected}`,
    );
    this.name = 'StakeMismatchError';
  }
}

export async function consumeReservations(
  prisma: PrismaClient,
  params: {
    tierId: string;
    gameId: string;
    escrowAccountId: string;
    /**
     * What the reservations must add up to, when the caller knows.
     *
     * Checked *inside* the transaction, before anything moves. The caller used
     * to compare the returned total against the queued field and abort on a
     * mismatch — but by then this function had already committed, so "refusing
     * to start" left the money in escrow for a match that never ran and gave
     * nobody a way to get it back. A mismatch has to prevent the transfer, not
     * follow it.
     *
     * The mismatch itself is real and worth refusing on: reservations are keyed
     * by tier, so an orphan left by some earlier failure would otherwise be
     * swept into an unrelated match's pot.
     */
    expectedLamports?: bigint;
  },
): Promise<{ consumed: number; totalLamports: bigint }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.stakeReservation.findMany({ where: { tierId: params.tierId } });

    if (params.expectedLamports !== undefined) {
      const staked = rows.reduce((sum, row) => sum + row.lamports, 0n);
      if (staked !== params.expectedLamports) {
        // Throwing rolls the transaction back, so no balance is touched.
        throw new StakeMismatchError(params.tierId, staked, params.expectedLamports);
      }
    }

    if (rows.length === 0) return { consumed: 0, totalLamports: 0n };

    const escrow = await tx.poolAccount.findUniqueOrThrow({
      where: { id: params.escrowAccountId },
    });

    let escrowBalance = escrow.balanceLamports;
    let total = 0n;
    let consumed = 0;

    for (const row of rows) {
      const custody = await tx.poolAccount.findFirst({ where: { ownerUserId: row.userId } });
      if (!custody) continue;

      // Clamped, but a shortfall here means the reservation and the balance
      // disagree — which should be impossible, since reserving checked it.
      if (custody.balanceLamports < row.lamports) {
        throw new Error(
          `Stake exceeds balance for user ${row.userId}: ` +
            `${row.lamports} > ${custody.balanceLamports}`,
        );
      }

      const custodyAfter = custody.balanceLamports - row.lamports;
      const reservedAfter =
        custody.reservedLamports > row.lamports ? custody.reservedLamports - row.lamports : 0n;
      escrowBalance += row.lamports;

      await tx.poolAccount.update({
        where: { id: custody.id, version: custody.version },
        data: {
          balanceLamports: custodyAfter,
          reservedLamports: reservedAfter,
          version: { increment: 1 },
        },
      });

      // Two legs summing to zero: the stake leaves the player and enters the
      // pot. One `entryGroupId` per player so a single stake is traceable.
      const entryGroupId = randomUUID();

      await tx.transaction.createMany({
        data: [
          {
            entryGroupId,
            type: TransactionType.ENTRY_FEE,
            direction: TransactionDirection.DEBIT,
            amountLamports: row.lamports,
            balanceAfterLamports: custodyAfter,
            userId: row.userId,
            poolAccountId: custody.id,
            gameId: params.gameId,
            idempotencyKey: `stake:${params.gameId}:${row.userId}`,
            description: `Entry fee for ${params.tierId}`,
          },
          {
            entryGroupId,
            type: TransactionType.ENTRY_FEE,
            direction: TransactionDirection.CREDIT,
            amountLamports: row.lamports,
            balanceAfterLamports: escrowBalance,
            userId: row.userId,
            poolAccountId: escrow.id,
            gameId: params.gameId,
            idempotencyKey: `stake:${params.gameId}:${row.userId}:escrow`,
            description: `Entry fee for ${params.tierId}`,
          },
        ],
      });

      total += row.lamports;
      consumed += 1;
    }

    await tx.poolAccount.update({
      where: { id: escrow.id, version: escrow.version },
      data: { balanceLamports: escrowBalance, version: { increment: 1 } },
    });

    await tx.stakeReservation.deleteMany({ where: { tierId: params.tierId } });
    return { consumed, totalLamports: total };
  });
}
