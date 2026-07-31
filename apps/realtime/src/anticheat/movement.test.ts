import { describe, expect, it } from 'vitest';

import {
  checkMovement,
  isKillPlausible,
  maxTravelPerTick,
  MovementGuard,
  TELEPORT_FACTOR,
} from './movement.js';

const MAX_PER_TICK = 10;

describe('maxTravelPerTick', () => {
  it('accounts for boost', () => {
    expect(maxTravelPerTick(10, 2, 1)).toBe(20);
  });

  it('leaves headroom for quantisation rounding', () => {
    // Positions cross the wire as fixed-point i16. Without the tolerance every
    // honest player at full speed trips the check on the rounding alone.
    expect(maxTravelPerTick(10, 1)).toBeGreaterThan(10);
  });
});

describe('checkMovement', () => {
  const at = (x: number, y: number, tick: number) => ({ x, y, tick });

  it('accepts movement within the per-tick budget', () => {
    const result = checkMovement(at(0, 0, 1), at(9, 0, 2), MAX_PER_TICK);
    expect(result.verdict).toBe('ok');
  });

  it('accepts movement exactly at the budget', () => {
    // The boundary is legitimate — a player holding full speed sits here every
    // tick, and flagging it would mean flagging everyone.
    const result = checkMovement(at(0, 0, 1), at(10, 0, 2), MAX_PER_TICK);
    expect(result.verdict).toBe('ok');
  });

  it('scales the budget with elapsed ticks', () => {
    // Five ticks of movement arriving in one sample is normal after a stall.
    const result = checkMovement(at(0, 0, 1), at(48, 0, 6), MAX_PER_TICK);
    expect(result.verdict).toBe('ok');
  });

  it('flags a modest overspeed as speed, not teleport', () => {
    const result = checkMovement(at(0, 0, 1), at(15, 0, 2), MAX_PER_TICK);

    expect(result.verdict).toBe('speed');
    expect(result.allowed).toBe(10);
    expect(result.distance).toBe(15);
  });

  it('flags a large discontinuity as teleport', () => {
    // Separated because the causes differ: a teleport is a state bug or a
    // world wrap, an overspeed is a rate problem.
    const result = checkMovement(at(0, 0, 1), at(10 * TELEPORT_FACTOR + 1, 0, 2), MAX_PER_TICK);
    expect(result.verdict).toBe('teleport');
  });

  it('measures diagonal distance, not axis distance', () => {
    // 8 on each axis is 11.3 diagonally — over budget. Checking axes
    // independently would let a diagonal cheat move 41% further than allowed.
    const result = checkMovement(at(0, 0, 1), at(8, 8, 2), MAX_PER_TICK);
    expect(result.verdict).toBe('speed');
  });

  it('reports ok when ticks do not advance', () => {
    // A respawn or a caller bug, not a movement violation.
    const result = checkMovement(at(0, 0, 5), at(500, 500, 5), MAX_PER_TICK);
    expect(result.verdict).toBe('ok');
  });

  it('reports ok when ticks go backwards', () => {
    const result = checkMovement(at(0, 0, 9), at(500, 0, 4), MAX_PER_TICK);
    expect(result.verdict).toBe('ok');
  });
});

describe('MovementGuard', () => {
  it('accepts the first sample, having nothing to compare against', () => {
    const guard = new MovementGuard(MAX_PER_TICK);

    expect(guard.observe({ x: 1000, y: 1000, tick: 1 })).toBe('ok');
    expect(guard.violations).toBe(0);
  });

  it('counts violations without throwing', () => {
    // One bad tick is noise; a stream of them is the signal worth acting on.
    const guard = new MovementGuard(MAX_PER_TICK);

    guard.observe({ x: 0, y: 0, tick: 1 });
    guard.observe({ x: 500, y: 0, tick: 2 });
    guard.observe({ x: 1000, y: 0, tick: 3 });

    expect(guard.violations).toBe(2);
  });

  it('does not count legitimate movement', () => {
    const guard = new MovementGuard(MAX_PER_TICK);

    for (let tick = 1; tick <= 20; tick += 1) {
      guard.observe({ x: tick * 9, y: 0, tick });
    }

    expect(guard.violations).toBe(0);
  });

  it('treats the sample after a reset as a fresh start', () => {
    // Respawn moves a player across the map by design. Without the reset it
    // would register as a teleport every single death.
    const guard = new MovementGuard(MAX_PER_TICK);

    guard.observe({ x: 0, y: 0, tick: 1 });
    guard.reset();

    expect(guard.observe({ x: 5000, y: 5000, tick: 2 })).toBe('ok');
    expect(guard.violations).toBe(0);
  });

  it('resumes checking after a reset', () => {
    const guard = new MovementGuard(MAX_PER_TICK);

    guard.reset();
    guard.observe({ x: 0, y: 0, tick: 1 });
    guard.observe({ x: 900, y: 0, tick: 2 });

    expect(guard.violations).toBe(1);
  });
});

describe('isKillPlausible', () => {
  it('accepts a kill between adjacent snakes', () => {
    expect(isKillPlausible({ x: 100, y: 100, mass: 50 }, { x: 105, y: 100, mass: 50 })).toBe(true);
  });

  it('rejects a kill across the map', () => {
    // Settlement pays out on kills, so a kill between snakes that were never in
    // contact means the collision pass and the position state disagree.
    expect(isKillPlausible({ x: 0, y: 0, mass: 50 }, { x: 5000, y: 5000, mass: 50 })).toBe(false);
  });

  it('allows more range between larger snakes', () => {
    // Radius scales with mass, so two big snakes touch at a greater centre
    // distance than two small ones.
    const far = { a: { x: 0, y: 0, mass: 10_000 }, b: { x: 120, y: 0, mass: 10_000 } };
    const small = { a: { x: 0, y: 0, mass: 10 }, b: { x: 120, y: 0, mass: 10 } };

    expect(isKillPlausible(far.a, far.b)).toBe(true);
    expect(isKillPlausible(small.a, small.b)).toBe(false);
  });
});
