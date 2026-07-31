import { angleDelta } from '@arena/game-core';
import type { InputCommand } from '@arena/protocol';

/**
 * Server-side input validation.
 *
 * The client is a renderer and a predictor; it is never an authority. Every
 * check here exists because the corresponding value is trivially forged by a
 * modified client.
 */

export interface InputGuardState {
  lastSeq: number;
  /** Token bucket for input rate. */
  budget: number;
  lastRefillMs: number;
  suspicion: number;
  /** Rejections since the last reset, for the audit trail. */
  rejections: Record<string, number>;
}

export type RejectionReason =
  'stale-sequence' | 'sequence-jump' | 'rate-limited' | 'bad-angle' | 'bad-dt';

export function createGuardState(now: number, burst: number): InputGuardState {
  return { lastSeq: 0, budget: burst, lastRefillMs: now, suspicion: 0, rejections: {} };
}

/**
 * Clamps client-reported delta time.
 *
 * A forged `dt` is the simplest speed hack there is: claim 500 ms elapsed and
 * move 15 times further than everyone else. The server clamps to the tick
 * budget, so an inflated value buys nothing.
 */
export function clampDeltaTime(dt: number, maxDt: number): number {
  if (!Number.isFinite(dt) || dt < 0) return 0;
  return Math.min(dt, maxDt);
}

/** Limits a per-tick heading change to the snake's turn rate. */
export function clampTurn(current: number, requested: number, maxRadPerTick: number): number {
  if (!Number.isFinite(requested)) return current;
  const delta = angleDelta(current, requested);
  return current + Math.max(-maxRadPerTick, Math.min(maxRadPerTick, delta));
}

/**
 * Sequence numbers must advance, but not arbitrarily far.
 *
 * A replay is rejected because it would re-apply an old heading. A huge jump is
 * rejected too — it is how a client would try to skip ahead of the server's
 * acknowledgement window and desync reconciliation.
 */
export function isSequenceValid(
  lastSeq: number,
  incomingSeq: number,
  maxJump = 600,
): { ok: boolean; reason?: RejectionReason } {
  if (!Number.isInteger(incomingSeq) || incomingSeq <= lastSeq) {
    return { ok: false, reason: 'stale-sequence' };
  }
  if (incomingSeq - lastSeq > maxJump) {
    return { ok: false, reason: 'sequence-jump' };
  }
  return { ok: true };
}

/**
 * Token-bucket rate limit, per socket, in process.
 *
 * A Redis round-trip per input packet at 20 Hz × 100k players would be two
 * million ops/sec. Redis is only involved when a socket is actually punished,
 * which is rare.
 */
export function consumeInputBudget(
  state: InputGuardState,
  now: number,
  ratePerSecond: number,
  burst: number,
): boolean {
  const elapsed = Math.max(0, now - state.lastRefillMs);
  state.lastRefillMs = now;
  state.budget = Math.min(burst, state.budget + (elapsed / 1_000) * ratePerSecond);

  if (state.budget < 1) return false;
  state.budget -= 1;
  return true;
}

export interface ValidationOutcome {
  accepted: InputCommand[];
  rejected: Array<{ command: InputCommand; reason: RejectionReason }>;
}

/**
 * Validates a batch of inputs against one socket's guard state.
 *
 * Rejections are counted rather than throwing: a single bad packet is noise, a
 * sustained stream of them is a signal, and only the latter is worth acting on.
 */
export function validateInputBatch(
  state: InputGuardState,
  commands: readonly InputCommand[],
  options: { now: number; maxDtMs: number; ratePerSecond: number; burst: number },
): ValidationOutcome {
  const outcome: ValidationOutcome = { accepted: [], rejected: [] };

  for (const command of commands) {
    if (!consumeInputBudget(state, options.now, options.ratePerSecond, options.burst)) {
      record(state, outcome, command, 'rate-limited');
      continue;
    }

    const sequence = isSequenceValid(state.lastSeq, command.seq);
    if (!sequence.ok) {
      record(state, outcome, command, sequence.reason ?? 'stale-sequence');
      continue;
    }

    if (!Number.isFinite(command.angle) || Math.abs(command.angle) > Math.PI + 1e-6) {
      record(state, outcome, command, 'bad-angle');
      continue;
    }

    if (!Number.isFinite(command.dt) || command.dt < 0 || command.dt > 250) {
      record(state, outcome, command, 'bad-dt');
      continue;
    }

    state.lastSeq = command.seq;
    outcome.accepted.push({
      ...command,
      dt: clampDeltaTime(command.dt, options.maxDtMs),
    });
  }

  return outcome;
}

function record(
  state: InputGuardState,
  outcome: ValidationOutcome,
  command: InputCommand,
  reason: RejectionReason,
): void {
  outcome.rejected.push({ command, reason });
  state.rejections[reason] = (state.rejections[reason] ?? 0) + 1;
  state.suspicion += SUSPICION_WEIGHTS[reason];
}

/**
 * How much each signal contributes to a suspicion score.
 *
 * Rate limiting is weighted lowest because a laggy client legitimately bursts
 * on reconnect; a malformed angle has no innocent explanation.
 */
export const SUSPICION_WEIGHTS: Readonly<Record<RejectionReason, number>> = Object.freeze({
  'rate-limited': 1,
  'stale-sequence': 1,
  'sequence-jump': 4,
  'bad-angle': 8,
  'bad-dt': 8,
});

/** Crossing this shadowbans rather than kicking. */
export const SUSPICION_THRESHOLD = 200;

/**
 * Suspicion decays, so an honest player with one bad afternoon of packet loss
 * is not permanently marked.
 */
export function decaySuspicion(state: InputGuardState, amount = 1): void {
  state.suspicion = Math.max(0, state.suspicion - amount);
}

/**
 * A player over the threshold is shadowbanned, not hard-kicked, so a cheater
 * does not learn which signal caught them and cannot iterate against it.
 */
export function shouldShadowban(state: InputGuardState): boolean {
  return state.suspicion >= SUSPICION_THRESHOLD;
}
