import { describe, expect, it } from 'vitest';

import {
  acceptWindowMs,
  currentWindowStart,
  CYCLE_DURATION_MS,
  CYCLE_PLAN,
  CYCLE_STAGES,
  cycleId,
  delayUntilStage,
  getStagePlan,
  matchDurationMs,
  nextStage,
  stageJobId,
} from './plan.js';

describe('cycle plan', () => {
  it('covers all eight lifecycle steps in order', () => {
    expect(CYCLE_STAGES).toEqual([
      'create-game',
      'create-pool',
      'open-lobby',
      'close-lobby',
      'start-match',
      'end-match',
      'archive-game',
    ]);
  });

  it('has a plan entry for every stage', () => {
    for (const stage of CYCLE_STAGES) {
      expect(getStagePlan(stage).stage).toBe(stage);
    }
  });

  it('schedules stages in strictly increasing order', () => {
    // An out-of-order offset would run, say, close-lobby before open-lobby.
    for (let i = 1; i < CYCLE_PLAN.length; i += 1) {
      expect(CYCLE_PLAN[i]!.offsetMs).toBeGreaterThan(CYCLE_PLAN[i - 1]!.offsetMs);
    }
  });

  it('fits every stage inside the ten-minute window', () => {
    // Overrunning would have the next cycle start before this one archived,
    // and both would fight over the same lobby.
    const last = CYCLE_PLAN[CYCLE_PLAN.length - 1]!;
    expect(last.offsetMs).toBeLessThan(CYCLE_DURATION_MS);
  });

  it('leaves a margin after the final stage', () => {
    const last = CYCLE_PLAN[CYCLE_PLAN.length - 1]!;
    expect(CYCLE_DURATION_MS - last.offsetMs).toBeGreaterThanOrEqual(10_000);
  });

  it('gives every stage a retry budget', () => {
    for (const entry of CYCLE_PLAN) {
      expect(entry.attempts).toBeGreaterThan(1);
    }
  });

  it('retries the on-chain and settlement stages hardest', () => {
    // Both depend on RPC, where transient failure is the norm.
    expect(getStagePlan('create-pool').attempts).toBeGreaterThanOrEqual(8);
    expect(getStagePlan('end-match').attempts).toBeGreaterThanOrEqual(8);
  });

  it('gives players a multi-minute window to join', () => {
    // A lobby open for seconds never fills.
    expect(acceptWindowMs()).toBeGreaterThanOrEqual(4 * 60_000);
  });

  it('leaves a sensible match duration', () => {
    expect(matchDurationMs()).toBeGreaterThanOrEqual(3 * 60_000);
  });
});

describe('nextStage', () => {
  it('walks the pipeline', () => {
    expect(nextStage('create-game')).toBe('create-pool');
    expect(nextStage('start-match')).toBe('end-match');
  });

  it('returns null at the end', () => {
    expect(nextStage('archive-game')).toBeNull();
  });

  it('chains through every stage exactly once', () => {
    const visited: string[] = [];
    let stage: string | null = CYCLE_STAGES[0];

    while (stage) {
      visited.push(stage);
      stage = nextStage(stage as (typeof CYCLE_STAGES)[number]);
    }

    expect(visited).toEqual([...CYCLE_STAGES]);
  });

  it('throws on an unknown stage rather than silently ending the pipeline', () => {
    expect(() => nextStage('nonsense' as never)).toThrow();
  });
});

describe('delayUntilStage', () => {
  const started = 1_000_000;

  it('computes the wait from the cycle start', () => {
    expect(delayUntilStage('open-lobby', started, started)).toBe(15_000);
    expect(delayUntilStage('close-lobby', started, started)).toBe(300_000);
  });

  it('accounts for time already elapsed', () => {
    expect(delayUntilStage('open-lobby', started, started + 10_000)).toBe(5_000);
  });

  it('clamps an overdue stage to zero rather than going negative', () => {
    // A worker that fell behind should run the overdue stage now.
    expect(delayUntilStage('open-lobby', started, started + 60_000)).toBe(0);
  });
});

describe('cycle identity', () => {
  it('derives the same id for the same tier and window', () => {
    // This is what makes a duplicated schedule tick a no-op: BullMQ
    // de-duplicates on job id.
    expect(cycleId('bronze', 600_000)).toBe(cycleId('bronze', 600_000));
  });

  it('differs per tier and per window', () => {
    expect(cycleId('bronze', 600_000)).not.toBe(cycleId('gold', 600_000));
    expect(cycleId('bronze', 600_000)).not.toBe(cycleId('bronze', 1_200_000));
  });

  it('floors the clock to the containing ten-minute window', () => {
    expect(currentWindowStart(CYCLE_DURATION_MS + 1)).toBe(CYCLE_DURATION_MS);
    expect(currentWindowStart(CYCLE_DURATION_MS * 3 - 1)).toBe(CYCLE_DURATION_MS * 2);
    expect(currentWindowStart(0)).toBe(0);
  });

  it('gives every tick inside one window the same start', () => {
    const base = CYCLE_DURATION_MS * 5;
    for (const offset of [0, 1_000, 599_999]) {
      expect(currentWindowStart(base + offset)).toBe(base);
    }
  });

  it('builds a unique job id per stage', () => {
    const cycle = cycleId('bronze', 600_000);
    const ids = CYCLE_STAGES.map((stage) => stageJobId(cycle, stage));

    expect(new Set(ids).size).toBe(CYCLE_STAGES.length);
    expect(ids[0]).toBe('bronze:600000:create-game');
  });
});
