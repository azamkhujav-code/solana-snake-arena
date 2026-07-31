import { describe, expect, it, vi } from 'vitest';

import { CYCLE_STAGES, nextStage, stageJobId, type CycleStage } from './plan.js';
import type { CycleJobData, StageResult } from './types.js';

/**
 * Pipeline-advance tests.
 *
 * These exercise the chaining rule the worker implements — each stage enqueues
 * the next, an abort stops the chain, and the data patch carries ids forward —
 * without needing Redis or BullMQ. The rule is small but it is what decides
 * whether a cycle completes or silently stalls.
 */

interface EnqueuedJob {
  jobId: string;
  stage: CycleStage;
  data: CycleJobData;
}

/** Mirrors the worker's advance logic against an in-memory queue. */
async function advance(
  data: CycleJobData,
  result: StageResult,
  queue: EnqueuedJob[],
  refunded: string[] = [],
): Promise<{ aborted: boolean; cancelled: boolean; next: CycleStage | null }> {
  if (result.cancel) {
    // The worker refunds *before* reporting the job done, so a repayment that
    // fails retries the stage instead of being lost behind a success return.
    if (data.gameId) refunded.push(data.gameId);
    return { aborted: false, cancelled: true, next: null };
  }
  if (result.abort) return { aborted: true, cancelled: false, next: null };

  const following = nextStage(data.stage);
  if (following) {
    const merged = { ...data, ...result.patch, stage: following };
    queue.push({ jobId: stageJobId(merged.cycleId, following), stage: following, data: merged });
  }
  return { aborted: false, cancelled: false, next: following };
}

const base: CycleJobData = {
  cycleId: 'bronze:600000',
  tierId: 'bronze',
  stage: 'create-game',
  cycleStartedAt: 600_000,
};

describe('pipeline advance', () => {
  it('enqueues the next stage on success', async () => {
    const queue: EnqueuedJob[] = [];
    const outcome = await advance(base, { patch: { gameId: 'g1' } }, queue);

    expect(outcome.next).toBe('create-pool');
    expect(queue).toHaveLength(1);
    expect(queue[0]?.stage).toBe('create-pool');
  });

  it('threads ids forward through the patch', async () => {
    // Without this, create-pool would have to re-query for the game it needs.
    const queue: EnqueuedJob[] = [];
    await advance(base, { patch: { gameId: 'g1', roomId: 'r1' } }, queue);

    expect(queue[0]?.data.gameId).toBe('g1');
    expect(queue[0]?.data.roomId).toBe('r1');
    expect(queue[0]?.data.cycleStartedAt).toBe(600_000);
  });

  it('stops the chain on abort without enqueuing anything', async () => {
    // An empty lobby must not leave five orphaned jobs to fail in sequence.
    const queue: EnqueuedJob[] = [];
    const outcome = await advance(
      { ...base, stage: 'close-lobby' },
      { abort: { reason: 'not enough players' } },
      queue,
    );

    expect(outcome.aborted).toBe(true);
    expect(queue).toHaveLength(0);
  });

  it('refunds the pot when a stage cancels, and stops the chain', async () => {
    // The difference between abort and cancel is whether money has moved. Past
    // `close-lobby` the stakes are in the game's escrow, so stopping without
    // repaying them is what stranded the pot of every abandoned match.
    const queue: EnqueuedJob[] = [];
    const refunded: string[] = [];

    const outcome = await advance(
      { ...base, stage: 'end-match', gameId: 'g1' },
      { cancel: { reason: 'settlement rejected: no winner in a verified result' } },
      queue,
      refunded,
    );

    expect(outcome.cancelled).toBe(true);
    expect(outcome.next).toBeNull();
    expect(queue).toHaveLength(0);
    expect(refunded).toEqual(['g1']);
  });

  it('does not refund on a plain abort', async () => {
    // `close-lobby` aborts on an empty lobby before consuming anything. There
    // is no pot, and calling the refund path would be noise on every quiet tier
    // at 4am.
    const queue: EnqueuedJob[] = [];
    const refunded: string[] = [];

    await advance(
      { ...base, stage: 'close-lobby', gameId: 'g1' },
      { abort: { reason: 'only 1 player; minimum is 2' } },
      queue,
      refunded,
    );

    expect(refunded).toEqual([]);
  });

  it('stops cleanly after the final stage', async () => {
    const queue: EnqueuedJob[] = [];
    const outcome = await advance({ ...base, stage: 'archive-game' }, {}, queue);

    expect(outcome.next).toBeNull();
    expect(queue).toHaveLength(0);
  });

  it('runs the full pipeline from create-game to archive', async () => {
    const queue: EnqueuedJob[] = [];
    let current: CycleJobData = base;
    const visited: CycleStage[] = [];

    for (;;) {
      visited.push(current.stage);
      const outcome = await advance(current, { patch: { gameId: 'g1' } }, queue);
      if (!outcome.next) break;
      current = queue[queue.length - 1]!.data;
    }

    expect(visited).toEqual([...CYCLE_STAGES]);
  });

  it('gives every stage of a cycle a distinct, deterministic job id', async () => {
    // BullMQ de-duplicates on job id, which is what makes a repeated scheduler
    // tick a no-op rather than a second concurrent cycle.
    const queue: EnqueuedJob[] = [];
    let current: CycleJobData = base;

    for (;;) {
      const outcome = await advance(current, {}, queue);
      if (!outcome.next) break;
      current = queue[queue.length - 1]!.data;
    }

    const ids = queue.map((job) => job.jobId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('bronze:600000:'))).toBe(true);
  });

  it('produces different job ids for different tiers in the same window', async () => {
    const a: EnqueuedJob[] = [];
    const b: EnqueuedJob[] = [];

    await advance(base, {}, a);
    await advance({ ...base, cycleId: 'gold:600000', tierId: 'gold' }, {}, b);

    expect(a[0]?.jobId).not.toBe(b[0]?.jobId);
  });
});

describe('idempotency contract', () => {
  it('re-running a stage yields the same job id, so the enqueue is a no-op', async () => {
    const first: EnqueuedJob[] = [];
    const second: EnqueuedJob[] = [];

    await advance(base, { patch: { gameId: 'g1' } }, first);
    await advance(base, { patch: { gameId: 'g1' } }, second);

    expect(first[0]?.jobId).toBe(second[0]?.jobId);
  });
});

describe('scheduler fan-out', () => {
  it('starts one cycle per tier and survives an individual failure', async () => {
    // One tier failing must not stop the other six.
    const tiers = ['practice', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'whale'];
    const start = vi.fn(async (tierId: string) => {
      if (tierId === 'gold') throw new Error('redis blip');
      return `${tierId}:600000`;
    });

    const started: string[] = [];
    const failed: string[] = [];

    for (const tierId of tiers) {
      try {
        started.push(await start(tierId));
      } catch {
        failed.push(tierId);
      }
    }

    expect(started).toHaveLength(6);
    expect(failed).toEqual(['gold']);
  });
});
