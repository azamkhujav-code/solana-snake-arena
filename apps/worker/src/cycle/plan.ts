/**
 * The ten-minute match cycle.
 *
 * Every tier runs the same pipeline on a fixed cadence. Stages are separate
 * jobs rather than one long-running function so that a crash between stages
 * loses one stage, not the whole cycle — BullMQ retries the failed stage and
 * the rest of the pipeline continues from there.
 *
 * Timings are pure data so the schedule can be asserted without running a
 * queue, a clock, or Redis.
 */

export const CYCLE_DURATION_MS = 10 * 60 * 1_000;

export const CYCLE_STAGES = [
  'create-game',
  'create-pool',
  'open-lobby',
  'close-lobby',
  'start-match',
  'end-match',
  'archive-game',
] as const;

export type CycleStage = (typeof CYCLE_STAGES)[number];

export interface StagePlan {
  stage: CycleStage;
  /** Milliseconds after the cycle's start at which this stage runs. */
  offsetMs: number;
  /** BullMQ attempt budget for this stage. */
  attempts: number;
  description: string;
}

/**
 * Stage schedule within one cycle.
 *
 * The player-facing window is deliberately the largest slice: a lobby that is
 * only open for seconds never fills. Settlement gets a generous tail because
 * an on-chain confirmation can take far longer than the happy path suggests.
 */
export const CYCLE_PLAN: readonly StagePlan[] = Object.freeze([
  {
    stage: 'create-game',
    offsetMs: 0,
    // Retried aggressively: nothing downstream can happen without the row.
    attempts: 5,
    description: 'Persist the Game row and allocate its identifiers.',
  },
  {
    stage: 'create-pool',
    offsetMs: 5_000,
    // On-chain, so RPC flakiness is expected and worth riding out.
    attempts: 8,
    description: 'Create the on-chain room account and its escrow vault PDA.',
  },
  {
    stage: 'open-lobby',
    offsetMs: 15_000,
    attempts: 5,
    description: 'Open the lobby for joins.',
  },
  {
    stage: 'close-lobby',
    offsetMs: 5 * 60_000,
    attempts: 5,
    description: 'Stop accepting players and lock escrowed entry fees.',
  },
  {
    stage: 'start-match',
    offsetMs: 5 * 60_000 + 20_000,
    attempts: 5,
    description: 'Place the room on a realtime node and issue join tickets.',
  },
  {
    stage: 'end-match',
    offsetMs: 9 * 60_000,
    attempts: 10,
    description: 'Collect results, unlock the prize and pay the winners.',
  },
  {
    stage: 'archive-game',
    offsetMs: 9 * 60_000 + 45_000,
    attempts: 5,
    description: 'Write match history, update aggregates and clear the lobby.',
  },
]);

const BY_STAGE = new Map(CYCLE_PLAN.map((entry) => [entry.stage, entry]));

export function getStagePlan(stage: CycleStage): StagePlan {
  const plan = BY_STAGE.get(stage);
  if (!plan) throw new Error(`Unknown cycle stage: ${stage}`);
  return plan;
}

/** The stage that follows, or null at the end of the pipeline. */
export function nextStage(stage: CycleStage): CycleStage | null {
  const index = CYCLE_STAGES.indexOf(stage);
  if (index === -1) throw new Error(`Unknown cycle stage: ${stage}`);
  return CYCLE_STAGES[index + 1] ?? null;
}

/**
 * Delay from *now* until a stage should run, given when the cycle started.
 *
 * Clamped at zero: a worker that fell behind should run the overdue stage
 * immediately rather than scheduling it into the past, where BullMQ would run
 * it instantly anyway but the intent would be unclear.
 */
export function delayUntilStage(stage: CycleStage, cycleStartedAt: number, now: number): number {
  const plan = getStagePlan(stage);
  return Math.max(0, cycleStartedAt + plan.offsetMs - now);
}

/** How long the lobby accepts players, in ms. */
export function acceptWindowMs(): number {
  return getStagePlan('close-lobby').offsetMs - getStagePlan('open-lobby').offsetMs;
}

/** How long the match itself runs, in ms. */
export function matchDurationMs(): number {
  return getStagePlan('end-match').offsetMs - getStagePlan('start-match').offsetMs;
}

/**
 * Deterministic cycle id.
 *
 * Derived from the tier and the 10-minute window rather than a random UUID, so
 * a duplicate schedule tick produces the *same* id. BullMQ de-duplicates on job
 * id, which makes the whole pipeline idempotent at the queue level — two
 * schedulers racing cannot start two cycles for the same window.
 */
export function cycleId(tierId: string, windowStart: number): string {
  return `${tierId}:${windowStart}`;
}

/** Start of the 10-minute window containing `now`. */
export function currentWindowStart(now: number): number {
  return Math.floor(now / CYCLE_DURATION_MS) * CYCLE_DURATION_MS;
}

/** Job id for one stage of one cycle. Also the de-duplication key. */
export function stageJobId(cycle: string, stage: CycleStage): string {
  return `${cycle}:${stage}`;
}
