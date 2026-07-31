import {
  BASE_SPEED,
  BOOST_MASS_DRAIN_PER_SECOND,
  BOOST_SPEED_MULTIPLIER,
  FOOD_MASS_MAX,
  FOOD_MASS_MIN,
  MAX_TURN_RATE_RAD_PER_SEC,
  MIN_BOOST_MASS,
  SEGMENT_SPACING,
  STARTING_MASS,
  type InputCommand,
} from '@arena/protocol';

import { SpatialHash } from './spatial-hash.js';
import type {
  DeathEvent,
  EntityId,
  FoodEntity,
  SimulationConfig,
  SnakeEntity,
  TickResult,
  WorldState,
} from './types.js';

/**
 * Seeded, deterministic PRNG (mulberry32).
 *
 * The simulation must never call `Math.random()` — the client replays this
 * exact stream during prediction, and a divergent RNG is indistinguishable from
 * a desync bug while being far harder to reproduce.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Body radius grows with the square root of mass, so girth scales sub-linearly. */
export function radiusForMass(mass: number): number {
  return 8 + Math.sqrt(Math.max(0, mass)) * 1.6;
}

/** Spine points a snake of this mass should carry. */
export function lengthForMass(mass: number): number {
  return Math.min(400, Math.floor(6 + Math.max(0, mass) * 0.9));
}

/** Score shown on the leaderboard. Mass is the only input, so it cannot be forged. */
export function scoreForMass(mass: number): number {
  return Math.max(0, Math.floor((mass - STARTING_MASS) * 10));
}

/**
 * Shortest signed angular difference in (-π, π].
 *
 * Naive subtraction makes a snake steering across the ±π boundary spin the long
 * way round, which reads as a stutter at exactly one heading.
 */
export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

const SPINE_CAPACITY = 420;

export class Simulation {
  readonly config: SimulationConfig;
  private readonly dtSeconds: number;
  private readonly targetFood: number;

  /** Rebuilt each tick; reused so the tick loop does not allocate. */
  private readonly bodyHash: SpatialHash;
  private readonly foodHash: SpatialHash;
  private readonly bodyOwner = new Map<EntityId, EntityId>();
  private readonly bodyPoint = new Map<EntityId, number>();
  private readonly queryScratch: EntityId[] = [];

  constructor(config: SimulationConfig) {
    this.config = config;
    this.dtSeconds = 1 / config.tickRateHz;
    this.bodyHash = new SpatialHash(config.cellSize);
    this.foodHash = new SpatialHash(config.cellSize);

    const area = Math.PI * config.worldRadius ** 2;
    this.targetFood = config.targetFood ?? Math.floor((area / 1_000_000) * 220);
  }

  createWorld(): WorldState {
    const world: WorldState = {
      tick: 0,
      elapsedMs: 0,
      snakes: new Map(),
      food: new Map(),
      playerIndex: new Map(),
      pendingInputs: new Map(),
      nextEntityId: 1,
      radius: this.config.worldRadius,
      random: createRng(this.config.seed),
    };

    for (let i = 0; i < this.targetFood; i += 1) this.spawnFood(world);
    return world;
  }

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  spawnSnake(world: WorldState, playerId: string, nickname: string, isBot = false): SnakeEntity {
    const existing = world.playerIndex.get(playerId);
    if (existing !== undefined) {
      const snake = world.snakes.get(existing);
      if (snake) return snake;
    }

    const position = this.findSpawnPoint(world);
    const angle = world.random() * Math.PI * 2;

    const spine = new Float32Array(SPINE_CAPACITY * 2);
    const snake: SnakeEntity = {
      id: world.nextEntityId++,
      playerId,
      nickname,
      spine,
      headIndex: 0,
      spineLength: 1,
      spineCapacity: SPINE_CAPACITY,
      angle,
      targetAngle: angle,
      speed: BASE_SPEED,
      mass: STARTING_MASS,
      radius: radiusForMass(STARTING_MASS),
      boosting: false,
      alive: true,
      isBot,
      lastAckSeq: 0,
      spawnedAtTick: world.tick,
      kills: 0,
      score: 0,
      boostDebt: 0,
      sinceLastPoint: 0,
    };

    spine[0] = position.x;
    spine[1] = position.y;

    // Seed the tail behind the head so a fresh snake has a body to render.
    const initial = lengthForMass(STARTING_MASS);
    for (let i = 1; i < initial; i += 1) {
      const index = (snake.headIndex - i + snake.spineCapacity) % snake.spineCapacity;
      spine[index * 2] = position.x - Math.cos(angle) * SEGMENT_SPACING * i;
      spine[index * 2 + 1] = position.y - Math.sin(angle) * SEGMENT_SPACING * i;
    }
    snake.spineLength = initial;

    world.snakes.set(snake.id, snake);
    world.playerIndex.set(playerId, snake.id);
    return snake;
  }

  despawnSnake(world: WorldState, playerId: string, scatter = true): void {
    const id = world.playerIndex.get(playerId);
    if (id === undefined) return;

    const snake = world.snakes.get(id);
    if (snake && scatter) this.scatterMass(world, snake);

    world.snakes.delete(id);
    world.playerIndex.delete(playerId);
    world.pendingInputs.delete(id);
  }

  /**
   * Finds a spawn point clear of other snakes.
   *
   * Bounded attempts, then the best candidate found. An unbounded search would
   * hang the tick loop when the world is genuinely crowded.
   */
  private findSpawnPoint(world: WorldState): { x: number; y: number } {
    let best = { x: 0, y: 0 };
    let bestDistance = -1;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      // sqrt keeps the distribution uniform over the disc rather than clumping
      // everything near the centre.
      const r = Math.sqrt(world.random()) * world.radius * 0.85;
      const theta = world.random() * Math.PI * 2;
      const candidate = { x: Math.cos(theta) * r, y: Math.sin(theta) * r };

      let nearest = Number.POSITIVE_INFINITY;
      for (const snake of world.snakes.values()) {
        if (!snake.alive) continue;
        const head = this.headOf(snake);
        const distance = Math.hypot(head.x - candidate.x, head.y - candidate.y);
        if (distance < nearest) nearest = distance;
      }

      if (nearest > 400) return candidate;
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = candidate;
      }
    }

    return best;
  }

  private spawnFood(world: WorldState, x?: number, y?: number, mass?: number): FoodEntity {
    let px = x;
    let py = y;

    if (px === undefined || py === undefined) {
      const r = Math.sqrt(world.random()) * world.radius * 0.97;
      const theta = world.random() * Math.PI * 2;
      px = Math.cos(theta) * r;
      py = Math.sin(theta) * r;
    }

    const food: FoodEntity = {
      id: world.nextEntityId++,
      x: px,
      y: py,
      mass: mass ?? FOOD_MASS_MIN + world.random() * (FOOD_MASS_MAX - FOOD_MASS_MIN),
      hue: Math.floor(world.random() * 360),
      expiresAtTick: null,
    };

    world.food.set(food.id, food);
    return food;
  }

  /**
   * Drops a dead snake's mass as food.
   *
   * Deliberately lossy (60%): returning the full mass would make the food
   * supply grow without bound every time two large snakes collided.
   */
  private scatterMass(world: WorldState, snake: SnakeEntity): void {
    const total = snake.mass * 0.6;
    const drops = Math.min(60, Math.max(3, Math.floor(total / 4)));
    const per = total / drops;

    for (let i = 0; i < drops; i += 1) {
      const pointIndex = Math.floor((i / drops) * snake.spineLength);
      const point = this.pointAt(snake, pointIndex);
      const jitterX = (world.random() - 0.5) * 30;
      const jitterY = (world.random() - 0.5) * 30;

      const food = this.spawnFood(world, point.x + jitterX, point.y + jitterY, per);
      // Death food decays so a quiet corner of the map does not silently fill.
      food.expiresAtTick = world.tick + this.config.tickRateHz * 120;
    }
  }

  // -------------------------------------------------------------------------
  // Spine access
  // -------------------------------------------------------------------------

  headOf(snake: SnakeEntity): { x: number; y: number } {
    return {
      x: snake.spine[snake.headIndex * 2] ?? 0,
      y: snake.spine[snake.headIndex * 2 + 1] ?? 0,
    };
  }

  /** `offset` 0 is the head, increasing towards the tail. */
  pointAt(snake: SnakeEntity, offset: number): { x: number; y: number } {
    const clamped = Math.min(Math.max(0, offset), snake.spineLength - 1);
    const index = (snake.headIndex - clamped + snake.spineCapacity) % snake.spineCapacity;
    return { x: snake.spine[index * 2] ?? 0, y: snake.spine[index * 2 + 1] ?? 0 };
  }

  private pushPoint(snake: SnakeEntity, x: number, y: number): void {
    snake.headIndex = (snake.headIndex + 1) % snake.spineCapacity;
    snake.spine[snake.headIndex * 2] = x;
    snake.spine[snake.headIndex * 2 + 1] = y;

    const capacity = Math.min(lengthForMass(snake.mass), snake.spineCapacity);
    snake.spineLength = Math.min(snake.spineLength + 1, capacity);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  enqueueInput(world: WorldState, playerId: string, command: InputCommand): void {
    const id = world.playerIndex.get(playerId);
    if (id === undefined) return;

    const queue = world.pendingInputs.get(id);
    if (queue) queue.push(command);
    else world.pendingInputs.set(id, [command]);
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  /**
   * Advances the world exactly one fixed timestep.
   *
   * Order matters: inputs, then movement, then eating, then collisions. Doing
   * collisions before movement would let a snake pass through a body it should
   * have hit, one tick per frame.
   */
  step(world: WorldState): TickResult {
    const result: TickResult = { tick: world.tick, deaths: [], foodConsumed: 0, foodSpawned: 0 };

    this.applyInputs(world);
    this.moveSnakes(world);

    this.rebuildFoodHash(world);
    result.foodConsumed = this.consumeFood(world);

    this.rebuildBodyHash(world);
    this.detectCollisions(world, result.deaths);

    result.foodSpawned = this.maintainFood(world);
    this.expireFood(world);

    world.tick += 1;
    world.elapsedMs += this.dtSeconds * 1_000;
    result.tick = world.tick;

    return result;
  }

  private applyInputs(world: WorldState): void {
    for (const [id, queue] of world.pendingInputs) {
      const snake = world.snakes.get(id);
      if (!snake || !snake.alive) {
        queue.length = 0;
        continue;
      }

      // Only the newest input matters for heading; older ones in the same tick
      // are superseded. The sequence number is still advanced so the client can
      // reconcile everything it sent.
      for (const command of queue) {
        if (command.seq > snake.lastAckSeq) {
          snake.targetAngle = command.angle;
          snake.boosting = command.boost;
          snake.lastAckSeq = command.seq;
        }
      }
      queue.length = 0;
    }
  }

  private moveSnakes(world: WorldState): void {
    const maxTurn = MAX_TURN_RATE_RAD_PER_SEC * this.dtSeconds;

    for (const snake of world.snakes.values()) {
      if (!snake.alive) continue;

      // Turn rate is clamped server-side; a client asking to spin 180° in one
      // tick gets the clamp, not the turn.
      const delta = angleDelta(snake.angle, snake.targetAngle);
      snake.angle += Math.max(-maxTurn, Math.min(maxTurn, delta));

      const canBoost = snake.boosting && snake.mass > MIN_BOOST_MASS;
      snake.speed = BASE_SPEED * (canBoost ? BOOST_SPEED_MULTIPLIER : 1);

      if (canBoost) {
        snake.boostDebt += BOOST_MASS_DRAIN_PER_SECOND * this.dtSeconds;
        if (snake.boostDebt >= 1) {
          const drained = Math.floor(snake.boostDebt);
          snake.boostDebt -= drained;
          this.setMass(snake, snake.mass - drained);
        }
      }

      const head = this.headOf(snake);
      const distance = snake.speed * this.dtSeconds;
      const nextX = head.x + Math.cos(snake.angle) * distance;
      const nextY = head.y + Math.sin(snake.angle) * distance;

      snake.sinceLastPoint += distance;
      if (snake.sinceLastPoint >= SEGMENT_SPACING) {
        snake.sinceLastPoint -= SEGMENT_SPACING;
        this.pushPoint(snake, nextX, nextY);
      } else {
        // Between spine points the head slides without recording, so the body
        // keeps even spacing regardless of speed.
        snake.spine[snake.headIndex * 2] = nextX;
        snake.spine[snake.headIndex * 2 + 1] = nextY;
      }
    }
  }

  private setMass(snake: SnakeEntity, mass: number): void {
    snake.mass = Math.max(1, mass);
    snake.radius = radiusForMass(snake.mass);
    snake.score = scoreForMass(snake.mass);

    const capacity = Math.min(lengthForMass(snake.mass), snake.spineCapacity);
    if (snake.spineLength > capacity) snake.spineLength = capacity;
  }

  private rebuildFoodHash(world: WorldState): void {
    this.foodHash.clear();
    for (const food of world.food.values()) this.foodHash.insert(food.id, food.x, food.y);
  }

  private consumeFood(world: WorldState): number {
    let consumed = 0;

    for (const snake of world.snakes.values()) {
      if (!snake.alive) continue;

      const head = this.headOf(snake);
      const reach = snake.radius + 14;
      const candidates = this.foodHash.queryCircle(head.x, head.y, reach, this.queryScratch);

      for (const foodId of candidates) {
        const food = world.food.get(foodId);
        if (!food) continue;

        if (Math.hypot(food.x - head.x, food.y - head.y) <= reach) {
          this.setMass(snake, snake.mass + food.mass);
          world.food.delete(foodId);
          this.foodHash.remove(foodId, food.x, food.y);
          consumed += 1;
        }
      }
    }

    return consumed;
  }

  /**
   * Indexes every body point except the few nearest each head.
   *
   * Skipping the leading points is what stops a snake colliding with its own
   * neck — those points are always within the head's radius by construction.
   */
  private rebuildBodyHash(world: WorldState): void {
    this.bodyHash.clear();
    this.bodyOwner.clear();
    this.bodyPoint.clear();

    let key = 1;
    for (const snake of world.snakes.values()) {
      if (!snake.alive) continue;

      for (let offset = 4; offset < snake.spineLength; offset += 1) {
        const point = this.pointAt(snake, offset);
        this.bodyHash.insert(key, point.x, point.y);
        this.bodyOwner.set(key, snake.id);
        this.bodyPoint.set(key, offset);
        key += 1;
      }
    }
  }

  private detectCollisions(world: WorldState, deaths: DeathEvent[]): void {
    for (const snake of world.snakes.values()) {
      if (!snake.alive) continue;

      const head = this.headOf(snake);

      // World boundary.
      if (Math.hypot(head.x, head.y) >= world.radius) {
        snake.alive = false;
        deaths.push({
          victim: snake.id,
          victimPlayerId: snake.playerId,
          killer: null,
          killerPlayerId: null,
          cause: 'wall',
          finalScore: snake.score,
        });
        continue;
      }

      const candidates = this.bodyHash.queryCircle(
        head.x,
        head.y,
        snake.radius + 40,
        this.queryScratch,
      );

      for (const candidateKey of candidates) {
        const ownerId = this.bodyOwner.get(candidateKey);
        if (ownerId === undefined || ownerId === snake.id) continue;

        const other = world.snakes.get(ownerId);
        if (!other || !other.alive) continue;

        const offset = this.bodyPoint.get(candidateKey) ?? 0;
        const point = this.pointAt(other, offset);

        if (Math.hypot(point.x - head.x, point.y - head.y) <= snake.radius + other.radius) {
          snake.alive = false;
          other.kills += 1;
          deaths.push({
            victim: snake.id,
            victimPlayerId: snake.playerId,
            killer: other.id,
            killerPlayerId: other.playerId,
            cause: 'collision',
            finalScore: snake.score,
          });
          break;
        }
      }
    }

    // Scatter after the sweep so a snake that died this tick cannot be eaten by
    // its own killer within the same tick.
    for (const death of deaths) {
      const snake = world.snakes.get(death.victim);
      if (snake) this.scatterMass(world, snake);
    }
  }

  private maintainFood(world: WorldState): number {
    let spawned = 0;
    // Trickle rather than refilling in one go: a burst would spike both the
    // snapshot size and the tick duration.
    const deficit = this.targetFood - world.food.size;
    const budget = Math.min(8, Math.max(0, deficit));

    for (let i = 0; i < budget; i += 1) {
      this.spawnFood(world);
      spawned += 1;
    }
    return spawned;
  }

  private expireFood(world: WorldState): void {
    if (world.tick % 30 !== 0) return; // sweeping every tick is wasted work

    for (const [id, food] of world.food) {
      if (food.expiresAtTick !== null && world.tick >= food.expiresAtTick) {
        world.food.delete(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Top N snakes by score. Recomputed on demand, not every tick. */
  leaderboard(world: WorldState, limit = 10): SnakeEntity[] {
    const alive: SnakeEntity[] = [];
    for (const snake of world.snakes.values()) if (snake.alive) alive.push(snake);

    alive.sort((a, b) => b.score - a.score || a.id - b.id);
    return alive.slice(0, limit);
  }

  getByPlayerId(world: WorldState, playerId: string): SnakeEntity | undefined {
    const id = world.playerIndex.get(playerId);
    return id === undefined ? undefined : world.snakes.get(id);
  }

  aliveCount(world: WorldState): number {
    let count = 0;
    for (const snake of world.snakes.values()) if (snake.alive) count += 1;
    return count;
  }
}
