import type { PrismaClient } from '@arena/db';
import { DepositStatus, TransactionDirection, WithdrawalStatus } from '@arena/db';
import type { ArenaService } from '@arena/solana';
import type { FastifyBaseLogger } from 'fastify';

import { confirmDeposit, DEPOSIT_INTENT_TTL_MS, expireStaleDeposits } from './deposit.service.js';
import {
  confirmWithdrawal,
  expireStaleWithdrawals,
  WITHDRAWAL_INTENT_TTL_MS,
} from './withdrawal.service.js';

export interface ReconcilerDeps {
  prisma: PrismaClient;
  solana: ArenaService;
  acquireLock: (key: string, ttlMs: number) => Promise<(() => Promise<void>) | null>;
  withdrawalFeeBps: number;
  log: FastifyBaseLogger;
}

export interface ReconcileReport {
  depositsRecovered: number;
  depositsExpired: number;
  withdrawalsRecovered: number;
  withdrawalsExpired: number;
  ledgerBalanced: boolean;
  ledgerDrift: bigint;
}

/**
 * Failed-transaction recovery.
 *
 * A client can drop out at any point — the browser closes between sending a
 * transaction and calling confirm, or confirm fires while the RPC has not yet
 * indexed the signature. Either way the money moved on chain but the database
 * does not know. This job closes that gap, which is why the confirm endpoint is
 * allowed to return `pending` rather than having to block.
 *
 * Every step is idempotent, so running it concurrently with a client confirm is
 * safe: whichever gets there first posts the ledger entry, and the other hits
 * the idempotency constraint.
 */
export async function reconcileOnce(deps: ReconcilerDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    depositsRecovered: 0,
    depositsExpired: 0,
    withdrawalsRecovered: 0,
    withdrawalsExpired: 0,
    ledgerBalanced: true,
    ledgerDrift: 0n,
  };

  // ---- Deposits that have a signature but never confirmed -----------------
  const pendingDeposits = await deps.prisma.deposit.findMany({
    where: { status: DepositStatus.PENDING, txSignature: { not: null } },
    select: { id: true, userId: true, txSignature: true },
    take: 100,
  });

  for (const deposit of pendingDeposits) {
    if (!deposit.txSignature) continue;
    try {
      const outcome = await confirmDeposit(deps, {
        userId: deposit.userId,
        depositId: deposit.id,
        signature: deposit.txSignature,
      });
      if (outcome.status === 'confirmed') report.depositsRecovered += 1;
    } catch (error) {
      deps.log.warn({ err: error, depositId: deposit.id }, 'deposit reconcile failed');
    }
  }

  // ---- Withdrawals submitted but not confirmed ----------------------------
  const pendingWithdrawals = await deps.prisma.withdrawal.findMany({
    where: { status: WithdrawalStatus.SUBMITTED, txSignature: { not: null } },
    select: { id: true, userId: true, txSignature: true },
    take: 100,
  });

  for (const withdrawal of pendingWithdrawals) {
    if (!withdrawal.txSignature) continue;
    try {
      const outcome = await confirmWithdrawal(deps, {
        userId: withdrawal.userId,
        withdrawalId: withdrawal.id,
        signature: withdrawal.txSignature,
      });
      if (outcome.status === 'confirmed') report.withdrawalsRecovered += 1;
    } catch (error) {
      deps.log.warn({ err: error, withdrawalId: withdrawal.id }, 'withdrawal reconcile failed');
    }
  }

  // ---- Expire abandoned intents -------------------------------------------
  report.depositsExpired = await expireStaleDeposits(
    deps.prisma,
    new Date(Date.now() - DEPOSIT_INTENT_TTL_MS),
  );
  report.withdrawalsExpired = await expireStaleWithdrawals(
    deps.prisma,
    new Date(Date.now() - WITHDRAWAL_INTENT_TTL_MS),
  );

  // ---- Ledger invariant ----------------------------------------------------
  const check = await checkLedgerInvariant(deps.prisma);
  report.ledgerBalanced = check.balanced;
  report.ledgerDrift = check.drift;

  if (!check.balanced) {
    // This is the tripwire for a ledger bug. It should never fire, and if it
    // does, no amount of retrying fixes it — a human has to look.
    deps.log.error(
      { drift: check.drift.toString() },
      'LEDGER INVARIANT VIOLATED: pool balances do not match posted transactions',
    );
  }

  return report;
}

/**
 * Asserts that the sum of pool balances equals the net of all posted entries.
 *
 * This is the check the whole double-entry design exists to make possible. If
 * user balances lived on the `users` table they would sit outside the ledger
 * and could drift with nothing to detect it.
 */
export async function checkLedgerInvariant(
  prisma: PrismaClient,
): Promise<{ balanced: boolean; drift: bigint; poolTotal: bigint; ledgerTotal: bigint }> {
  const pools = await prisma.poolAccount.findMany({ select: { balanceLamports: true } });
  const poolTotal = pools.reduce((sum, pool) => sum + pool.balanceLamports, 0n);

  const grouped = await prisma.transaction.groupBy({
    by: ['direction'],
    where: { status: 'POSTED' },
    _sum: { amountLamports: true },
  });

  let ledgerTotal = 0n;
  for (const row of grouped) {
    const amount = row._sum.amountLamports ?? 0n;
    ledgerTotal += row.direction === TransactionDirection.CREDIT ? amount : -amount;
  }

  const drift = poolTotal - ledgerTotal;
  return { balanced: drift === 0n, drift, poolTotal, ledgerTotal };
}

/**
 * Runs the reconciler on an interval.
 *
 * Deliberately not a cron inside the request-serving process at scale — this is
 * a convenience for single-instance deployments. With several gateway replicas,
 * run it as its own job so N replicas do not all sweep the same rows.
 */
export function startReconciler(deps: ReconcilerDeps, intervalMs = 30_000): { stop: () => void } {
  let running = false;

  const timer = setInterval(() => {
    if (running) return; // never overlap runs
    running = true;

    void reconcileOnce(deps)
      .then((report) => {
        if (
          report.depositsRecovered ||
          report.withdrawalsRecovered ||
          report.depositsExpired ||
          report.withdrawalsExpired
        ) {
          deps.log.info(report, 'reconciler pass complete');
        }
      })
      .catch((error: unknown) => deps.log.error({ err: error }, 'reconciler pass failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref();
  return { stop: () => clearInterval(timer) };
}
