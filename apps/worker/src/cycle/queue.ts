import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

import { config } from '../config.js';
import {
  CYCLE_DURATION_MS,
  currentWindowStart,
  cycleId,
  delayUntilStage,
  getStagePlan,
  stageJobId,
  type CycleStage,
} from './plan.js';
import type { CycleJobData } from './types.js';

export const CYCLE_QUEUE = 'match-cycle';
export const SCHEDULER_JOB = 'cycle-tick';

/**
 * BullMQ requires its own connection with `maxRetriesPerRequest: null`.
 *
 * The shared @arena/redis factory sets a retry limit and disables the offline
 * queue, both of which break BullMQ's blocking commands — it holds a BRPOPLPUSH
 * open indefinitely and would be killed by the retry cap.
 */
export function createQueueConnection(): Redis {
  return new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...(config.REDIS_TLS ? { tls: {} } : {}),
  });
}

export function createCycleQueue(connection: Redis): Queue<CycleJobData> {
  return new Queue<CycleJobData>(CYCLE_QUEUE, {
    connection,
    defaultJobOptions: {
      // Keep a short history: enough to debug the last few cycles without
      // letting completed jobs accumulate into a Redis memory problem.
      removeOnComplete: { age: 3_600, count: 500 },
      removeOnFail: { age: 24 * 3_600, count: 1_000 },
      backoff: { type: 'exponential', delay: 2_000 },
    },
  });
}

export function createCycleQueueEvents(connection: Redis): QueueEvents {
  return new QueueEvents(CYCLE_QUEUE, { connection });
}

/**
 * Enqueues one stage.
 *
 * The job id is derived from (tier, window, stage), so re-enqueuing the same
 * stage is a no-op — BullMQ rejects a duplicate id. That is what makes the
 * whole pipeline safe to re-drive after a worker restart or a duplicated
 * scheduler tick.
 */
export async function enqueueStage(
  queue: Queue<CycleJobData>,
  data: CycleJobData,
  now: number,
): Promise<void> {
  const plan = getStagePlan(data.stage);

  const options: JobsOptions = {
    jobId: stageJobId(data.cycleId, data.stage),
    delay: delayUntilStage(data.stage, data.cycleStartedAt, now),
    attempts: plan.attempts,
    backoff: { type: 'exponential', delay: 2_000 },
  };

  await queue.add(data.stage, data, options);
}

/**
 * Registers the repeatable tick that opens each 10-minute window.
 *
 * The repeat key is stable, so calling this on every boot re-registers the same
 * schedule rather than accumulating duplicates — restarting N workers must not
 * produce N schedulers.
 */
export async function registerScheduler(queue: Queue<CycleJobData>): Promise<void> {
  await queue.upsertJobScheduler(
    SCHEDULER_JOB,
    { every: CYCLE_DURATION_MS },
    {
      name: SCHEDULER_JOB,
      data: {
        cycleId: 'scheduler',
        tierId: '',
        stage: 'create-game',
        cycleStartedAt: 0,
      },
      opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 50 } },
    },
  );
}

export async function removeScheduler(queue: Queue<CycleJobData>): Promise<void> {
  await queue.removeJobScheduler(SCHEDULER_JOB);
}

/** Starts a fresh cycle for one tier by enqueuing its first stage. */
export async function startCycle(
  queue: Queue<CycleJobData>,
  tierId: string,
  now: number,
): Promise<string> {
  const windowStart = currentWindowStart(now);
  const id = cycleId(tierId, windowStart);

  await enqueueStage(
    queue,
    { cycleId: id, tierId, stage: 'create-game', cycleStartedAt: windowStart },
    now,
  );

  return id;
}

export type { CycleStage };
