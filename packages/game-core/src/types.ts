import type { InputCommand } from '@arena/protocol';

/**
 * Internal simulation types.
 *
 * Deliberately different from the wire types in @arena/protocol: the simulation
 * stores flat typed arrays and integer ids for cache locality, while the wire
 * format optimises for size. Conversion happens at the edge.
 */

export interface Vector2 {
  x: number;
  y: number;
}

export type EntityId = number;

export interface SnakeEntity {
  id: EntityId;
  /** Stable public id used on the wire. */
  playerId: string;
  nickname: string;

  /**
   * Spine points as a ring buffer of interleaved x,y pairs.
   *
   * A ring buffer rather than an array that gets shifted: a snake at full
   * length records a point every tick, and `Array.shift()` on a few hundred
   * points per snake per tick is the difference between holding 30 Hz and not.
   */
  spine: Float32Array;
  /** Point index of the head within `spine`. */
  headIndex: number;
  /** How many points are currently valid. */
  spineLength: number;
  /** Capacity in points, not floats. */
  spineCapacity: number;

  angle: number;
  targetAngle: number;
  speed: number;
  mass: number;
  radius: number;
  boosting: boolean;
  alive: boolean;
  isBot: boolean;

  /** Last input sequence applied; echoed back for client reconciliation. */
  lastAckSeq: number;
  spawnedAtTick: number;
  kills: number;
  score: number;

  /** Accumulates fractional mass drained by boosting. */
  boostDebt: number;
  /** Distance travelled since the last spine point was recorded. */
  sinceLastPoint: number;
}

export interface FoodEntity {
  id: EntityId;
  x: number;
  y: number;
  mass: number;
  hue: number;
  /** Food dropped by a death decays so the map does not fill up. */
  expiresAtTick: number | null;
}

export interface WorldState {
  tick: number;
  /** Milliseconds since the room started; never wall-clock. */
  elapsedMs: number;
  snakes: Map<EntityId, SnakeEntity>;
  food: Map<EntityId, FoodEntity>;
  /** playerId -> entity id, so socket handlers can resolve without a scan. */
  playerIndex: Map<string, EntityId>;
  /** Inputs queued since the last step, per entity. */
  pendingInputs: Map<EntityId, InputCommand[]>;
  nextEntityId: EntityId;
  radius: number;
  /** Seeded PRNG. Never `Math.random` — the client replays this exact stream. */
  random: () => number;
}

export interface SimulationConfig {
  tickRateHz: number;
  worldRadius: number;
  maxPlayers: number;
  maxBots: number;
  cellSize: number;
  /** Seed for the deterministic RNG; logged so a match can be replayed. */
  seed: number;
  /** Target food count. Defaults from world area when omitted. */
  targetFood?: number;
}

export interface DeathEvent {
  victim: EntityId;
  victimPlayerId: string;
  killer: EntityId | null;
  killerPlayerId: string | null;
  cause: 'collision' | 'wall';
  finalScore: number;
}

export interface TickResult {
  tick: number;
  deaths: DeathEvent[];
  foodConsumed: number;
  foodSpawned: number;
}
