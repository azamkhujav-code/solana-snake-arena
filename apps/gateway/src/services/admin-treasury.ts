import { PoolAccountKind, type PrismaClient, TransactionDirection } from '@arena/db';
import type { ArenaService } from '@arena/solana';

/**
 * Treasury reconciliation.
 *
 * Three independent numbers have to agree, and the value of this page is
 * entirely in noticing when they do not:
 *
 *   1. What the chain actually holds in the vault PDAs.
 *   2. What the pool-account balances say the platform holds.
 *   3. What the sum of posted ledger entries says.
 *
 * (2) and (3) disagreeing is a software bug — a balance was written without a
 * matching entry, or vice versa. (1) falling below player custody is worse: it
 * means the platform cannot honour withdrawals, which is insolvency whether or
 * not anyone has noticed yet.
 *
 * The arithmetic is split out as pure functions because it is the part that can
 * be wrong in a way that looks right, and it is not worth a database to test.
 */

export interface PoolTotals {
  playerCustody: bigint;
  escrow: bigint;
  treasury: bigint;
  rake: bigint;
  rewards: bigint;
  external: bigint;
  /** Every pool summed, EXTERNAL included. */
  total: bigint;
}

const ZERO_TOTALS: PoolTotals = {
  playerCustody: 0n,
  escrow: 0n,
  treasury: 0n,
  rake: 0n,
  rewards: 0n,
  external: 0n,
  total: 0n,
};

/** Buckets pool balances by kind. Pure so the mapping can be tested directly. */
export function sumPoolsByKind(
  rows: readonly { kind: PoolAccountKind; balance: bigint }[],
): PoolTotals {
  const totals: PoolTotals = { ...ZERO_TOTALS };

  for (const row of rows) {
    switch (row.kind) {
      case PoolAccountKind.USER_CUSTODY:
        totals.playerCustody += row.balance;
        break;
      case PoolAccountKind.GAME_ESCROW:
        totals.escrow += row.balance;
        break;
      case PoolAccountKind.TREASURY:
        totals.treasury += row.balance;
        break;
      case PoolAccountKind.RAKE:
        totals.rake += row.balance;
        break;
      case PoolAccountKind.REWARDS:
        totals.rewards += row.balance;
        break;
      case PoolAccountKind.EXTERNAL:
        totals.external += row.balance;
        break;
    }
    totals.total += row.balance;
  }

  return totals;
}

/**
 * Whether the on-chain pool covers what the platform owes players.
 *
 * Money owed is custody **plus escrow**: lamports locked in an in-flight game
 * are still a player's, they are simply committed. Counting only custody would
 * make the platform look solvent during a match and insolvent the moment it
 * ended, which inverts when the alarm should fire.
 *
 * Returns null when the chain balance is unknown — an RPC outage is not
 * evidence of insolvency, and rendering it as a shortfall would produce a false
 * alarm at the worst moment.
 */
export function custodyCoverage(
  onchainPool: bigint | null,
  totals: Pick<PoolTotals, 'playerCustody' | 'escrow'>,
): { coverage: bigint | null; solvent: boolean | null } {
  if (onchainPool === null) return { coverage: null, solvent: null };

  const owed = totals.playerCustody + totals.escrow;
  const coverage = onchainPool - owed;

  // Exactly zero is solvent: the vault holding precisely what is owed is the
  // ideal, not a boundary failure.
  return { coverage, solvent: coverage >= 0n };
}

/** Signs a ledger amount by its direction so a column of them can be summed. */
export function signedAmount(direction: TransactionDirection, amount: bigint): bigint {
  return direction === TransactionDirection.CREDIT ? amount : -amount;
}

export interface EntryGroupDrift {
  entryGroupId: string;
  drift: bigint;
}

/**
 * Finds entry groups whose legs do not sum to zero.
 *
 * The global invariant (`pool total == ledger total`) says *whether* the books
 * are broken; this says *where*. Both can be satisfied at once by two errors
 * that cancel out, so the global check alone is not enough — and a single
 * malformed group is far easier to fix the day it appears than a year later.
 */
export function findImbalancedGroups(
  legs: readonly { entryGroupId: string; direction: TransactionDirection; amount: bigint }[],
): EntryGroupDrift[] {
  const byGroup = new Map<string, bigint>();

  for (const leg of legs) {
    const current = byGroup.get(leg.entryGroupId) ?? 0n;
    byGroup.set(leg.entryGroupId, current + signedAmount(leg.direction, leg.amount));
  }

  const drifts: EntryGroupDrift[] = [];
  for (const [entryGroupId, drift] of byGroup) {
    if (drift !== 0n) drifts.push({ entryGroupId, drift });
  }

  // Largest absolute drift first — with a long list, the biggest discrepancy is
  // where an operator should start.
  drifts.sort((a, b) => {
    const left = a.drift < 0n ? -a.drift : a.drift;
    const right = b.drift < 0n ? -b.drift : b.drift;
    return left === right ? a.entryGroupId.localeCompare(b.entryGroupId) : right > left ? 1 : -1;
  });

  return drifts;
}

export interface TreasurySnapshot {
  onchain: {
    treasuryLamports: bigint | null;
    poolLamports: bigint | null;
    fetchedAt: Date | null;
    error: string | null;
  };
  pools: PoolTotals;
  ledgerTotal: bigint;
  ledgerDrift: bigint;
  ledgerBalanced: boolean;
  custodyCoverage: bigint | null;
  custodySolvent: boolean | null;
  imbalancedGroups: EntryGroupDrift[];
}

/**
 * Assembles the treasury view.
 *
 * The imbalanced-group scan is bounded to a recent window. Scanning the whole
 * ledger would be a table scan on a page an operator refreshes, and a group
 * that has been broken for six months is not going to be discovered by a
 * dashboard — it needs the offline audit job. What this catches is the case
 * that matters operationally: something broke in the last few hours.
 */
export async function buildTreasurySnapshot(
  prisma: PrismaClient,
  solana: ArenaService,
  options: { groupScanSince: Date; maxGroups?: number } = {
    groupScanSince: new Date(Date.now() - 24 * 60 * 60 * 1000),
  },
): Promise<TreasurySnapshot> {
  const [poolRows, directionTotals, recentLegs, chain] = await Promise.all([
    prisma.poolAccount.groupBy({
      by: ['kind'],
      _sum: { balanceLamports: true },
    }),
    prisma.transaction.groupBy({
      by: ['direction'],
      where: { status: 'POSTED' },
      _sum: { amountLamports: true },
    }),
    prisma.transaction.findMany({
      where: { status: 'POSTED', createdAt: { gte: options.groupScanSince } },
      select: { entryGroupId: true, direction: true, amountLamports: true },
      take: 50_000,
    }),
    // A chain read must not take the page down with it; the UI renders the
    // off-chain half regardless and shows the RPC error in place of the rest.
    solana
      .getVaultBalances()
      .then((balances) => ({ balances, error: null as string | null }))
      .catch((error: unknown) => ({
        balances: null,
        error: error instanceof Error ? error.message : 'RPC unavailable',
      })),
  ]);

  const pools = sumPoolsByKind(
    poolRows.map((row) => ({ kind: row.kind, balance: row._sum.balanceLamports ?? 0n })),
  );

  let ledgerTotal = 0n;
  for (const row of directionTotals) {
    ledgerTotal += signedAmount(row.direction, row._sum.amountLamports ?? 0n);
  }

  const onchainPool = chain.balances?.pool ?? null;
  const { coverage, solvent } = custodyCoverage(onchainPool, pools);
  const ledgerDrift = pools.total - ledgerTotal;

  const imbalanced = findImbalancedGroups(
    recentLegs.map((leg) => ({
      entryGroupId: leg.entryGroupId,
      direction: leg.direction,
      amount: leg.amountLamports,
    })),
  ).slice(0, options.maxGroups ?? 50);

  return {
    onchain: {
      treasuryLamports: chain.balances?.treasury ?? null,
      poolLamports: onchainPool,
      fetchedAt: chain.balances ? new Date() : null,
      error: chain.error,
    },
    pools,
    ledgerTotal,
    ledgerDrift,
    ledgerBalanced: ledgerDrift === 0n,
    custodyCoverage: coverage,
    custodySolvent: solvent,
    imbalancedGroups: imbalanced,
  };
}
