import { describe, expect, it } from 'vitest';

import { periodKeyFor } from './leaderboard.routes.js';

/**
 * The period key decides which bucket a score lands in. An off-by-one here
 * shows a player yesterday's board — a bug that produces plausible-looking data
 * and so goes unnoticed until someone complains their score vanished.
 *
 * `Date.UTC` throughout: the buckets are UTC by definition, and constructing
 * dates from local-time components would make these assertions pass or fail
 * depending on where CI runs.
 */
const at = (iso: string): Date => new Date(iso);

describe('periodKeyFor', () => {
  describe('daily', () => {
    it('is the UTC calendar date', () => {
      expect(periodKeyFor('daily', at('2026-07-30T12:00:00.000Z'))).toBe('2026-07-30');
    });

    it('rolls at UTC midnight, not local midnight', () => {
      expect(periodKeyFor('daily', at('2026-07-30T23:59:59.999Z'))).toBe('2026-07-30');
      expect(periodKeyFor('daily', at('2026-07-31T00:00:00.000Z'))).toBe('2026-07-31');
    });
  });

  describe('monthly', () => {
    it('is year-month', () => {
      expect(periodKeyFor('monthly', at('2026-07-30T12:00:00.000Z'))).toBe('2026-07');
    });

    it('rolls on the first of the month', () => {
      expect(periodKeyFor('monthly', at('2026-07-31T23:59:59.999Z'))).toBe('2026-07');
      expect(periodKeyFor('monthly', at('2026-08-01T00:00:00.000Z'))).toBe('2026-08');
    });
  });

  it('collapses all-time to a single bucket', () => {
    expect(periodKeyFor('all-time', at('2020-01-01T00:00:00.000Z'))).toBe('all');
    expect(periodKeyFor('all-time', at('2030-12-31T23:59:59.999Z'))).toBe('all');
  });

  describe('weekly', () => {
    it('holds steady from Monday through Sunday', () => {
      // 2026-07-27 is a Monday; 2026-08-02 the Sunday closing that week.
      const monday = periodKeyFor('weekly', at('2026-07-27T00:00:00.000Z'));
      const sunday = periodKeyFor('weekly', at('2026-08-02T23:59:59.999Z'));

      expect(monday).toBe(sunday);
      expect(monday).toMatch(/^\d{4}-W\d{2}$/);
    });

    it('rolls over on Monday', () => {
      const sunday = periodKeyFor('weekly', at('2026-08-02T23:59:59.999Z'));
      const nextMonday = periodKeyFor('weekly', at('2026-08-03T00:00:00.000Z'));

      expect(nextMonday).not.toBe(sunday);
    });

    it('treats Sunday as the end of the week, not the start', () => {
      // The trap ISO-8601 exists to avoid: JS getUTCDay() calls Sunday 0, so a
      // naive implementation puts Sunday in the *following* week.
      const saturday = periodKeyFor('weekly', at('2026-08-01T12:00:00.000Z'));
      const sunday = periodKeyFor('weekly', at('2026-08-02T12:00:00.000Z'));

      expect(sunday).toBe(saturday);
    });

    it('assigns early January to the previous year when the week belongs there', () => {
      // 2027-01-01 is a Friday, so that week's Thursday (2026-12-31) is still
      // in 2026 — ISO-8601 puts the whole week in 2026-W53.
      expect(periodKeyFor('weekly', at('2027-01-01T12:00:00.000Z'))).toBe('2026-W53');
    });

    it('assigns late December to the next year when the week belongs there', () => {
      // 2024-12-30 is a Monday whose Thursday (2025-01-02) falls in 2025.
      expect(periodKeyFor('weekly', at('2024-12-30T12:00:00.000Z'))).toBe('2025-W01');
    });

    it('numbers a year starting on Thursday from week 1', () => {
      // 2026-01-01 is a Thursday, which by ISO-8601 is week 1 of 2026.
      expect(periodKeyFor('weekly', at('2026-01-01T00:00:00.000Z'))).toBe('2026-W01');
    });

    it('zero-pads single-digit week numbers so keys sort lexically', () => {
      expect(periodKeyFor('weekly', at('2026-02-16T12:00:00.000Z'))).toBe('2026-W08');
    });

    it('never emits week 0', () => {
      // Every day of a year, checked against the invariant that broke first in
      // hand-rolled week arithmetic.
      for (let day = 0; day < 366; day += 1) {
        const date = new Date(Date.UTC(2026, 0, 1 + day));
        const key = periodKeyFor('weekly', date);
        const week = Number(key.slice(-2));

        expect(week).toBeGreaterThanOrEqual(1);
        expect(week).toBeLessThanOrEqual(53);
      }
    });

    it('advances monotonically across a year', () => {
      // Consecutive days must produce keys that never go backwards — the
      // property that catches a year boundary handled inconsistently.
      let previous = periodKeyFor('weekly', at('2026-01-01T00:00:00.000Z'));

      for (let day = 1; day < 400; day += 1) {
        const key = periodKeyFor('weekly', new Date(Date.UTC(2026, 0, 1 + day)));
        expect(key >= previous).toBe(true);
        previous = key;
      }
    });
  });
});
