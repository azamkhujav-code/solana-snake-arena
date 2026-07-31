import { describe, expect, it } from 'vitest';

import { createRng, Simulation } from './simulation.js';
import { SpatialHash } from './spatial-hash.js';
import type { SimulationConfig, WorldState } from './types.js';

/**
 * Load characteristics of the simulation, measured rather than asserted.
 *
 * This is a load test in the sense that matters for this system: the question
 * is not "how many requests per second" but "does one tick finish inside its
 * budget with N players in a room". At 30 Hz the budget is 33ms, and a room
 * that overruns it does not fail — it silently runs slow, every player sees
 * rubber-banding, and nothing in the logs says why.
 *
 * Thresholds are deliberately loose. CI machines are slower and noisier than
 * production, so a tight bound fails for reasons unrelated to the code. What
 * these catch is a change of *complexity*: an accidental O(n²) collision pass
 * shows up as an order of magnitude, which survives any amount of noise.
 */

const TICK_BUDGET_MS = 1000 / 30;

function config(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    tickRateHz: 30,
    worldRadius: 4_000,
    maxPlayers: 200,
    maxBots: 0,
    cellSize: 512,
    seed: 12_345,
    ...overrides,
  };
}

interface Measurement {
  perTickMs: number;
  ticks: number;
}

/** Runs a populated room for `ticks` steps and reports the per-tick cost. */
function measure(players: number, ticks: number, seed = 12_345): Measurement {
  const sim = new Simulation(config({ seed }));
  const world = sim.createWorld();

  for (let i = 0; i < players; i += 1) {
    sim.spawnSnake(world, `p${i}`, `player-${i}`);
  }

  // Warm-up, so JIT compilation is not counted as simulation cost.
  for (let i = 0; i < 30; i += 1) sim.step(world);

  const started = performance.now();
  for (let tick = 0; tick < ticks; tick += 1) {
    // Every player steering every tick — the worst realistic case, since an
    // idle player costs strictly less.
    for (let i = 0; i < players; i += 1) {
      sim.enqueueInput(world, `p${i}`, {
        seq: tick + 1,
        angle: ((tick + i) * 0.05) % (Math.PI * 2),
        boost: i % 3 === 0,
        dt: 33,
      });
    }
    sim.step(world);
  }

  return { perTickMs: (performance.now() - started) / ticks, ticks };
}

/** Reports a measurement without dressing it up as an assertion. */
function report(label: string, perTickMs: number): void {
  const percent = ((perTickMs / TICK_BUDGET_MS) * 100).toFixed(1);
  // eslint-disable-next-line no-console -- the measurement is the point
  console.log(`  ${label}: ${perTickMs.toFixed(3)}ms/tick (${percent}% of a 30Hz budget)`);
}

describe('simulation load', () => {
  it('holds the tick budget at a full room', () => {
    const result = measure(120, 200);
    report('120 players', result.perTickMs);

    expect(result.perTickMs).toBeLessThan(TICK_BUDGET_MS);
  });

  it('scales sub-quadratically with player count', () => {
    // The property that decides whether a node holds 40 rooms or 4. A collision
    // pass that regressed to comparing every pair would show ~16x when players
    // quadruple; the spatial hash should keep it near linear.
    const small = measure(30, 150);
    const large = measure(120, 150);

    const growth = large.perTickMs / Math.max(small.perTickMs, 0.0001);
    report('30 players', small.perTickMs);
    report('120 players', large.perTickMs);
    // eslint-disable-next-line no-console -- the measurement is the point
    console.log(`  growth for 4x players: ${growth.toFixed(2)}x`);

    // Quadratic would be ~16x. Under 8x means the spatial index is working;
    // the slack absorbs machine noise.
    expect(growth).toBeLessThan(8);
  });

  it('sustains a full node of rooms within a few tick budgets', () => {
    // 40 rooms is `MAX_ROOMS_PER_NODE`. They share one event loop, so what
    // matters is the sum across rooms, not any single room.
    const rooms: { sim: Simulation; world: WorldState }[] = [];

    for (let index = 0; index < 40; index += 1) {
      const sim = new Simulation(config({ seed: 1_000 + index }));
      const world = sim.createWorld();
      for (let i = 0; i < 30; i += 1) sim.spawnSnake(world, `p${i}`, `player-${i}`);
      rooms.push({ sim, world });
    }

    for (const { sim, world } of rooms) sim.step(world);

    const started = performance.now();
    for (let tick = 0; tick < 30; tick += 1) {
      for (const { sim, world } of rooms) sim.step(world);
    }
    const perTickMs = (performance.now() - started) / 30;

    report('40 rooms x 30 players', perTickMs);

    // Loose by design: this number drives node sizing, and a hard bound would
    // be a CI-flakiness generator. A regression past 4x budget is unambiguous.
    expect(perTickMs).toBeLessThan(TICK_BUDGET_MS * 4);
  });

  it('stays deterministic under load', () => {
    // Load must not change the answer. Two runs from the same seed with the
    // same inputs have to agree exactly, or replay-based dispute resolution is
    // worthless — and that replay is what the `seed` column exists for.
    const run = () => {
      const sim = new Simulation(config({ seed: 999 }));
      const world = sim.createWorld();

      for (let i = 0; i < 50; i += 1) sim.spawnSnake(world, `p${i}`, `player-${i}`);

      for (let tick = 0; tick < 100; tick += 1) {
        for (let i = 0; i < 50; i += 1) {
          sim.enqueueInput(world, `p${i}`, {
            seq: tick + 1,
            angle: (tick * i) % 6,
            boost: false,
            dt: 33,
          });
        }
        sim.step(world);
      }

      return sim.leaderboard(world, 10).map((snake) => `${snake.playerId}:${snake.score}`);
    };

    expect(run()).toEqual(run());
  });

  it('does not grow unboundedly over a full match', () => {
    // Ten minutes at 30Hz is 18,000 ticks. A per-tick allocation that is never
    // released is invisible in a short test and fatal in a long match.
    const sim = new Simulation(config({ seed: 4_242 }));
    const world = sim.createWorld();
    for (let i = 0; i < 40; i += 1) sim.spawnSnake(world, `p${i}`, `player-${i}`);

    const foodAtStart = world.food.size;
    for (let tick = 0; tick < 3_000; tick += 1) sim.step(world);

    // Food is replenished toward a target, so the count should hover rather
    // than climb — an unbounded spawn loop shows up here immediately.
    expect(world.food.size).toBeLessThan(foodAtStart * 2);
    expect(world.snakes.size).toBeLessThanOrEqual(40);
  });
});

describe('spatial hash load', () => {
  it('answers neighbour queries in near-constant time as the world fills', () => {
    // The index that makes collision detection sub-quadratic. If it degrades to
    // a scan, every number above degrades with it.
    const measureQueries = (count: number) => {
      const hash = new SpatialHash(128);
      const rng = createRng(7);

      for (let i = 0; i < count; i += 1) {
        hash.insert(i, rng() * 8_000 - 4_000, rng() * 8_000 - 4_000);
      }

      const out: number[] = [];
      const started = performance.now();
      for (let i = 0; i < 10_000; i += 1) {
        hash.queryCircle(rng() * 8_000 - 4_000, rng() * 8_000 - 4_000, 100, out);
      }
      return (performance.now() - started) / 10_000;
    };

    const sparse = measureQueries(1_000);
    const dense = measureQueries(20_000);

    // eslint-disable-next-line no-console -- the measurement is the point
    console.log(
      `  spatial hash: ${(sparse * 1_000).toFixed(2)}us @1k entries, ` +
        `${(dense * 1_000).toFixed(2)}us @20k entries`,
    );

    // 20x the entries. A linear scan would be ~20x slower; a working hash is
    // driven by local density, not total count.
    expect(dense / Math.max(sparse, 0.0001)).toBeLessThan(8);
  });
});
