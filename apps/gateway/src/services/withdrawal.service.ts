import type { PrismaClient } from '@arena/db';
import { TransactionDirection, TransactionType, WithdrawalStatus } from '@arena/db';
import type { ArenaService } from '@arena/solana';
import { splitWithdrawal, verifyWithdrawal } from '@arena/solana';
import { PublicKey } from '@solana/web3.js';
import { randomUUID } from 'node:crypto';

import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import {
  getOrCreateCustodyAccount,
  getSystemAccount,
  isUniqueViolation,
  postEntry,
  spendable,
} from './ledger.js';

export const MIN_WITHDRAWAL_LAMPORTS = 10_000n;

/** Above this, a withdrawal is held for a human to look at. */
export const REVIEW_THRESHOLD_LAMPORTS = 50_000_000_000n; // 50 SOL

export const WITHDRAWAL_INTENT_TTL_MS = 15 * 60 * 1000;

export interface WithdrawalServiceDeps {
  prisma: PrismaClient;
  solana: ArenaService;
  acquireLock: (key: string, ttlMs: number) => Promise<(() => Promise<void>) | null>;
  /** Current on-chain withdrawal fee, in basis points. */
  withdrawalFeeBps: number;
}

export interface WithdrawalQuote {
  gross: bigint;
  fee: bigint;
  net: bigint;
  feeBps: number;
  spendableBalance: bigint;
}

/**
 * Quotes a withdrawal.
 *
 * The fee is computed with the same integer maths the program uses, so the
 * figure shown before signing matches the chain to the lamport. A float-based
 * estimate drifts and produces a "you said 0.99 but I got 0.989999" support
 * ticket.
 */
export async function quoteWithdrawal(
  deps: WithdrawalServiceDeps,
  params: { userId: string; amount: bigint },
): Promise<WithdrawalQuote> {
  const custody = await getOrCreateCustodyAccount(deps.prisma, params.userId);
  const { gross, fee, net } = splitWithdrawal(params.amount, deps.withdrawalFeeBps);

  return {
    gross,
    fee,
    net,
    feeBps: deps.withdrawalFeeBps,
    spendableBalance: spendable(custody),
  };
}

export interface WithdrawalIntent {
  withdrawalId: string;
  gross: bigint;
  fee: bigint;
  net: bigint;
  programId: string;
  expiresAt: Date;
  requiresReview: boolean;
}

/**
 * Reserves funds and records the intent.
 *
 * Reserving up front is the important part: without it the same lamports could
 * back two concurrent withdrawals, or be wagered in a room while a withdrawal
 * is in flight. The reservation is released when the withdrawal confirms,
 * fails, or expires.
 */
export async function createWithdrawalIntent(
  deps: WithdrawalServiceDeps,
  params: { userId: string; walletId: string; amount: bigint },
): Promise<WithdrawalIntent> {
  if (params.amount < MIN_WITHDRAWAL_LAMPORTS) {
    throw badRequest(`Minimum withdrawal is ${MIN_WITHDRAWAL_LAMPORTS} lamports`);
  }

  const wallet = await deps.prisma.wallet.findUnique({
    where: { id: params.walletId },
    select: { userId: true, verifiedAt: true, address: true },
  });
  if (!wallet || wallet.userId !== params.userId) throw notFound('Wallet');
  // An unverified wallet has not proven ownership, so it must never receive a payout.
  if (!wallet.verifiedAt) throw forbidden('Wallet ownership has not been verified');

  const { gross, fee, net } = splitWithdrawal(params.amount, deps.withdrawalFeeBps);
  const requiresReview = gross >= REVIEW_THRESHOLD_LAMPORTS;

  const withdrawalId = await deps.prisma.$transaction(async (tx) => {
    const custody = await tx.poolAccount.findUniqueOrThrow({
      where: { name: `custody:${params.userId}` },
      select: { id: true, balanceLamports: true, reservedLamports: true, version: true },
    });

    if (spendable(custody) < gross) {
      throw badRequest('Insufficient spendable balance');
    }

    const reserved = await tx.poolAccount.updateMany({
      where: { id: custody.id, version: custody.version },
      data: {
        reservedLamports: custody.reservedLamports + gross,
        version: { increment: 1 },
      },
    });
    if (reserved.count === 0) {
      throw conflict('Balance changed while creating the withdrawal; retry');
    }

    const created = await tx.withdrawal.create({
      data: {
        userId: params.userId,
        walletId: params.walletId,
        amountLamports: gross,
        feeLamports: fee,
        status: requiresReview ? WithdrawalStatus.PENDING_REVIEW : WithdrawalStatus.APPROVED,
        idempotencyKey: `withdrawal:${randomUUID()}`,
      },
      select: { id: true },
    });

    return created.id;
  });

  return {
    withdrawalId,
    gross,
    fee,
    net,
    programId: deps.solana.programId.toBase58(),
    expiresAt: new Date(Date.now() + WITHDRAWAL_INTENT_TTL_MS),
    requiresReview,
  };
}

export type WithdrawalOutcome =
  | { status: 'confirmed'; signature: string; net: bigint; fee: bigint }
  | { status: 'pending'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * Confirms a player-signed withdrawal against the chain.
 *
 * Withdrawals are non-custodial: the player signs the `withdraw` instruction
 * themselves, so the backend cannot block or redirect one. This step is
 * therefore bookkeeping — it mirrors what already happened on chain into the
 * ledger and releases the reservation.
 */
export async function confirmWithdrawal(
  deps: WithdrawalServiceDeps,
  params: { userId: string; withdrawalId: string; signature: string },
): Promise<WithdrawalOutcome> {
  const release = await deps.acquireLock(`withdrawal:${params.withdrawalId}`, 30_000);
  if (!release) throw conflict('This withdrawal is already being confirmed');

  try {
    const withdrawal = await deps.prisma.withdrawal.findUnique({
      where: { id: params.withdrawalId },
      include: { wallet: { select: { address: true } } },
    });

    if (!withdrawal || withdrawal.userId !== params.userId) throw notFound('Withdrawal');

    if (withdrawal.status === WithdrawalStatus.CONFIRMED) {
      return {
        status: 'confirmed',
        signature: withdrawal.txSignature ?? params.signature,
        net: withdrawal.amountLamports - withdrawal.feeLamports,
        fee: withdrawal.feeLamports,
      };
    }
    if (
      withdrawal.status !== WithdrawalStatus.APPROVED &&
      withdrawal.status !== WithdrawalStatus.SUBMITTED
    ) {
      throw conflict(`Withdrawal is ${withdrawal.status} and cannot be confirmed`);
    }

    const duplicate = await deps.prisma.withdrawal.findUnique({
      where: { txSignature: params.signature },
      select: { id: true },
    });
    if (duplicate && duplicate.id !== withdrawal.id) {
      throw conflict('This transaction signature is already recorded');
    }

    const parsed = await deps.solana.getParsedTransaction(params.signature);
    if (!parsed) {
      await deps.prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: WithdrawalStatus.SUBMITTED, txSignature: params.signature },
      });
      return { status: 'pending', reason: 'Transaction not yet visible on chain' };
    }

    const { pool, treasury } = deps.solana.getVaultAddresses();
    const result = verifyWithdrawal({
      transaction: parsed,
      programId: deps.solana.programId,
      pool,
      treasury,
      recipient: new PublicKey(withdrawal.wallet.address),
      expectedGrossLamports: withdrawal.amountLamports,
      expectedFeeLamports: withdrawal.feeLamports,
    });

    if (!result.ok) {
      const reason = describeFailure(result.failure);
      await failWithdrawal(
        deps.prisma,
        withdrawal.id,
        withdrawal.userId,
        withdrawal.amountLamports,
        reason,
      );
      return { status: 'failed', reason };
    }

    const custody = await getOrCreateCustodyAccount(deps.prisma, withdrawal.userId);
    const external = await getSystemAccount(deps.prisma, 'external');
    const treasuryAccount = await getSystemAccount(deps.prisma, 'treasury');

    const net = withdrawal.amountLamports - withdrawal.feeLamports;

    const legs = [
      {
        poolAccountId: custody.id,
        userId: withdrawal.userId,
        direction: TransactionDirection.DEBIT,
        amount: withdrawal.amountLamports,
        description: 'Withdrawal to wallet',
      },
      {
        poolAccountId: external.id,
        direction: TransactionDirection.CREDIT,
        amount: net,
        description: 'Net paid to wallet',
      },
    ];

    // A zero fee would be a zero-amount leg, which the ledger rejects.
    if (withdrawal.feeLamports > 0n) {
      legs.push({
        poolAccountId: treasuryAccount.id,
        direction: TransactionDirection.CREDIT,
        amount: withdrawal.feeLamports,
        description: 'Withdrawal fee',
      });
    }

    try {
      await postEntry(deps.prisma, {
        type: TransactionType.WITHDRAWAL,
        entryGroupId: randomUUID(),
        idempotencyKeyBase: `withdrawal:${withdrawal.id}`,
        withdrawalId: withdrawal.id,
        legs,
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'ALREADY_POSTED') throw error;
    }

    await releaseReservation(deps.prisma, withdrawal.userId, withdrawal.amountLamports);

    try {
      await deps.prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: WithdrawalStatus.CONFIRMED,
          txSignature: params.signature,
          confirmedAt: new Date(),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error, 'tx_signature')) {
        throw conflict('This transaction signature is already recorded');
      }
      throw error;
    }

    return { status: 'confirmed', signature: params.signature, net, fee: withdrawal.feeLamports };
  } finally {
    await release();
  }
}

/**
 * Marks a withdrawal failed and gives the reserved funds back.
 *
 * The release is the part that matters. Leaving the reservation in place would
 * quietly shrink the player's spendable balance forever, and the cause would be
 * invisible from the UI.
 */
async function failWithdrawal(
  prisma: PrismaClient,
  withdrawalId: string,
  userId: string,
  reservedAmount: bigint,
  reason: string,
): Promise<void> {
  await prisma.withdrawal.update({
    where: { id: withdrawalId },
    data: { status: WithdrawalStatus.FAILED, failureReason: reason },
  });
  await releaseReservation(prisma, userId, reservedAmount);
}

async function releaseReservation(
  prisma: PrismaClient,
  userId: string,
  amount: bigint,
): Promise<void> {
  const custody = await prisma.poolAccount.findUnique({
    where: { name: `custody:${userId}` },
    select: { id: true, reservedLamports: true },
  });
  if (!custody) return;

  // Clamp at zero: a double release must not create negative reserved funds,
  // which would inflate spendable balance.
  const next = custody.reservedLamports - amount;
  await prisma.poolAccount.update({
    where: { id: custody.id },
    data: { reservedLamports: next > 0n ? next : 0n },
  });
}

function describeFailure(failure: string | null): string {
  switch (failure) {
    case 'transaction-failed':
      return 'The on-chain transaction failed';
    case 'program-not-invoked':
      return 'Transaction did not invoke the arena program';
    case 'signer-mismatch':
      return 'Transaction was not signed by the withdrawal wallet';
    case 'amount-mismatch':
      return 'On-chain amounts did not match the requested withdrawal';
    case 'wrong-direction':
      return 'Transaction did not debit the custody vault';
    default:
      return 'Withdrawal could not be verified';
  }
}

/** Releases reservations for intents that were never signed. */
export async function expireStaleWithdrawals(
  prisma: PrismaClient,
  olderThan: Date,
): Promise<number> {
  const stale = await prisma.withdrawal.findMany({
    where: {
      status: { in: [WithdrawalStatus.APPROVED, WithdrawalStatus.REQUESTED] },
      txSignature: null,
      requestedAt: { lt: olderThan },
    },
    select: { id: true, userId: true, amountLamports: true },
  });

  for (const withdrawal of stale) {
    await failWithdrawal(
      prisma,
      withdrawal.id,
      withdrawal.userId,
      withdrawal.amountLamports,
      'Intent expired before a transaction was submitted',
    );
  }

  return stale.length;
}
