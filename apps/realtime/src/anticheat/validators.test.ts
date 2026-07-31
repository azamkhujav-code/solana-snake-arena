import { describe, expect, it } from 'vitest';

import {
  clampDeltaTime,
  clampTurn,
  consumeInputBudget,
  createGuardState,
  decaySuspicion,
  isSequenceValid,
  shouldShadowban,
  SUSPICION_THRESHOLD,
  validateInputBatch,
} from './validators.js';

const T0 = 1_000_000;
const opts = { now: T0, maxDtMs: 33, ratePerSecond: 60, burst: 60 };

const cmd = (seq: number, over: Partial<{ angle: number; boost: boolean; dt: number }> = {}) => ({
  seq,
  angle: over.angle ?? 0.5,
  boost: over.boost ?? false,
  dt: over.dt ?? 33,
});

describe('clampDeltaTime', () => {
  it('clamps an inflated dt to the tick budget', () => {
    // The simplest speed hack: claim 500ms elapsed and move 15x further.
    expect(clampDeltaTime(500, 33)).toBe(33);
  });

  it('passes an honest dt through', () => {
    expect(clampDeltaTime(20, 33)).toBe(20);
  });

  it('treats a negative or non-finite dt as zero, not as the clamp', () => {
    // Zero rather than maxDt on purpose: a garbage value is a hostile client,
    // and the safe response is no movement at all rather than a free full tick.
    expect(clampDeltaTime(-100, 33)).toBe(0);
    expect(clampDeltaTime(Number.NaN, 33)).toBe(0);
    expect(clampDeltaTime(Number.POSITIVE_INFINITY, 33)).toBe(0);
  });
});

describe('clampTurn', () => {
  it('limits a 180-degree turn request to the turn rate', () => {
    const result = clampTurn(0, Math.PI, 0.14);
    expect(result).toBeCloseTo(0.14, 5);
  });

  it('allows a small turn in full', () => {
    expect(clampTurn(0, 0.05, 0.14)).toBeCloseTo(0.05, 5);
  });

  it('takes the short way across the ±π boundary', () => {
    const result = clampTurn(3.0, -3.0, 0.5);
    expect(result).toBeCloseTo(3.283, 2);
  });

  it('ignores a non-finite request rather than corrupting the heading', () => {
    expect(clampTurn(1.5, Number.NaN, 0.14)).toBe(1.5);
  });
});

describe('isSequenceValid', () => {
  it('accepts a forward step', () => {
    expect(isSequenceValid(5, 6).ok).toBe(true);
  });

  it('rejects a replay', () => {
    // Re-applying an old heading is how a replay would rewrite movement.
    expect(isSequenceValid(5, 5)).toEqual({ ok: false, reason: 'stale-sequence' });
    expect(isSequenceValid(5, 3)).toEqual({ ok: false, reason: 'stale-sequence' });
  });

  it('rejects a huge jump ahead', () => {
    // Skipping past the ack window would desync reconciliation.
    expect(isSequenceValid(5, 100_000)).toEqual({ ok: false, reason: 'sequence-jump' });
  });

  it('rejects a non-integer sequence', () => {
    expect(isSequenceValid(5, 5.5).ok).toBe(false);
  });
});

describe('consumeInputBudget', () => {
  it('allows a burst up to the bucket size', () => {
    const state = createGuardState(T0, 5);
    for (let i = 0; i < 5; i += 1) {
      expect(consumeInputBudget(state, T0, 60, 5)).toBe(true);
    }
    expect(consumeInputBudget(state, T0, 60, 5)).toBe(false);
  });

  it('refills over time', () => {
    const state = createGuardState(T0, 1);
    expect(consumeInputBudget(state, T0, 60, 5)).toBe(true);
    expect(consumeInputBudget(state, T0, 60, 5)).toBe(false);

    // One second later the bucket has refilled.
    expect(consumeInputBudget(state, T0 + 1_000, 60, 5)).toBe(true);
  });

  it('never exceeds the burst cap however long it idles', () => {
    const state = createGuardState(T0, 0);
    consumeInputBudget(state, T0 + 3_600_000, 60, 5);
    expect(state.budget).toBeLessThanOrEqual(5);
  });
});

describe('validateInputBatch', () => {
  it('accepts a well-formed batch', () => {
    const state = createGuardState(T0, 60);
    const outcome = validateInputBatch(state, [cmd(1), cmd(2), cmd(3)], opts);

    expect(outcome.accepted).toHaveLength(3);
    expect(outcome.rejected).toHaveLength(0);
    expect(state.lastSeq).toBe(3);
  });

  it('clamps dt on accepted commands', () => {
    const state = createGuardState(T0, 60);
    const outcome = validateInputBatch(state, [cmd(1, { dt: 240 })], opts);

    expect(outcome.accepted[0]?.dt).toBe(33);
  });

  it('rejects an out-of-range angle', () => {
    const state = createGuardState(T0, 60);
    const outcome = validateInputBatch(state, [cmd(1, { angle: 99 })], opts);

    expect(outcome.accepted).toHaveLength(0);
    expect(outcome.rejected[0]?.reason).toBe('bad-angle');
  });

  it('rejects a dt outside the schema range outright', () => {
    const state = createGuardState(T0, 60);
    const outcome = validateInputBatch(state, [cmd(1, { dt: 5_000 })], opts);

    expect(outcome.rejected[0]?.reason).toBe('bad-dt');
  });

  it('rejects replays inside a batch', () => {
    const state = createGuardState(T0, 60);
    const outcome = validateInputBatch(state, [cmd(5), cmd(3), cmd(6)], opts);

    expect(outcome.accepted.map((c) => c.seq)).toEqual([5, 6]);
    expect(outcome.rejected[0]?.reason).toBe('stale-sequence');
  });

  it('rate-limits a flood', () => {
    const state = createGuardState(T0, 2);
    const flood = Array.from({ length: 10 }, (_, i) => cmd(i + 1));
    const outcome = validateInputBatch(state, flood, { ...opts, burst: 2 });

    expect(outcome.accepted.length).toBeLessThanOrEqual(2);
    expect(outcome.rejected.some((r) => r.reason === 'rate-limited')).toBe(true);
  });

  it('counts rejections for the audit trail', () => {
    const state = createGuardState(T0, 60);
    validateInputBatch(state, [cmd(1, { angle: 99 }), cmd(2, { dt: 9_000 })], opts);

    expect(state.rejections['bad-angle']).toBe(1);
    expect(state.rejections['bad-dt']).toBe(1);
  });
});

describe('suspicion', () => {
  it('weights a malformed angle above a rate limit', () => {
    // A laggy client legitimately bursts on reconnect; a bad angle has no
    // innocent explanation.
    const rateLimited = createGuardState(T0, 0);
    validateInputBatch(rateLimited, [cmd(1)], { ...opts, burst: 0 });

    const malformed = createGuardState(T0, 60);
    validateInputBatch(malformed, [cmd(1, { angle: 99 })], opts);

    expect(malformed.suspicion).toBeGreaterThan(rateLimited.suspicion);
  });

  it('shadowbans only past the threshold', () => {
    const state = createGuardState(T0, 60);
    expect(shouldShadowban(state)).toBe(false);

    state.suspicion = SUSPICION_THRESHOLD;
    expect(shouldShadowban(state)).toBe(true);
  });

  it('decays, so one bad afternoon of packet loss is not permanent', () => {
    const state = createGuardState(T0, 60);
    state.suspicion = 50;

    decaySuspicion(state, 20);
    expect(state.suspicion).toBe(30);
  });

  it('never decays below zero', () => {
    const state = createGuardState(T0, 60);
    decaySuspicion(state, 100);
    expect(state.suspicion).toBe(0);
  });
});
