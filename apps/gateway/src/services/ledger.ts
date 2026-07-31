import type { Prisma, PrismaClient } from '@arena/db';
import { PoolAccountKind, TransactionDirection, type TransactionType } from '@arena/db';

import { AppError, conflict } from '../lib/errors.js';

/**
 * Double-entry ledger.
 *
 * Every movement of value is posted as a group of legs that must sum to zero.
 * That invariant is what makes the books provable: the sum of all pool balances
 * always equals the net of all posted transactions, and a cron job can assert
 * it. Single-sided writes would make drift undetectable.
 *
 * Money entering or leaving the platform balances against the `EXTERNAL`
 * account, which represents player wallets on chain.
 */

export interface LedgerLeg {
  poolAccountId: string;
  /** Null for platform-internal accounts (treasury, external). */
  userId?: string | null;
  direction: TransactionDirection;
  /** Always positive; `direction` carries the sign. */
  amount: bigint;
  description?: string;
}

export interface PostEntryParams {
  type: TransactionType;
  legs: LedgerLeg[];
  /**
   * Base for each leg's unique key. Retrying the same logical operation
   * produces the same keys, so the unique index — not application logic — is
   * what actually prevents a double post.
   */
  idempotencyKeyBase: string;
  entryGroupId: string;
  gameId?: string | undefined;
  depositId?: string | undefined;
  withdrawalId?: string | undefined;
  rewardId?: string | undefined;
  metadata?: Prisma.InputJsonValue | undefined;
}

export class LedgerImbalanceError extends AppError {
  constructor(credits: bigint, debits: bigint) {
    super(
      500,
      'LEDGER_IMBALANCE',
      `Ledger entry does not balance: credits=${credits} debits=${debits}`,
      { expose: false },
    );
  }
}

export class AlreadyPostedError extends AppError {
  constructor(key: string) {
    super(409, 'ALREADY_POSTED', `Ledger entry ${key} has already been posted`);
  }
}

/**
 * Validates that an entry balances.
 *
 * Pure and exported so the invariant can be tested without a database — which
 * matters, because this is the single check standing between a bug and silently
 * inventing money.
 */
export function assertBalanced(legs: readonly LedgerLeg[]): {
  credits: bigint;
  debits: bigint;
} {
  if (legs.length < 2) {
    throw new LedgerImbalanceError(0n, 0n);
  }

  let credits = 0n;
  let debits = 0n;

  for (const leg of legs) {
    if (leg.amount <= 0n) {
      throw new AppError(500, 'LEDGER_INVALID_LEG', 'Leg amount must be positive', {
        expose: false,
      });
    }
    if (leg.direction === TransactionDirection.CREDIT) credits += leg.amount;
    else debits += leg.amount;
  }

  if (credits !== debits) throw new LedgerImbalanceError(credits, debits);
  return { credits, debits };
}

/** Accounts permitted to hold a negative balance. */
function mayGoNegative(kind: PoolAccountKind): boolean {
  // EXTERNAL mirrors the outside world: net inflow makes it negative by design.
  return kind === PoolAccountKind.EXTERNAL;
}

/**
 * Posts a balanced entry and moves the pool balances, atomically.
 *
 * Each balance write is guarded by the account's `version`, so two concurrent
 * settlements cannot both read-modify-write and lose one update. A losing
 * writer gets a conflict rather than silently overwriting.
 */
export async function postEntry(
  prisma: PrismaClient,
  params: PostEntryParams,
): Promise<{ transactionIds: string[] }> {
  assertBalanced(params.legs);

  try {
    return await prisma.$transaction(async (tx) => {
      const transactionIds: string[] = [];

      for (const [index, leg] of params.legs.entries()) {
        const account = await tx.poolAccount.findUnique({
          where: { id: leg.poolAccountId },
        });
        if (!account) {
          throw new AppError(500, 'POOL_ACCOUNT_MISSING', 'Pool account not found', {
            expose: false,
          });
        }

        const delta = leg.direction === TransactionDirection.CREDIT ? leg.amount : -leg.amount;
        const nextBalance = account.balanceLamports + delta;

        if (nextBalance < 0n && !mayGoNegative(account.kind)) {
          throw new AppError(
            409,
            'INSUFFICIENT_POOL_FUNDS',
            `Pool ${account.name} has insufficient funds`,
          );
        }

        // Optimistic lock: only applies if nobody else moved this account.
        const updated = await tx.poolAccount.updateMany({
          where: { id: account.id, version: account.version },
          data: { balanceLamports: nextBalance, version: { increment: 1 } },
        });
        if (updated.count === 0) {
          throw conflict('Pool account was modified concurrently; retry the operation');
        }

        const created = await tx.transaction.create({
          data: {
            entryGroupId: params.entryGroupId,
            type: params.type,
            direction: leg.direction,
            amountLamports: leg.amount,
            balanceAfterLamports: nextBalance,
            poolAccountId: account.id,
            userId: leg.userId ?? null,
            gameId: params.gameId ?? null,
            depositId: params.depositId ?? null,
            withdrawalId: params.withdrawalId ?? null,
            rewardId: params.rewardId ?? null,
            idempotencyKey: `${params.idempotencyKeyBase}:${index}`,
            description: leg.description ?? null,
            // Spread rather than `metadata: x ?? undefined`: with
            // exactOptionalPropertyTypes, an explicit `undefined` is not the
            // same as an absent key and Prisma's input type rejects it.
            ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
          },
          select: { id: true },
        });

        transactionIds.push(created.id);
      }

      return { transactionIds };
    });
  } catch (error) {
    // A unique violation on idempotencyKey means this exact entry already
    // posted — the desired end state, so it is not an error to the caller.
    if (isUniqueViolation(error, 'idempotency_key')) {
      throw new AlreadyPostedError(params.idempotencyKeyBase);
    }
    throw error;
  }
}

export function isUniqueViolation(error: unknown, field?: string): boolean {
  const candidate = error as { code?: string; meta?: { target?: string[] | string } };
  if (candidate?.code !== 'P2002') return false;
  if (!field) return true;

  const target = candidate.meta?.target;
  const targets = Array.isArray(target) ? target : [target ?? ''];
  return targets.some((entry) => entry.includes(field));
}

/**
 * Returns the user's custody pool account, creating it on first use.
 *
 * Every player's balance is a pool account rather than a column on `users`,
 * which is what keeps every lamport inside the ledger and the invariant
 * checkable.
 */
export async function getOrCreateCustodyAccount(
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
  } catch (error) {
    // Lost a race with a concurrent request; the row now exists.
    if (isUniqueViolation(error)) {
      const raced = await prisma.poolAccount.findUniqueOrThrow({
        where: { name },
        select: { id: true, balanceLamports: true, reservedLamports: true },
      });
      return raced;
    }
    throw error;
  }
}

/** Looks up a singleton system pool by name, e.g. `treasury` or `external`. */
export async function getSystemAccount(
  prisma: PrismaClient,
  name: 'treasury' | 'rake' | 'rewards' | 'external',
): Promise<{ id: string }> {
  const account = await prisma.poolAccount.findUnique({
    where: { name },
    select: { id: true },
  });
  if (!account) {
    throw new AppError(
      500,
      'SYSTEM_POOL_MISSING',
      `System pool "${name}" is missing. Run the database seed.`,
      { expose: false },
    );
  }
  return account;
}

/** Spendable = balance - reserved. Reserved covers in-flight commitments. */
export function spendable(account: { balanceLamports: bigint; reservedLamports: bigint }): bigint {
  const value = account.balanceLamports - account.reservedLamports;
  return value > 0n ? value : 0n;
}
