import { radiusForMass } from '@arena/game-core';

/**
 * Movement plausibility checks.
 *
 * The input validators in `validators.ts` police the *shape* of a packet — is
 * the sequence sane, is the angle a number. These police the *consequences*:
 * whether the position the simulation produced could have been reached from the
 * one before it.
 *
 * The distinction matters because the server is authoritative. A client cannot
 * send a position at all, so nothing here defends against a forged coordinate.
 * What it catches is the case where the server's own state has diverged — a
 * bug, a desync, or an input pattern that exploits one — and that is worth
 * detecting precisely because it is invisible otherwise.
 */

export interface MovementSample {
  x: number;
  y: number;
  /** Server tick this sample was taken at. */
  tick: number;
}

/**
 * The furthest a snake can legitimately travel in one tick.
 *
 * Boost is the multiplier a player can hold; the tolerance absorbs the rounding
 * in fixed-point position quantisation, which is real and would otherwise flag
 * every honest player at the boundary.
 */
export function maxTravelPerTick(
  baseSpeed: number,
  boostMultiplier: number,
  tolerance = 1.05,
): number {
  return baseSpeed * boostMultiplier * tolerance;
}

export type MovementVerdict = 'ok' | 'teleport' | 'speed';

/**
 * Compares two consecutive positions against what the physics allows.
 *
 * Ticks are used rather than wall-clock time on purpose: the simulation runs on
 * a fixed timestep, so tick count is the exact number of movement steps that
 * happened. Using elapsed milliseconds would fold in GC pauses and scheduler
 * jitter, and produce false positives on a loaded server — which is precisely
 * when you least want a spurious cheat alarm.
 */
export function checkMovement(
  previous: MovementSample,
  current: MovementSample,
  maxPerTick: number,
): { verdict: MovementVerdict; distance: number; allowed: number } {
  const ticks = current.tick - previous.tick;
  const dx = current.x - previous.x;
  const dy = current.y - previous.y;
  const distance = Math.hypot(dx, dy);

  // A non-advancing or backwards tick is not a movement violation; it is a
  // caller bug or a respawn. Report ok rather than inventing a verdict.
  if (ticks <= 0) return { verdict: 'ok', distance, allowed: 0 };

  const allowed = maxPerTick * ticks;

  // A jump far beyond the per-tick budget is a discontinuity, not fast running.
  // Separated from a mere overspeed because the two have different causes: a
  // teleport is a state bug or a wrap, an overspeed is a rate problem.
  if (distance > allowed * TELEPORT_FACTOR) {
    return { verdict: 'teleport', distance, allowed };
  }
  if (distance > allowed) {
    return { verdict: 'speed', distance, allowed };
  }

  return { verdict: 'ok', distance, allowed };
}

/** How far past the speed budget counts as a discontinuity rather than a sprint. */
export const TELEPORT_FACTOR = 4;

/**
 * Whether a claimed kill is geometrically possible.
 *
 * Collision is resolved server-side, so this is not a trust boundary either —
 * it is a consistency check on the simulation's own output. A kill reported
 * between two snakes that were never within contact range means the collision
 * pass and the position state disagree, and settlement pays out on kills.
 *
 * The generous margin is deliberate: bodies are chains of segments and the
 * contact could have been at any of them, so this catches "impossible", not
 * "unlikely".
 */
export function isKillPlausible(
  killer: { x: number; y: number; mass: number },
  victim: { x: number; y: number; mass: number },
  margin = 4,
): boolean {
  const contactRange =
    radiusForMass(killer.mass) + radiusForMass(victim.mass) + maxTravelPerTick(1, 1) * margin;

  return Math.hypot(killer.x - victim.x, killer.y - victim.y) <= contactRange;
}

/**
 * Rolling movement tracker, one per player.
 *
 * Keeps only the last sample. Storing a history would let us smooth over a
 * single bad tick, but it also means holding an array per player — at 100k
 * concurrent players that is the difference between a few megabytes and a few
 * hundred, and a single anomalous tick is noise anyway. Sustained anomalies
 * show up in the violation counter regardless.
 */
export class MovementGuard {
  private last: MovementSample | null = null;

  /** Counted rather than thrown on: one bad tick is noise, a stream is signal. */
  violations = 0;

  constructor(private readonly maxPerTick: number) {}

  /** Returns the verdict and remembers the sample for next time. */
  observe(sample: MovementSample): MovementVerdict {
    const previous = this.last;
    this.last = sample;

    if (previous === null) return 'ok';

    const result = checkMovement(previous, sample, this.maxPerTick);
    if (result.verdict !== 'ok') this.violations += 1;

    return result.verdict;
  }

  /** Called on respawn and teleport-by-design, so neither reads as a violation. */
  reset(): void {
    this.last = null;
  }
}
