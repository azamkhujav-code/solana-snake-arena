import { describe, expect, it } from 'vitest';

import { deriveAlerts, resolveWindow } from './admin-stats.js';

const HEALTHY = {
  failedSettlements: 0,
  stuckWithdrawals: 0,
  ledgerBalanced: true,
  custodySolvent: true,
  imbalancedGroups: 0,
} as const;

describe('deriveAlerts', () => {
  it('says nothing when nothing is wrong', () => {
    // A dashboard that always shows a warning trains operators to ignore
    // warnings, and then the real one scrolls past.
    expect(deriveAlerts({ ...HEALTHY })).toEqual([]);
  });

  it('raises insolvency as critical', () => {
    const alerts = deriveAlerts({ ...HEALTHY, custodySolvent: false });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.code).toBe('CUSTODY_INSOLVENT');
    expect(alerts[0]?.severity).toBe('critical');
  });

  it('stays quiet when solvency is unknown', () => {
    // null means the RPC did not answer. An outage is not evidence of
    // insolvency, and paging someone for one is how alerting gets muted.
    expect(deriveAlerts({ ...HEALTHY, custodySolvent: null })).toEqual([]);
  });

  it('raises ledger drift as critical', () => {
    const alerts = deriveAlerts({ ...HEALTHY, ledgerBalanced: false });

    expect(alerts.map((a) => a.code)).toEqual(['LEDGER_DRIFT']);
    expect(alerts[0]?.severity).toBe('critical');
  });

  it('carries the count of imbalanced entry groups', () => {
    const alerts = deriveAlerts({ ...HEALTHY, imbalancedGroups: 3 });

    expect(alerts[0]?.code).toBe('ENTRY_GROUP_IMBALANCED');
    expect(alerts[0]?.count).toBe(3);
  });

  it('treats recoverable problems as warnings, not criticals', () => {
    // A failed settlement is money that did not arrive, but retrying fixes it.
    // Ranking it alongside insolvency would flatten the distinction that makes
    // the severity useful.
    const alerts = deriveAlerts({ ...HEALTHY, failedSettlements: 2, stuckWithdrawals: 1 });

    expect(alerts.map((a) => a.severity)).toEqual(['warn', 'warn']);
    expect(alerts.map((a) => a.code)).toEqual(['SETTLEMENT_FAILED', 'WITHDRAWAL_STUCK']);
  });

  it('puts criticals before warnings', () => {
    const alerts = deriveAlerts({
      failedSettlements: 5,
      stuckWithdrawals: 2,
      ledgerBalanced: false,
      custodySolvent: false,
      imbalancedGroups: 1,
    });

    const severities = alerts.map((a) => a.severity);
    const lastCritical = severities.lastIndexOf('critical');
    const firstWarn = severities.indexOf('warn');

    expect(lastCritical).toBeLessThan(firstWarn);
    // Insolvency outranks everything: it is the only one whose correct response
    // is to stop taking deposits.
    expect(alerts[0]?.code).toBe('CUSTODY_INSOLVENT');
  });
});

describe('resolveWindow', () => {
  it('defaults to the last 24 hours', () => {
    const window = resolveWindow(undefined, undefined);

    expect(window.hours).toBe(24);
    expect(window.to.getTime() - window.from.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('honours an explicit range', () => {
    const window = resolveWindow('2026-07-30T00:00:00.000Z', '2026-07-30T06:00:00.000Z');

    expect(window.hours).toBe(6);
    expect(window.from.toISOString()).toBe('2026-07-30T00:00:00.000Z');
  });

  it('backdates from an explicit end when only `to` is given', () => {
    const window = resolveWindow(undefined, '2026-07-30T12:00:00.000Z');

    expect(window.to.toISOString()).toBe('2026-07-30T12:00:00.000Z');
    expect(window.from.toISOString()).toBe('2026-07-29T12:00:00.000Z');
  });

  it('never reports a zero-hour window', () => {
    // hours divides into rates on the dashboard; zero would produce Infinity.
    const window = resolveWindow('2026-07-30T00:00:00.000Z', '2026-07-30T00:00:30.000Z');

    expect(window.hours).toBe(1);
  });
});
