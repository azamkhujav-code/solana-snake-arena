import { TransactionDirection } from '@arena/db';
import { describe, expect, it } from 'vitest';

import { assertBalanced, LedgerImbalanceError, spendable, type LedgerLeg } from './ledger.js';

const credit = (amount: bigint): LedgerLeg => ({
  poolAccountId: 'a',
  direction: TransactionDirection.CREDIT,
  amount,
});
const debit = (amount: bigint): LedgerLeg => ({
  poolAccountId: 'b',
  direction: TransactionDirection.DEBIT,
  amount,
});

describe('assertBalanced', () => {
  it('accepts a two-leg entry that nets to zero', () => {
    expect(assertBalanced([debit(1_000n), credit(1_000n)])).toEqual({
      credits: 1_000n,
      debits: 1_000n,
    });
  });

  it('accepts a multi-leg entry, as a withdrawal with a fee produces', () => {
    // debit gross 1_000_000; credit net 990_000 + fee 10_000.
    expect(() =>
      assertBalanced([debit(1_000_000n), credit(990_000n), credit(10_000n)]),
    ).not.toThrow();
  });

  it('rejects an entry that invents money', () => {
    // This is the check standing between a bug and minting lamports.
    expect(() => assertBalanced([debit(1_000n), credit(1_001n)])).toThrow(LedgerImbalanceError);
  });

  it('rejects an entry that destroys money', () => {
    expect(() => assertBalanced([debit(1_000n), credit(999n)])).toThrow(LedgerImbalanceError);
  });

  it('rejects a single-sided entry', () => {
    expect(() => assertBalanced([credit(1_000n)])).toThrow(LedgerImbalanceError);
    expect(() => assertBalanced([])).toThrow(LedgerImbalanceError);
  });

  it('rejects a zero or negative leg', () => {
    // A zero leg balances arithmetically but records a movement that did not
    // happen; a negative one would make `direction` meaningless.
    expect(() => assertBalanced([debit(0n), credit(0n)])).toThrow();
    expect(() => assertBalanced([debit(-5n), credit(-5n)])).toThrow();
  });

  it('stays exact for amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 10_000_000n * 1_000_000_000n; // 10M SOL
    expect(() => assertBalanced([debit(huge), credit(huge)])).not.toThrow();
    // A float-based sum would consider these equal.
    expect(() => assertBalanced([debit(huge), credit(huge + 1n)])).toThrow(LedgerImbalanceError);
  });
});

describe('spendable', () => {
  it('subtracts reserved funds from the balance', () => {
    expect(spendable({ balanceLamports: 1_000n, reservedLamports: 400n })).toBe(600n);
  });

  it('is zero when everything is reserved', () => {
    expect(spendable({ balanceLamports: 1_000n, reservedLamports: 1_000n })).toBe(0n);
  });

  it('clamps at zero rather than reporting a negative spendable balance', () => {
    // Over-reservation is a bug, but reporting a negative number here would
    // make comparisons like `spendable >= amount` behave unpredictably.
    expect(spendable({ balanceLamports: 100n, reservedLamports: 500n })).toBe(0n);
  });
});
