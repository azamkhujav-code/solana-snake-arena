import {
  DepositStatus,
  GameStatus,
  type PrismaClient,
  SettlementStatus,
  TransactionType,
  UserStatus,
  WithdrawalStatus,
} from '@arena/db';

import { type PoolTotals } from './admin-treasury.js';

/**
 * Dashboard statistics.
 *
 * Every query here is bounded by an indexed time column. The temptation on an
 * admin page is to write `count(*)` over the ledger and move on — that is fine
 * on a laptop and a full table scan in production, on a page that auto-refreshes.
 */

export interface StatsAlert {
  severity: 'warn' | 'critical';
  code: string;
  message: string;
  count: number;
}

export interface AlertInputs {
  failedSettlements: number;
  stuckWithdrawals: number;
  ledgerBalanced: boolean;
  custodySolvent: boolean | null;
  imbalancedGroups: number;
}

/**
 * Turns raw counts into the alert list.
 *
 * Pure, and separated from the queries, because the thresholds are a judgement
 * call worth reviewing on its own: what deserves to interrupt someone's evening
 * versus what can wait for morning.
 *
 * Only genuine problems are emitted. A dashboard that always shows warnings
 * trains its operators to ignore warnings, and then the real one scrolls past.
 */
export function deriveAlerts(inputs: AlertInputs): StatsAlert[] {
  const alerts: StatsAlert[] = [];

  // Insolvency first: it is the only condition where the correct response is to
  // stop taking deposits.
  if (inputs.custodySolvent === false) {
    alerts.push({
      severity: 'critical',
      code: 'CUSTODY_INSOLVENT',
      message: 'On-chain pool is below what the platform owes players',
      count: 1,
    });
  }

  if (!inputs.ledgerBalanced) {
    alerts.push({
      severity: 'critical',
      code: 'LEDGER_DRIFT',
      message: 'Pool balances do not match the posted ledger',
      count: 1,
    });
  }

  if (inputs.imbalancedGroups > 0) {
    alerts.push({
      severity: 'critical',
      code: 'ENTRY_GROUP_IMBALANCED',
      message: 'Transfer legs that do not sum to zero',
      count: inputs.imbalancedGroups,
    });
  }

  // A failed settlement is money owed to a winner that never arrived. It is not
  // critical because it is recoverable by retrying, but it is the complaint an
  // operator will hear about first.
  if (inputs.failedSettlements > 0) {
    alerts.push({
      severity: 'warn',
      code: 'SETTLEMENT_FAILED',
      message: 'Games whose payout failed and needs a retry',
      count: inputs.failedSettlements,
    });
  }

  if (inputs.stuckWithdrawals > 0) {
    alerts.push({
      severity: 'warn',
      code: 'WITHDRAWAL_STUCK',
      message: 'Withdrawals awaiting manual review',
      count: inputs.stuckWithdrawals,
    });
  }

  return alerts;
}

export interface StatsWindow {
  from: Date;
  to: Date;
  hours: number;
}

/** Resolves the reporting window, defaulting to the last 24 hours. */
export function resolveWindow(from: string | undefined, to: string | undefined): StatsWindow {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const hours = Math.max(1, Math.round((end.getTime() - start.getTime()) / 3_600_000));

  return { from: start, to: end, hours };
}

export interface MoneyFlow {
  deposited: bigint;
  withdrawn: bigint;
  wagered: bigint;
  rake: bigint;
  net: bigint;
}

/**
 * Money movement over the window.
 *
 * Read from the ledger rather than from the deposits/withdrawals tables: those
 * hold intents, many of which never became money. The ledger only contains
 * movements that actually happened, which is the number an operator is asking
 * for when they ask how much came in today.
 */
export async function sumMoneyFlow(prisma: PrismaClient, window: StatsWindow): Promise<MoneyFlow> {
  const rows = await prisma.transaction.groupBy({
    by: ['type'],
    where: {
      status: 'POSTED',
      createdAt: { gte: window.from, lt: window.to },
      type: {
        in: [
          TransactionType.DEPOSIT,
          TransactionType.WITHDRAWAL,
          TransactionType.ENTRY_FEE,
          TransactionType.RAKE,
        ],
      },
      // One leg per movement, not both. Every transfer has a credit and a debit,
      // so summing all legs of a deposit would double-count it.
      direction: 'CREDIT',
    },
    _sum: { amountLamports: true },
  });

  const byType = new Map(rows.map((row) => [row.type, row._sum.amountLamports ?? 0n]));

  const deposited = byType.get(TransactionType.DEPOSIT) ?? 0n;
  const withdrawn = byType.get(TransactionType.WITHDRAWAL) ?? 0n;

  return {
    deposited,
    withdrawn,
    wagered: byType.get(TransactionType.ENTRY_FEE) ?? 0n,
    rake: byType.get(TransactionType.RAKE) ?? 0n,
    net: deposited - withdrawn,
  };
}

export interface PlayerCounts {
  total: number;
  active: number;
  newInWindow: number;
  banned: number;
}

export async function countPlayers(
  prisma: PrismaClient,
  window: StatsWindow,
): Promise<PlayerCounts> {
  const [total, active, newInWindow, banned] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null } }),
    // "Active" means seen in the window, not `status = ACTIVE` — an operator
    // asking how many players are active means people, not rows.
    prisma.user.count({ where: { deletedAt: null, lastSeenAt: { gte: window.from } } }),
    prisma.user.count({ where: { createdAt: { gte: window.from, lt: window.to } } }),
    prisma.user.count({
      where: { status: { in: [UserStatus.BANNED, UserStatus.SHADOWBANNED] } },
    }),
  ]);

  return { total, active, newInWindow, banned };
}

export interface GameCounts {
  inWindow: number;
  running: number;
  awaitingSettlement: number;
  failedSettlement: number;
}

export async function countGames(prisma: PrismaClient, window: StatsWindow): Promise<GameCounts> {
  const [inWindow, running, awaitingSettlement, failedSettlement] = await Promise.all([
    prisma.game.count({ where: { startedAt: { gte: window.from, lt: window.to } } }),
    prisma.game.count({ where: { status: GameStatus.RUNNING } }),
    prisma.game.count({
      where: { status: GameStatus.COMPLETED, settlementStatus: SettlementStatus.PENDING },
    }),
    prisma.game.count({ where: { settlementStatus: SettlementStatus.FAILED } }),
  ]);

  return { inWindow, running, awaitingSettlement, failedSettlement };
}

/** Withdrawals held for review, plus deposits stuck mid-flight. */
export async function countStuck(prisma: PrismaClient): Promise<number> {
  const [review, pending] = await Promise.all([
    prisma.withdrawal.count({ where: { status: WithdrawalStatus.PENDING_REVIEW } }),
    prisma.deposit.count({
      where: {
        status: DepositStatus.PENDING,
        txSignature: { not: null },
        // Only genuinely stuck ones. A deposit submitted 30 seconds ago is
        // simply in flight, and flagging it would make the alert meaningless.
        createdAt: { lt: new Date(Date.now() - 15 * 60 * 1000) },
      },
    }),
  ]);

  return review + pending;
}

/** Shapes pool totals into the custody block of the stats response. */
export function custodyBreakdown(pools: PoolTotals) {
  return {
    playerBalances: pools.playerCustody.toString(),
    treasury: pools.treasury.toString(),
    rake: pools.rake.toString(),
    rewards: pools.rewards.toString(),
    escrowed: pools.escrow.toString(),
  };
}
