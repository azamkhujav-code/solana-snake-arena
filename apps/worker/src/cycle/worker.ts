import { cancelGameAndRefund, GameAlreadySettledError, GameNotFoundError } from '@arena/db';
import { TIER_IDS } from '@arena/lobby';
import { Worker, type Job, type Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from '@arena/logger';

import { config } from '../config.js';
import { CYCLE_QUEUE, enqueueStage, SCHEDULER_JOB, startCycle } from './queue.js';
import { CYCLE_STAGES, nextStage, type CycleStage } from './plan.js';
import { runStage } from './stages.js';
import type { CycleJobData, StageContext } from './types.js';

export interface CycleWorkerDeps extends StageContext {
  queue: Queue<CycleJobData>;
  connection: Redis;
}

/**
 * The first stage that can leave money behind.
 *
 * `close-lobby` is where `consumeReservations` moves every stake out of custody
 * and into the game's escrow. A stage at or after this point that gives up for
 * good has to hand the pot back; one before it has nothing to return, because
 * the lamports are still sitting in the players' own accounts.
 */
const FIRST_FUNDED_STAGE = CYCLE_STAGES.indexOf('close-lobby');

function holdsMoney(stage: CycleStage): boolean {
  return CYCLE_STAGES.indexOf(stage) >= FIRST_FUNDED_STAGE;
}

/**
 * Cancels the match and returns every entry fee it took.
 *
 * Safe to call speculatively: it is idempotent per player, it no-ops on a game
 * whose escrow is empty, and it refuses outright on one that has already paid
 * out. That is deliberate — the callers below reach it from failure paths where
 * knowing exactly how far the cycle got is not possible.
 */
async function refundAbandonedMatch(
  deps: CycleWorkerDeps,
  data: CycleJobData,
  reason: string,
  log: Logger,
): Promise<void> {
  if (!data.gameId) return;

  try {
    const result = await cancelGameAndRefund(deps.prisma, {
      gameId: data.gameId,
      reason,
      now: deps.now(),
    });

    log.warn(
      {
        gameId: data.gameId,
        reason,
        refunded: result.refunds.length,
        lamports: result.totalLamports.toString(),
        alreadyRefunded: result.alreadyRefundedCount,
      },
      'match cancelled; entry fees returned to the players',
    );
  } catch (error) {
    if (error instanceof GameAlreadySettledError || error instanceof GameNotFoundError) {
      // Nothing to undo: the pot already went where it was meant to, or there
      // is no game row to speak of. Both are ordinary on a retried failure.
      log.info({ gameId: data.gameId, err: error }, 'nothing to refund');
      return;
    }
    // The pot is still stranded and now nobody is coming back for it. This is
    // the line an operator needs to find, so it is logged loudly with the id
    // the manual cancel endpoint takes.
    log.error(
      { gameId: data.gameId, err: error, reason },
      'REFUND FAILED: entry fees remain in escrow; cancel this game by hand',
    );
    throw error;
  }
}

/**
 * Processes cycle stages.
 *
 * Each stage enqueues the next on success, so the pipeline advances itself.
 * Chaining rather than scheduling all seven up front means a stage that aborts
 * — an empty lobby, say — stops the rest cleanly instead of leaving five
 * orphaned jobs to fail one after another.
 */
export function createCycleWorker(deps: CycleWorkerDeps): Worker<CycleJobData> {
  const worker = new Worker<CycleJobData>(
    CYCLE_QUEUE,
    async (job: Job<CycleJobData>) => {
      // The repeatable tick is not a stage; it fans out one cycle per tier.
      if (job.name === SCHEDULER_JOB) {
        return handleSchedulerTick(deps);
      }

      const data = job.data;
      const log = deps.log.child({
        cycleId: data.cycleId,
        tierId: data.tierId,
        stage: data.stage,
        attempt: job.attemptsMade + 1,
      });

      const startedAt = deps.now();
      const result = await runStage(data.stage, data, { ...deps, log });
      const durationMs = deps.now() - startedAt;

      if (result.cancel) {
        // A deliberate stop *after* the stakes moved. The refund runs before
        // the job is reported complete, so a failure to repay retries the
        // stage rather than being swallowed by a success return.
        await refundAbandonedMatch(deps, data, result.cancel.reason, log);
        log.info({ reason: result.cancel.reason, durationMs }, 'cycle cancelled');
        return { cancelled: true, reason: result.cancel.reason };
      }

      if (result.abort) {
        // A deliberate stop, not a failure. Retrying would not change anything
        // and would page someone for a lobby nobody joined.
        log.info({ reason: result.abort.reason, durationMs }, 'cycle aborted');
        return { aborted: true, reason: result.abort.reason };
      }

      const following = nextStage(data.stage);
      if (following) {
        await enqueueStage(deps.queue, { ...data, ...result.patch, stage: following }, deps.now());
      }

      log.info({ durationMs, next: following }, 'cycle stage complete');
      return { ok: true, next: following };
    },
    {
      connection: deps.connection,
      concurrency: config.WORKER_CONCURRENCY,
      // A stage that hangs on a wedged RPC must not hold its lock forever.
      lockDuration: 60_000,
    },
  );

  worker.on('failed', (job, error) => {
    deps.log.error(
      {
        err: error,
        jobId: job?.id,
        stage: job?.data.stage,
        tierId: job?.data.tierId,
        attemptsMade: job?.attemptsMade,
      },
      'cycle stage failed',
    );

    if (!job || !isFinalAttempt(job)) return;

    /**
     * Out of retries, which is where a match quietly died before this.
     *
     * The pipeline advances by each stage enqueuing the next, so a stage that
     * exhausts its budget stops the chain — no `end-match`, no settlement, no
     * archive. If the stakes had already been consumed, that silence was the
     * whole bug: the pot stayed in the escrow of a match that would never be
     * played or paid out, and nothing ever looked at it again.
     *
     * Void rather than awaited because this is an event listener; the refund
     * logs its own outcome, and its failure is already the loudest line in it.
     */
    if (holdsMoney(job.data.stage) && job.data.gameId) {
      const log = deps.log.child({ cycleId: job.data.cycleId, tierId: job.data.tierId });
      void refundAbandonedMatch(
        deps,
        job.data,
        `stage ${job.data.stage} failed after ${job.attemptsMade} attempts: ${
          error instanceof Error ? error.message : String(error)
        }`,
        log,
      ).catch(() => undefined);
    }
  });

  worker.on('error', (error) => {
    deps.log.error({ err: error }, 'cycle worker error');
  });

  return worker;
}

/**
 * Whether this failure was the last one BullMQ will report for the job.
 *
 * `attemptsMade` is incremented before the event fires, so on the final attempt
 * it equals the configured budget. Acting on an earlier failure would refund a
 * match that the next retry goes on to run.
 */
function isFinalAttempt(job: Job<CycleJobData>): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * Opens a new window for every tier.
 *
 * Failures are collected rather than thrown: one tier failing to start must not
 * prevent the other six from running.
 */
async function handleSchedulerTick(
  deps: CycleWorkerDeps,
): Promise<{ started: string[]; failed: string[] }> {
  const now = deps.now();
  const started: string[] = [];
  const failed: string[] = [];

  for (const tierId of TIER_IDS) {
    try {
      const id = await startCycle(deps.queue, tierId, now);
      started.push(id);
    } catch (error) {
      failed.push(tierId);
      deps.log.error({ err: error, tierId }, 'could not start cycle');
    }
  }

  deps.log.info({ started: started.length, failed: failed.length }, 'cycle window opened');
  return { started, failed };
}
