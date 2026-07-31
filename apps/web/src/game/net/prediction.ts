import { angleDelta } from '@arena/game-core';
import {
  BASE_SPEED,
  BOOST_SPEED_MULTIPLIER,
  MAX_TURN_RATE_RAD_PER_SEC,
  MIN_BOOST_MASS,
  type InputCommand,
} from '@arena/protocol';

/**
 * Client-side prediction and reconciliation.
 *
 * The local snake is simulated immediately on input so steering feels
 * instantaneous rather than waiting a full round trip. When a snapshot arrives,
 * the authoritative head replaces the predicted one and every input newer than
 * `ackSeq` is replayed on top.
 *
 * The replay uses the same turn/speed maths the server runs (`angleDelta` and
 * the shared constants). Re-deriving movement here is the classic source of
 * drift, and the symptom — the player's own snake jittering while every other
 * snake looks smooth — is confusing enough to be worth avoiding by construction.
 */

export interface PredictedState {
  x: number;
  y: number;
  angle: number;
  mass: number;
}

export interface PredictionBuffer {
  /** Inputs not yet acknowledged by the server, oldest first. */
  pending: InputCommand[];
  lastAckSeq: number;
  state: PredictedState;
  maxPending: number;
}

export function createPredictionBuffer(initial: PredictedState): PredictionBuffer {
  return { pending: [], lastAckSeq: 0, state: { ...initial }, maxPending: 240 };
}

/**
 * Advances one predicted step.
 *
 * Exported so reconciliation can replay with exactly the same function the live
 * path uses — two copies would drift the moment either changed.
 */
export function stepPrediction(
  state: PredictedState,
  command: InputCommand,
  dtSeconds: number,
): PredictedState {
  const maxTurn = MAX_TURN_RATE_RAD_PER_SEC * dtSeconds;
  const delta = angleDelta(state.angle, command.angle);
  const angle = state.angle + Math.max(-maxTurn, Math.min(maxTurn, delta));

  const boosting = command.boost && state.mass > MIN_BOOST_MASS;
  const speed = BASE_SPEED * (boosting ? BOOST_SPEED_MULTIPLIER : 1);
  const distance = speed * dtSeconds;

  return {
    x: state.x + Math.cos(angle) * distance,
    y: state.y + Math.sin(angle) * distance,
    angle,
    mass: state.mass,
  };
}

/** Records an input and advances the local state immediately. */
export function pushPrediction(
  buffer: PredictionBuffer,
  command: InputCommand,
  dtSeconds: number,
): PredictedState {
  buffer.pending.push(command);

  // Bound the queue. An unbounded one grows without limit whenever the server
  // stops acknowledging, and replay cost grows with it.
  if (buffer.pending.length > buffer.maxPending) buffer.pending.shift();

  buffer.state = stepPrediction(buffer.state, command, dtSeconds);
  return buffer.state;
}

export interface ReconcileResult {
  /** Distance between the prediction and the authoritative position. */
  error: number;
  /** How many inputs were replayed after the correction. */
  replayed: number;
  corrected: boolean;
}

/**
 * Snaps to the authoritative state and replays unacknowledged inputs.
 *
 * A small error is ignored rather than corrected: applying a sub-pixel
 * correction every snapshot produces visible jitter for no benefit, since the
 * discrepancy is below what the player can see.
 */
export function reconcile(
  buffer: PredictionBuffer,
  authoritative: PredictedState,
  ackSeq: number,
  dtSeconds: number,
  errorThreshold = 2,
): ReconcileResult {
  buffer.lastAckSeq = Math.max(buffer.lastAckSeq, ackSeq);
  buffer.pending = buffer.pending.filter((command) => command.seq > ackSeq);

  const error = Math.hypot(buffer.state.x - authoritative.x, buffer.state.y - authoritative.y);

  // Mass is always authoritative — the client cannot know what it ate.
  buffer.state.mass = authoritative.mass;

  if (error <= errorThreshold) {
    return { error, replayed: 0, corrected: false };
  }

  let state: PredictedState = { ...authoritative };
  for (const command of buffer.pending) {
    state = stepPrediction(state, command, dtSeconds);
  }

  buffer.state = state;
  return { error, replayed: buffer.pending.length, corrected: true };
}

/**
 * Blends the rendered position toward the predicted one.
 *
 * Even a corrected prediction moves the head discontinuously. Easing over a few
 * frames turns a visible snap into something the eye reads as momentum.
 */
export function smoothTowards(
  rendered: { x: number; y: number },
  target: { x: number; y: number },
  factor: number,
): { x: number; y: number } {
  const clamped = Math.max(0, Math.min(1, factor));
  return {
    x: rendered.x + (target.x - rendered.x) * clamped,
    y: rendered.y + (target.y - rendered.y) * clamped,
  };
}
