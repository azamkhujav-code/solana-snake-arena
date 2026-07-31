import { describe, expect, it } from 'vitest';

import {
  angleDelta,
  createRng,
  lengthForMass,
  radiusForMass,
  scoreForMass,
  Simulation,
} from './simulation.js';
import { SpatialHash } from './spatial-hash.js';
import type { WorldState } from './types.js';

const config = {
  tickRateHz: 30,
  worldRadius: 2_000,
  maxPlayers: 20,
  maxBots: 0,
  cellSize: 256,
  seed: 12_345,
  targetFood: 50,
};

const sim = () => new Simulation(config);

function stepN(simulation: Simulation, world: WorldState, n: number) {
  for (let i = 0; i < n; i += 1) simulation.step(world);
}

describe('createRng', () => {
  it('is deterministic for a seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const drawsA = Array.from({ length: 20 }, () => a());
    const drawsB = Array.from({ length: 20 }, () => b());

    expect(drawsA).toEqual(drawsB);
  });

  it('differs across seeds', () => {
    expect(createRng(1)()).not.toBe(createRng(2)());
  });

  it('stays within [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 1_000; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('angleDelta', () => {
  it('takes the short way across the ±π boundary', () => {
    // Naive subtraction would return ~-6.1 and spin the snake the long way,
    // which reads as a stutter at exactly one heading.
    expect(angleDelta(3.0, -3.0)).toBeCloseTo(0.283, 2);
    expect(angleDelta(-3.0, 3.0)).toBeCloseTo(-0.283, 2);
  });

  it('is zero for identical angles', () => {
    expect(angleDelta(1.2, 1.2)).toBe(0);
  });

  it('stays within (-π, π]', () => {
    for (let i = 0; i < 100; i += 1) {
      const from = (i / 100) * Math.PI * 4 - Math.PI * 2;
      const delta = angleDelta(from, 0);
      expect(Math.abs(delta)).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });
});

describe('mass derivations', () => {
  it('grows radius sub-linearly with mass', () => {
    const small = radiusForMass(10);
    const big = radiusForMass(1_000);
    expect(big).toBeGreaterThan(small);
    // 100x the mass must not mean 100x the girth.
    expect(big / small).toBeLessThan(10);
  });

  it('caps spine length so a huge snake cannot exhaust the ring buffer', () => {
    expect(lengthForMass(1_000_000)).toBeLessThanOrEqual(400);
  });

  it('scores zero at the starting mass and never goes negative', () => {
    expect(scoreForMass(10)).toBe(0);
    expect(scoreForMass(0)).toBe(0);
  });
});

describe('world creation', () => {
  it('spawns the target food count', () => {
    const world = sim().createWorld();
    expect(world.food.size).toBe(50);
  });

  it('places all food inside the world boundary', () => {
    const world = sim().createWorld();
    for (const food of world.food.values()) {
      expect(Math.hypot(food.x, food.y)).toBeLessThanOrEqual(config.worldRadius);
    }
  });
});

describe('spawning', () => {
  it('creates a snake with a body', () => {
    const s = sim();
    const world = s.createWorld();
    const snake = s.spawnSnake(world, 'p1', 'alice');

    expect(snake.alive).toBe(true);
    expect(snake.spineLength).toBeGreaterThan(1);
    expect(world.playerIndex.get('p1')).toBe(snake.id);
  });

  it('is idempotent per player', () => {
    const s = sim();
    const world = s.createWorld();
    const first = s.spawnSnake(world, 'p1', 'alice');
    const second = s.spawnSnake(world, 'p1', 'alice');

    expect(second.id).toBe(first.id);
    expect(world.snakes.size).toBe(1);
  });

  it('spawns inside the boundary', () => {
    const s = sim();
    const world = s.createWorld();
    for (let i = 0; i < 20; i += 1) {
      const snake = s.spawnSnake(world, `p${i}`, `n${i}`);
      const head = s.headOf(snake);
      expect(Math.hypot(head.x, head.y)).toBeLessThan(config.worldRadius);
    }
  });

  it('scatters mass as food on despawn', () => {
    const s = sim();
    const world = s.createWorld();
    s.spawnSnake(world, 'p1', 'alice');
    const before = world.food.size;

    s.despawnSnake(world, 'p1');

    expect(world.snakes.size).toBe(0);
    expect(world.food.size).toBeGreaterThan(before);
  });
});

describe('determinism', () => {
  it('produces byte-identical worlds from the same seed and inputs', () => {
    // This is the property client-side prediction depends on. If it breaks,
    // the symptom is rubber-banding, not an obvious crash.
    const run = () => {
      const s = sim();
      const world = s.createWorld();
      s.spawnSnake(world, 'p1', 'alice');
      s.spawnSnake(world, 'p2', 'bob');

      for (let tick = 0; tick < 60; tick += 1) {
        s.enqueueInput(world, 'p1', {
          seq: tick + 1,
          angle: Math.sin(tick / 10),
          boost: false,
          dt: 33,
        });
        s.enqueueInput(world, 'p2', {
          seq: tick + 1,
          angle: Math.cos(tick / 10),
          boost: true,
          dt: 33,
        });
        s.step(world);
      }

      return [...world.snakes.values()].map((snake) => ({
        head: s.headOf(snake),
        mass: snake.mass,
        angle: snake.angle,
      }));
    };

    expect(run()).toEqual(run());
  });

  it('diverges for different seeds', () => {
    const build = (seed: number) => {
      const s = new Simulation({ ...config, seed });
      const world = s.createWorld();
      s.spawnSnake(world, 'p1', 'alice');
      stepN(s, world, 30);
      return s.headOf(world.snakes.values().next().value!);
    };

    expect(build(1)).not.toEqual(build(2));
  });
});

describe('movement', () => {
  it('moves the head forward each tick', () => {
    const s = sim();
    const world = s.createWorld();
    const snake = s.spawnSnake(world, 'p1', 'alice');
    const before = s.headOf(snake);

    s.step(world);

    expect(s.headOf(snake)).not.toEqual(before);
  });

  it('clamps the turn rate rather than snapping to the requested angle', () => {
    // An unclamped turn is the classic speed/aim hack.
    const s = sim();
    const world = s.createWorld();
    const snake = s.spawnSnake(world, 'p1', 'alice');
    snake.angle = 0;

    s.enqueueInput(world, 'p1', { seq: 1, angle: Math.PI, boost: false, dt: 33 });
    s.step(world);

    expect(Math.abs(snake.angle)).toBeLessThan(Math.PI / 2);
  });

  it('boosting moves further per tick and costs mass', () => {
    const s = sim();
    const world = s.createWorld();

    const normal = s.spawnSnake(world, 'p1', 'a');
    const boosted = s.spawnSnake(world, 'p2', 'b');
    normal.mass = 100;
    boosted.mass = 100;

    s.enqueueInput(world, 'p2', { seq: 1, angle: boosted.angle, boost: true, dt: 33 });
    stepN(s, world, 30);

    expect(boosted.speed).toBeGreaterThan(normal.speed);
    expect(boosted.mass).toBeLessThan(100);
  });

  it('refuses to boost below the minimum mass', () => {
    const s = sim();
    const world = s.createWorld();
    const snake = s.spawnSnake(world, 'p1', 'a');
    snake.mass = 5;

    s.enqueueInput(world, 'p1', { seq: 1, angle: 0, boost: true, dt: 33 });
    s.step(world);

    expect(snake.speed).toBe(220);
  });

  it('ignores a replayed or out-of-order input sequence', () => {
    const s = sim();
    const world = s.createWorld();
    const snake = s.spawnSnake(world, 'p1', 'a');

    s.enqueueInput(world, 'p1', { seq: 5, angle: 1, boost: false, dt: 33 });
    s.step(world);
    expect(snake.lastAckSeq).toBe(5);

    s.enqueueInput(world, 'p1', { seq: 3, angle: -1, boost: false, dt: 33 });
    s.step(world);

    expect(snake.lastAckSeq).toBe(5);
    expect(snake.targetAngle).toBe(1);
  });
});

describe('food', () => {
  it('is eaten on contact and converts to mass', () => {
    const s = sim();
    const world = s.createWorld();
    const snake = s.spawnSnake(world, 'p1', 'a');
    const head = s.headOf(snake);
    const massBefore = snake.mass;

    world.food.clear();
    const food = { id: 9_999, x: head.x, y: head.y, mass: 25, hue: 0, expiresAtTick: null };
    world.food.set(food.id, food);

    const result = s.step(world);

    expect(result.foodConsumed).toBe(1);
    expect(snake.mass).toBeGreaterThan(massBefore);
    expect(world.food.has(9_999)).toBe(false);
  });

  it('replenishes toward the target over time', () => {
    const s = sim();
    const world = s.createWorld();
    world.food.clear();

    stepN(s, world, 40);
    expect(world.food.size).toBeGreaterThan(0);
    expect(world.food.size).toBeLessThanOrEqual(50);
  });
});

describe('collision', () => {
  it('kills a snake that leaves the world boundary', () => {
    const s = sim();
    const world = s.createWorld();
    const snake = s.spawnSnake(world, 'p1', 'a');

    // Park the head just inside the edge, heading out.
    snake.spine[snake.headIndex * 2] = config.worldRadius - 1;
    snake.spine[snake.headIndex * 2 + 1] = 0;
    snake.angle = 0;
    snake.targetAngle = 0;

    const result = s.step(world);

    expect(snake.alive).toBe(false);
    expect(result.deaths[0]?.cause).toBe('wall');
    expect(result.deaths[0]?.killer).toBeNull();
  });

  it('kills a snake that runs into another body and credits the killer', () => {
    const s = sim();
    const world = s.createWorld();
    const victim = s.spawnSnake(world, 'p1', 'victim');
    const killer = s.spawnSnake(world, 'p2', 'killer');

    // Lay the killer's body across the origin and drive the victim into it.
    for (let i = 0; i < killer.spineLength; i += 1) {
      const index = (killer.headIndex - i + killer.spineCapacity) % killer.spineCapacity;
      killer.spine[index * 2] = i * 12;
      killer.spine[index * 2 + 1] = 0;
    }
    victim.spine[victim.headIndex * 2] = 100;
    victim.spine[victim.headIndex * 2 + 1] = 0;
    victim.angle = Math.PI;
    victim.targetAngle = Math.PI;

    let death;
    for (let i = 0; i < 40 && !death; i += 1) {
      death = s.step(world).deaths[0];
    }

    expect(death?.victimPlayerId).toBe('p1');
    expect(death?.killerPlayerId).toBe('p2');
    expect(killer.kills).toBe(1);
  });

  it('does not let a snake collide with its own neck', () => {
    // The leading spine points are always inside the head's radius, so a naive
    // check would kill every snake on its first tick.
    const s = sim();
    const world = s.createWorld();
    const snake = s.spawnSnake(world, 'p1', 'a');

    stepN(s, world, 60);
    expect(snake.alive).toBe(true);
  });

  it('drops the dead snake mass as food', () => {
    const s = sim();
    const world = s.createWorld();
    const snake = s.spawnSnake(world, 'p1', 'a');
    snake.mass = 200;
    snake.spine[snake.headIndex * 2] = config.worldRadius - 1;
    snake.spine[snake.headIndex * 2 + 1] = 0;
    snake.angle = 0;
    snake.targetAngle = 0;

    const before = world.food.size;
    s.step(world);

    expect(world.food.size).toBeGreaterThan(before);
  });
});

describe('leaderboard', () => {
  it('ranks living snakes by score', () => {
    const s = sim();
    const world = s.createWorld();

    const a = s.spawnSnake(world, 'p1', 'a');
    const b = s.spawnSnake(world, 'p2', 'b');
    const c = s.spawnSnake(world, 'p3', 'c');
    a.score = 50;
    b.score = 300;
    c.score = 100;

    expect(s.leaderboard(world).map((snake) => snake.playerId)).toEqual(['p2', 'p3', 'p1']);
  });

  it('excludes the dead', () => {
    const s = sim();
    const world = s.createWorld();
    const a = s.spawnSnake(world, 'p1', 'a');
    s.spawnSnake(world, 'p2', 'b');
    a.alive = false;

    expect(s.leaderboard(world).map((snake) => snake.playerId)).toEqual(['p2']);
  });

  it('breaks ties deterministically', () => {
    const s = sim();
    const world = s.createWorld();
    const a = s.spawnSnake(world, 'p1', 'a');
    const b = s.spawnSnake(world, 'p2', 'b');
    a.score = 100;
    b.score = 100;

    expect(s.leaderboard(world)).toEqual(s.leaderboard(world));
  });
});

describe('SpatialHash', () => {
  it('finds an entity inside the query radius', () => {
    const hash = new SpatialHash(100);
    hash.insert(1, 50, 50);

    expect(hash.queryCircle(60, 60, 50)).toContain(1);
  });

  it('excludes distant cells', () => {
    const hash = new SpatialHash(100);
    hash.insert(1, 5_000, 5_000);

    expect(hash.queryCircle(0, 0, 50)).not.toContain(1);
  });

  it('handles negative coordinates', () => {
    const hash = new SpatialHash(100);
    hash.insert(1, -250, -250);

    expect(hash.queryCircle(-240, -240, 50)).toContain(1);
  });

  it('removes without disturbing other entries', () => {
    const hash = new SpatialHash(100);
    hash.insert(1, 10, 10);
    hash.insert(2, 20, 20);
    hash.remove(1, 10, 10);

    const found = hash.queryCircle(15, 15, 100);
    expect(found).toContain(2);
    expect(found).not.toContain(1);
  });

  it('tracks size and clears', () => {
    const hash = new SpatialHash(100);
    hash.insert(1, 0, 0);
    hash.insert(2, 0, 0);
    expect(hash.size).toBe(2);

    hash.clear();
    expect(hash.size).toBe(0);
    expect(hash.cellCount).toBe(0);
  });

  it('reuses the output array so a hot loop does not allocate', () => {
    const hash = new SpatialHash(100);
    hash.insert(1, 0, 0);
    const out: number[] = [];

    const first = hash.queryCircle(0, 0, 50, out);
    const second = hash.queryCircle(0, 0, 50, out);

    expect(first).toBe(out);
    expect(second).toBe(out);
    expect(out).toHaveLength(1);
  });

  it('rejects a non-positive cell size', () => {
    expect(() => new SpatialHash(0)).toThrow(RangeError);
  });
});

describe('tick loop under load', () => {
  it('runs many snakes for many ticks without throwing', () => {
    const s = new Simulation({ ...config, targetFood: 300 });
    const world = s.createWorld();

    for (let i = 0; i < 30; i += 1) s.spawnSnake(world, `p${i}`, `n${i}`);

    for (let tick = 0; tick < 120; tick += 1) {
      for (let i = 0; i < 30; i += 1) {
        s.enqueueInput(world, `p${i}`, {
          seq: tick + 1,
          angle: Math.sin((tick + i) / 8),
          boost: i % 3 === 0,
          dt: 33,
        });
      }
      s.step(world);
    }

    expect(world.tick).toBe(120);
    expect(s.aliveCount(world)).toBeGreaterThan(0);
  });
});
