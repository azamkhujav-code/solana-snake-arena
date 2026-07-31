import type { PrismaClient } from '@arena/db';
import { DepositStatus, TransactionDirection, TransactionType } from '@arena/db';
import type { ArenaService } from '@arena/solana';
import { verifyDeposit } from '@arena/solana';
import { PublicKey } from '@solana/web3.js';
import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import {
  getOrCreateCustodyAccount,
  getSystemAccount,
  postEntry,
  isUniqueViolation,
} from './ledger.js';

const MIN_DEPOSIT_LAMPORTS = 10_000n;

/** How long a deposit intent stays valid before the reconciler expires it. */
export const DEPOSIT_INTENT_TTL_MS = 15 * 60 * 1000;

export interface DepositIntent {
  depositId: string;
  amount: bigint;
  poolAddress: string;
  programId: string;
  expiresAt: Date;
}

export interface DepositServiceDeps {
  prisma: PrismaClient;
  solana: ArenaService;
  /** Redis-backed lock. Returns a release function, or null if already held. */
  acquireLock: (key: string, ttlMs: number) => Promise<(() => Promise<void>) | null>;
}

/**
 * Creates a deposit intent.
 *
 * The intent exists so the confirm step has a server-side record of what was
 * expected. Without one, "confirm this signature" would have to trust a
 * client-supplied amount.
 */
export async function createDepositIntent(
  deps: DepositServiceDeps,
  params: { userId: string; walletId: string; amount: bigint },
): Promise<DepositIntent> {
  if (params.amount < MIN_DEPOSIT_LAMPORTS) {
    throw badRequest(`Minimum deposit is ${MIN_DEPOSIT_LAMPORTS} lamports`);
  }

  const { pool } = deps.solana.getVaultAddresses();
  const expiresAt = new Date(Date.now() + DEPOSIT_INTENT_TTL_MS);

  const deposit = await deps.prisma.deposit.create({
    data: {
      userId: params.userId,
      walletId: params.walletId,
      amountLamports: params.amount,
      status: DepositStatus.PENDING,
      idempotencyKey: `deposit:${randomUUID()}`,
    },
    select: { id: true },
  });

  return {
    depositId: deposit.id,
    amount: params.amount,
    poolAddress: pool.toBase58(),
    programId: deps.solana.programId.toBase58(),
    expiresAt,
  };
}

export type ConfirmOutcome =
  | { status: 'confirmed'; creditedLamports: bigint; signature: string }
  | { status: 'pending'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * Confirms a deposit against the chain and credits the custody balance.
 *
 * Defence in depth against double-crediting, in the order it applies:
 *
 *  1. A Redis lock serialises concurrent confirms of the same deposit.
 *  2. The status check rejects anything not still PENDING.
 *  3. `Deposit.txSignature` is unique, so the same on-chain transfer cannot be
 *     attached to two deposits — this is the constraint that holds even if the
 *     lock is lost.
 *  4. `Transaction.idempotencyKey` is unique, so the ledger entry cannot post
 *     twice even if everything above is bypassed.
 *
 * The amount is taken from the chain, never from the request.
 */
export async function confirmDeposit(
  deps: DepositServiceDeps,
  params: { userId: string; depositId: string; signature: string },
): Promise<ConfirmOutcome> {
  const release = await deps.acquireLock(`deposit:${params.depositId}`, 30_000);
  if (!release) {
    throw conflict('This deposit is already being confirmed');
  }

  try {
    const deposit = await deps.prisma.deposit.findUnique({
      where: { id: params.depositId },
      include: { wallet: { select: { address: true } } },
    });

    if (!deposit) throw notFound('Deposit');
    if (deposit.userId !== params.userId) {
      // Deliberately a 404, not a 403: confirming another user's deposit id
      // should not reveal that it exists.
      throw notFound('Deposit');
    }

    if (deposit.status === DepositStatus.CONFIRMED) {
      return {
        status: 'confirmed',
        creditedLamports: deposit.amountLamports,
        signature: deposit.txSignature ?? params.signature,
      };
    }
    if (deposit.status !== DepositStatus.PENDING) {
      throw conflict(`Deposit is ${deposit.status} and can no longer be confirmed`);
    }

    // A signature already recorded against another deposit is a replay.
    const existing = await deps.prisma.deposit.findUnique({
      where: { txSignature: params.signature },
      select: { id: true },
    });
    if (existing && existing.id !== deposit.id) {
      throw conflict('This transaction signature has already been credited');
    }

    const parsed = await deps.solana.getParsedTransaction(params.signature);
    if (!parsed) {
      // Not yet visible to this RPC. Leave PENDING for the reconciler.
      return { status: 'pending', reason: 'Transaction not yet visible on chain' };
    }

    const { pool } = deps.solana.getVaultAddresses();
    const result = verifyDeposit({
      transaction: parsed,
      programId: deps.solana.programId,
      pool,
      depositor: new PublicKey(deposit.wallet.address),
      expectedLamports: deposit.amountLamports,
    });

    if (!result.ok) {
      const reason = describeFailure(result.failure);
      await deps.prisma.deposit.update({
        where: { id: deposit.id },
        data: { status: DepositStatus.FAILED, failureReason: reason },
      });
      return { status: 'failed', reason };
    }

    const custody = await getOrCreateCustodyAccount(deps.prisma, deposit.userId);
    const external = await getSystemAccount(deps.prisma, 'external');

    // Credit exactly what the chain says moved, not what was requested.
    const credited = result.observedLamports;

    try {
      await postEntry(deps.prisma, {
        type: TransactionType.DEPOSIT,
        entryGroupId: randomUUID(),
        idempotencyKeyBase: `deposit:${deposit.id}`,
        depositId: deposit.id,
        legs: [
          {
            poolAccountId: external.id,
            direction: TransactionDirection.DEBIT,
            amount: credited,
            description: 'Deposit from wallet',
          },
          {
            poolAccountId: custody.id,
            userId: deposit.userId,
            direction: TransactionDirection.CREDIT,
            amount: credited,
            description: 'Deposit credited',
          },
        ],
      });
    } catch (error) {
      // Already posted: the ledger is correct, the row just needs marking.
      if (!(error instanceof AppError) || error.code !== 'ALREADY_POSTED') throw error;
    }

    try {
      await deps.prisma.deposit.update({
        where: { id: deposit.id },
        data: {
          status: DepositStatus.CONFIRMED,
          txSignature: params.signature,
          slot: BigInt(result.slot),
          confirmations: 1,
          confirmedAt: new Date(),
          poolAccountId: custody.id,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error, 'tx_signature')) {
        throw conflict('This transaction signature has already been credited');
      }
      throw error;
    }

    return { status: 'confirmed', creditedLamports: credited, signature: params.signature };
  } finally {
    await release();
  }
}

function describeFailure(failure: string | null): string {
  switch (failure) {
    case 'transaction-failed':
      return 'The on-chain transaction failed';
    case 'program-not-invoked':
      return 'Transaction did not invoke the arena program';
    case 'signer-mismatch':
      return 'Transaction was not signed by the deposit wallet';
    case 'amount-mismatch':
      return 'Transferred amount was less than the requested deposit';
    case 'wrong-direction':
      return 'Transaction did not credit the custody vault';
    default:
      return 'Deposit could not be verified';
  }
}

/** Expires stale intents so they stop appearing as pending in the UI. */
export async function expireStaleDeposits(prisma: PrismaClient, olderThan: Date): Promise<number> {
  const result = await prisma.deposit.updateMany({
    where: {
      status: DepositStatus.PENDING,
      txSignature: null,
      createdAt: { lt: olderThan },
    },
    data: {
      status: DepositStatus.EXPIRED,
      failureReason: 'No transaction was submitted before the intent expired',
    },
  });
  return result.count;
}

export { MIN_DEPOSIT_LAMPORTS };
export const DEPOSIT_RETRY_WINDOW_MS = config.NODE_ENV === 'test' ? 1_000 : 60_000;
