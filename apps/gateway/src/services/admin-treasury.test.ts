import { PoolAccountKind, TransactionDirection } from '@arena/db';
import { describe, expect, it } from 'vitest';

import {
  custodyCoverage,
  findImbalancedGroups,
  signedAmount,
  sumPoolsByKind,
} from './admin-treasury.js';

const { CREDIT, DEBIT } = TransactionDirection;

describe('sumPoolsByKind', () => {
  it('buckets balances by account kind', () => {
    const totals = sumPoolsByKind([
      { kind: PoolAccountKind.USER_CUSTODY, balance: 100n },
      { kind: PoolAccountKind.USER_CUSTODY, balance: 50n },
      { kind: PoolAccountKind.GAME_ESCROW, balance: 30n },
      { kind: PoolAccountKind.TREASURY, balance: 700n },
      { kind: PoolAccountKind.RAKE, balance: 20n },
      { kind: PoolAccountKind.REWARDS, balance: 10n },
    ]);

    expect(totals.playerCustody).toBe(150n);
    expect(totals.escrow).toBe(30n);
    expect(totals.treasury).toBe(700n);
    expect(totals.rake).toBe(20n);
    expect(totals.rewards).toBe(10n);
    expect(totals.total).toBe(910n);
  });

  it('carries the negative EXTERNAL balance into the total', () => {
    // EXTERNAL mirrors net inflow, so it is negative when players have deposited
    // more than they have withdrawn. Excluding it from the total would make the
    // grand total stop equalling the ledger, which is the one thing it must do.
    const totals = sumPoolsByKind([
      { kind: PoolAccountKind.USER_CUSTODY, balance: 500n },
      { kind: PoolAccountKind.EXTERNAL, balance: -500n },
    ]);

    expect(totals.external).toBe(-500n);
    expect(totals.total).toBe(0n);
  });

  it('returns zeroes for no accounts rather than throwing', () => {
    const totals = sumPoolsByKind([]);
    expect(totals.total).toBe(0n);
    expect(totals.playerCustody).toBe(0n);
  });
});

describe('custodyCoverage', () => {
  it('counts escrow as owed, not as headroom', () => {
    // Mid-match, 400 of the 1000 owed is locked in escrow. The vault holds
    // exactly the total, so the platform is solvent — a version that ignored
    // escrow would report 600 of spare coverage that does not exist.
    const result = custodyCoverage(1000n, { playerCustody: 600n, escrow: 400n });

    expect(result.coverage).toBe(0n);
    expect(result.solvent).toBe(true);
  });

  it('reports a shortfall as negative coverage', () => {
    const result = custodyCoverage(900n, { playerCustody: 600n, escrow: 400n });

    expect(result.coverage).toBe(-100n);
    expect(result.solvent).toBe(false);
  });

  it('treats surplus as solvent', () => {
    const result = custodyCoverage(1500n, { playerCustody: 600n, escrow: 400n });

    expect(result.coverage).toBe(500n);
    expect(result.solvent).toBe(true);
  });

  it('reports unknown rather than insolvent when the chain is unreachable', () => {
    // The failure that matters: rendering an RPC outage as a shortfall would
    // page someone at 3am for a network blip.
    const result = custodyCoverage(null, { playerCustody: 600n, escrow: 400n });

    expect(result.coverage).toBeNull();
    expect(result.solvent).toBeNull();
  });
});

describe('signedAmount', () => {
  it('makes credits positive and debits negative', () => {
    expect(signedAmount(CREDIT, 100n)).toBe(100n);
    expect(signedAmount(DEBIT, 100n)).toBe(-100n);
  });
});

describe('findImbalancedGroups', () => {
  it('accepts a transfer whose legs cancel', () => {
    const drifts = findImbalancedGroups([
      { entryGroupId: 'g1', direction: DEBIT, amount: 500n },
      { entryGroupId: 'g1', direction: CREDIT, amount: 500n },
    ]);

    expect(drifts).toEqual([]);
  });

  it('accepts a multi-leg transfer that still nets to zero', () => {
    // A settlement: escrow pays out to two winners and the rake account.
    const drifts = findImbalancedGroups([
      { entryGroupId: 'g1', direction: DEBIT, amount: 1000n },
      { entryGroupId: 'g1', direction: CREDIT, amount: 600n },
      { entryGroupId: 'g1', direction: CREDIT, amount: 300n },
      { entryGroupId: 'g1', direction: CREDIT, amount: 100n },
    ]);

    expect(drifts).toEqual([]);
  });

  it('reports the drift on an unbalanced group', () => {
    const drifts = findImbalancedGroups([
      { entryGroupId: 'g1', direction: DEBIT, amount: 1000n },
      { entryGroupId: 'g1', direction: CREDIT, amount: 900n },
    ]);

    expect(drifts).toEqual([{ entryGroupId: 'g1', drift: -100n }]);
  });

  it('does not let two broken groups hide each other', () => {
    // This is the case the global pool-vs-ledger check misses entirely: +100 in
    // one group and -100 in another sum to zero platform-wide, so only a
    // per-group scan finds them.
    const drifts = findImbalancedGroups([
      { entryGroupId: 'g1', direction: CREDIT, amount: 100n },
      { entryGroupId: 'g2', direction: DEBIT, amount: 100n },
    ]);

    expect(drifts).toHaveLength(2);
    expect(drifts.map((d) => d.drift).reduce((a, b) => a + b, 0n)).toBe(0n);
  });

  it('orders by absolute drift, largest first', () => {
    const drifts = findImbalancedGroups([
      { entryGroupId: 'small', direction: CREDIT, amount: 5n },
      { entryGroupId: 'huge', direction: DEBIT, amount: 9_000n },
      { entryGroupId: 'medium', direction: CREDIT, amount: 100n },
    ]);

    // Sorted by magnitude, so the debit of 9000 outranks the credit of 100 even
    // though it is the more negative number.
    expect(drifts.map((d) => d.entryGroupId)).toEqual(['huge', 'medium', 'small']);
  });

  it('separates groups that share leg amounts', () => {
    const drifts = findImbalancedGroups([
      { entryGroupId: 'g1', direction: DEBIT, amount: 100n },
      { entryGroupId: 'g2', direction: CREDIT, amount: 100n },
      { entryGroupId: 'g1', direction: CREDIT, amount: 100n },
      { entryGroupId: 'g2', direction: DEBIT, amount: 100n },
    ]);

    expect(drifts).toEqual([]);
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER', () => {
    // Lamport totals exceed 2^53 above ~9M SOL. Any accidental Number
    // conversion in this arithmetic would silently round, and a rounded audit
    // is worse than none.
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const drifts = findImbalancedGroups([
      { entryGroupId: 'g1', direction: DEBIT, amount: huge },
      { entryGroupId: 'g1', direction: CREDIT, amount: huge - 1n },
    ]);

    expect(drifts).toEqual([{ entryGroupId: 'g1', drift: -1n }]);
  });

  it('returns nothing for an empty ledger', () => {
    expect(findImbalancedGroups([])).toEqual([]);
  });
});
