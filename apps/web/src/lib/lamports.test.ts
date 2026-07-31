import { describe, expect, it } from 'vitest';

import {
  formatLamports,
  formatRelativeTime,
  formatSol,
  formatTimestamp,
  isNonZero,
  parseLamports,
  sumLamports,
} from './lamports';

describe('parseLamports', () => {
  it('parses positive and negative integer strings', () => {
    expect(parseLamports('1000')).toBe(1000n);
    expect(parseLamports('-1000')).toBe(-1000n);
    expect(parseLamports('0')).toBe(0n);
  });

  it('returns null for anything that is not an integer string', () => {
    // A dashboard cell showing an em-dash beats a component tree that unmounts
    // because one row came back null.
    expect(parseLamports(null)).toBeNull();
    expect(parseLamports(undefined)).toBeNull();
    expect(parseLamports('')).toBeNull();
    expect(parseLamports('1.5')).toBeNull();
    expect(parseLamports('1e9')).toBeNull();
    expect(parseLamports('abc')).toBeNull();
  });
});

describe('formatSol', () => {
  it('converts whole SOL without trailing zeros', () => {
    expect(formatSol('1000000000')).toBe('1');
    expect(formatSol('2000000000')).toBe('2');
  });

  it('shows only the decimals that are non-zero', () => {
    expect(formatSol('1500000000')).toBe('1.5');
    expect(formatSol('1050000000')).toBe('1.05');
  });

  it('truncates rather than rounds', () => {
    // An operator comparing against the chain must never see more than what is
    // actually there. 0.99999 SOL displayed as "1" would be a lie.
    expect(formatSol('999999999', { maxDecimals: 2 })).toBe('0.99');
    expect(formatSol('1999999999', { maxDecimals: 0 })).toBe('1');
  });

  it('keeps full precision above Number.MAX_SAFE_INTEGER', () => {
    // The whole reason this does bigint arithmetic. 10,000,000 SOL is
    // 10^16 lamports — past 2^53, where Number(x)/1e9 starts rounding.
    expect(formatSol('10000000000000001', { maxDecimals: 9 })).toBe('10,000,000.000000001');
  });

  it('does not lose a one-lamport difference in a huge balance', () => {
    // Exactly the case that makes a drift figure untrustworthy: two balances
    // that differ by one lamport must not render identically.
    const a = formatSol('9007199254740993000', { maxDecimals: 9 });
    const b = formatSol('9007199254740993001', { maxDecimals: 9 });

    expect(a).not.toBe(b);
  });

  it('groups thousands', () => {
    expect(formatSol('1234567000000000')).toBe('1,234,567');
  });

  it('renders negatives with a leading minus', () => {
    // The EXTERNAL pool account is legitimately negative, as is any drift.
    expect(formatSol('-1500000000')).toBe('-1.5');
  });

  it('adds an explicit plus only when asked and only when positive', () => {
    expect(formatSol('1500000000', { sign: true })).toBe('+1.5');
    expect(formatSol('-1500000000', { sign: true })).toBe('-1.5');
    expect(formatSol('0', { sign: true })).toBe('0');
  });

  it('renders sub-lamport-precision dust as zero rather than empty', () => {
    expect(formatSol('1', { maxDecimals: 4 })).toBe('0');
  });

  it('falls back to an em-dash on junk', () => {
    expect(formatSol(null)).toBe('—');
    expect(formatSol('not-a-number')).toBe('—');
  });

  it('accepts a bigint directly', () => {
    expect(formatSol(1_500_000_000n)).toBe('1.5');
  });
});

describe('formatLamports', () => {
  it('groups the exact lamport count', () => {
    expect(formatLamports('1234567890')).toBe('1,234,567,890');
    expect(formatLamports('-1234567890')).toBe('-1,234,567,890');
  });

  it('does not group below a thousand', () => {
    expect(formatLamports('999')).toBe('999');
  });
});

describe('isNonZero', () => {
  it('treats zero and junk as not-a-problem', () => {
    // Drift of zero is the healthy case and must not be styled as an alert.
    expect(isNonZero('0')).toBe(false);
    expect(isNonZero(null)).toBe(false);
    expect(isNonZero('garbage')).toBe(false);
  });

  it('flags any non-zero figure, including negatives', () => {
    expect(isNonZero('1')).toBe(true);
    expect(isNonZero('-1')).toBe(true);
  });
});

describe('sumLamports', () => {
  it('sums exactly, past the float boundary', () => {
    expect(sumLamports(['9007199254740993', '1'])).toBe(9_007_199_254_740_994n);
  });

  it('skips unparseable entries instead of poisoning the total', () => {
    expect(sumLamports(['100', null, 'junk', '50'])).toBe(150n);
  });

  it('returns zero for an empty column', () => {
    expect(sumLamports([])).toBe(0n);
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-07-31T12:00:00.000Z');

  it('describes recent past events', () => {
    expect(formatRelativeTime('2026-07-31T11:57:00.000Z', now)).toBe('3 minutes ago');
    expect(formatRelativeTime('2026-07-31T09:00:00.000Z', now)).toBe('3 hours ago');
    expect(formatRelativeTime('2026-07-28T12:00:00.000Z', now)).toBe('3 days ago');
  });

  it('handles the future without inverting the wording', () => {
    expect(formatRelativeTime('2026-07-31T12:05:00.000Z', now)).toBe('in 5 minutes');
  });

  it('falls back to an em-dash on missing or invalid input', () => {
    expect(formatRelativeTime(null, now)).toBe('—');
    expect(formatRelativeTime('not a date', now)).toBe('—');
  });
});

describe('formatTimestamp', () => {
  it('renders UTC to the second', () => {
    // What you paste into an incident report — no timezone ambiguity.
    expect(formatTimestamp('2026-07-31T12:34:56.789Z')).toBe('2026-07-31 12:34:56');
  });

  it('falls back to an em-dash on junk', () => {
    expect(formatTimestamp('nope')).toBe('—');
    expect(formatTimestamp(null)).toBe('—');
  });
});
