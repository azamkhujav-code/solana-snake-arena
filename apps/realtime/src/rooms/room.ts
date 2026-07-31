import { Simulation, type SnakeEntity, type WorldState } from '@arena/game-core';
import {
  AOI_RADIUS,
  encodeSnapshot,
  ServerEvent,
  type FoodState,
  type InputCommand,
  type LeaderboardEntry,
  type SnakeState,
  type Snapshot,
} from '@arena/protocol';

import { config, TICKS_PER_SNAPSHOT } from '../config.js';
import { createAoiView, updateAoiView, withinRadius, type AoiView } from './aoi.js';
import type { ArenaServer } from '../io/socket-server.js';
import { snapshotBytes, tickDuration } from '../metrics.js';

export type RoomStatus = 'warming' | 'active' | 'draining' | 'closed';

export interface RoomOptions {
  roomId: string;
  mode: string;
  region: string;
  maxPlayers: number;
  seed: number;
  io: ArenaServer;
  /** The game this room plays out. Null for direct entry, which has no stake. */
  gameId?: string | null;
}

interface Seat {
  playerId: string;
  socketId: string;
  nickname: string;
  aoi: AoiView;
  /** Set when the socket drops; the snake survives until this expires. */
  disconnectedAtMs: number | null;
  shadowbanned: boolean;
}

/**
 * One game world.
 *
 * A room is the unit of sharding: it lives entirely inside one Node process, so
 * the simulation never needs cross-process locking. Scaling out means adding
 * rooms and nodes, never splitting a single world across machines.
 */
export class Room {
  readonly roomId: string;
  readonly mode: string;
  readonly region: string;
  readonly maxPlayers: number;

  status: RoomStatus = 'warming';
  world!: WorldState;
  readonly simulation: Simulation;

  private readonly io: ArenaServer;
  private readonly seats = new Map<string, Seat>();
  /** Ids removed since each viewer's last snapshot, so deltas stay correct. */
  private readonly recentlyRemoved: string[] = [];
  private ticksSinceSnapshot = 0;
  private leaderboardCache: LeaderboardEntry[] = [];
  /**
   * Score and kills captured at death.
   *
   * The snake is despawned on death, taking its counters with it — but the
   * player still placed, and settlement rejects a report that omits an entrant.
   */
  /**
   * Score and kills captured at the moment of death.
   *
   * A dead player's snake is despawned, so the figures have to be taken before
   * the entity disappears — otherwise settlement sees a zero for anyone who did
   * not survive to the end.
   */
  private readonly finalScores = new Map<string, { score: number; kills: number }>();

  /**
   * Elimination order: the tick and wall time at which each player died.
   *
   * This is what decides the winner. The prize goes to the **last snake
   * standing**, not the highest score — a player can farm a huge score and then
   * die in the first minute, and paying them would contradict the one rule
   * every player knows.
   */
  private readonly eliminations = new Map<string, { tick: number; survivedMs: number }>();

  /** Increments per death, so ties on the same tick still order deterministically. */
  private eliminationCounter = 0;

  /**
   * The game this room settles as, when a launch prepared one.
   *
   * Mutable because a room is created by the first handshake that names it, and
   * the manager keys rooms by id alone — the game id rides in on the ticket, so
   * it is learned rather than constructed.
   */
  gameId: string | null;

  /**
   * Everyone who ever held a seat.
   *
   * `seats` empties as players leave, so it cannot answer "was this a match or
   * one person alone" by the time the last snake is standing — which is exactly
   * when that question decides whether a result is worth reporting.
   */
  private readonly entrants = new Set<string>();

  /** Set once standings have been handed to the manager, so they go out once. */
  private reported = false;

  constructor(options: RoomOptions) {
    this.roomId = options.roomId;
    this.mode = options.mode;
    this.region = options.region;
    this.maxPlayers = options.maxPlayers;
    this.io = options.io;
    this.gameId = options.gameId ?? null;

    this.simulation = new Simulation({
      tickRateHz: config.TICK_RATE_HZ,
      worldRadius: 8_000,
      maxPlayers: options.maxPlayers,
      maxBots: 0,
      cellSize: config.AOI_CELL_SIZE,
      seed: options.seed,
    });
  }

  get playerCount(): number {
    return this.seats.size;
  }

  get isFull(): boolean {
    return this.seats.size >= this.maxPlayers;
  }

  start(): void {
    this.world = this.simulation.createWorld();
    this.status = 'active';
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  addPlayer(playerId: string, socketId: string, nickname: string): void {
    // `RoomManager.ensureRoom` always starts a room before returning it, so
    // reaching here unstarted means a caller bypassed the manager. Named
    // explicitly because the alternative is a TypeError about `playerIndex`,
    // which tells whoever finds it in the logs nothing at all.
    if (!this.world) throw new Error(`Room ${this.roomId} has not been started`);

    const existing = this.seats.get(playerId);

    if (existing) {
      // Reconnect within the grace window: reuse the live snake rather than
      // spawning a new one, so the player keeps their run.
      existing.socketId = socketId;
      existing.disconnectedAtMs = null;
      // The client has no state after a reload, so its view starts empty.
      existing.aoi = createAoiView();
      return;
    }

    this.seats.set(playerId, {
      playerId,
      socketId,
      nickname,
      aoi: createAoiView(),
      disconnectedAtMs: null,
      shadowbanned: false,
    });
    this.entrants.add(playerId);

    this.simulation.spawnSnake(this.world, playerId, nickname);
  }

  /**
   * Marks a player disconnected but keeps their snake alive.
   *
   * Removing it immediately would cost a player their run for a two-second
   * network blip, which is the most common complaint in games like this.
   */
  markDisconnected(playerId: string, nowMs: number): void {
    const seat = this.seats.get(playerId);
    if (seat) seat.disconnectedAtMs = nowMs;
  }

  removePlayer(playerId: string): void {
    if (!this.seats.delete(playerId)) return;

    // Leaving is an elimination, and has to be recorded as one.
    //
    // Without this a player who quit had no entry here, so `buildResult` read
    // their elimination order as `Infinity` and ranked them *ahead* of everyone
    // still playing — quitting a staked match was the most reliable way to win
    // it. Capturing their score at the same moment matters for the same reason
    // the death path does it: the snake is about to be despawned.
    if (!this.eliminations.has(playerId)) {
      const snake = this.simulation.getByPlayerId(this.world, playerId);
      if (snake) {
        this.finalScores.set(playerId, { score: snake.score, kills: snake.kills });
      }

      this.eliminationCounter += 1;
      this.eliminations.set(playerId, {
        tick: this.eliminationCounter,
        survivedMs: Math.floor(this.world.elapsedMs),
      });
    }

    this.simulation.despawnSnake(this.world, playerId);
    this.recentlyRemoved.push(playerId);
  }

  setShadowbanned(playerId: string, value: boolean): void {
    const seat = this.seats.get(playerId);
    if (seat) seat.shadowbanned = value;
  }

  hasPlayer(playerId: string): boolean {
    return this.seats.has(playerId);
  }

  /**
   * Whether a seat is shadowbanned.
   *
   * An unknown player reads as shadowbanned: the only callers use this to
   * decide whether to broadcast on someone's behalf, and doing so for a seat
   * that no longer exists is the wrong default.
   */
  /**
   * Records an elimination directly.
   *
   * Exists so tests can drive the ranking without running a full simulation to
   * the point where snakes actually collide. Named to make its purpose obvious
   * at the call site — production code records eliminations from `TickResult`.
   */
  markEliminatedForTest(playerId: string, survivedMs: number): void {
    if (this.eliminations.has(playerId)) return;
    this.eliminationCounter += 1;
    this.eliminations.set(playerId, { tick: this.eliminationCounter, survivedMs });
  }

  isShadowbanned(playerId: string): boolean {
    return this.seats.get(playerId)?.shadowbanned ?? true;
  }

  applyInput(playerId: string, command: InputCommand): void {
    const seat = this.seats.get(playerId);
    // A shadowbanned player's inputs are accepted and discarded, so they cannot
    // tell they were caught.
    if (!seat || seat.shadowbanned) return;
    this.simulation.enqueueInput(this.world, playerId, command);
  }

  respawn(playerId: string): void {
    const seat = this.seats.get(playerId);
    if (!seat) return;

    this.simulation.despawnSnake(this.world, playerId, false);
    this.simulation.spawnSnake(this.world, playerId, seat.nickname);
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  tick(nowMs: number): void {
    if (this.status !== 'active' && this.status !== 'draining') return;

    const startedAt = process.hrtime.bigint();

    const result = this.simulation.step(this.world);

    for (const death of result.deaths) {
      const snake = this.simulation.getByPlayerId(this.world, death.victimPlayerId);
      this.finalScores.set(death.victimPlayerId, {
        score: death.finalScore,
        kills: snake?.kills ?? 0,
      });

      // First death recorded wins the lowest counter, so the *last* to die
      // sorts first. Only the first elimination per player counts: a respawn in
      // a free room must not overwrite when they were knocked out of a paid one.
      if (!this.eliminations.has(death.victimPlayerId)) {
        this.eliminationCounter += 1;
        this.eliminations.set(death.victimPlayerId, {
          tick: this.eliminationCounter,
          survivedMs: Math.floor(this.world.elapsedMs),
        });
      }

      // Broadcast to the room, not just the victim. The killer has to hear
      // about it too — otherwise no client can maintain a kill counter or a
      // kill feed, because only the server ever knew.
      this.io.to(this.roomId).emit(ServerEvent.Died, {
        playerId: death.victimPlayerId,
        killedBy: death.killerPlayerId,
        reason: death.cause,
        finalScore: death.finalScore,
        survivedMs: Math.floor(this.world.elapsedMs),
        matchId: null,
      });
    }

    this.evictExpiredDisconnects(nowMs);

    this.ticksSinceSnapshot += 1;
    if (this.ticksSinceSnapshot >= TICKS_PER_SNAPSHOT) {
      this.ticksSinceSnapshot = 0;
      this.broadcastSnapshots();
      this.recentlyRemoved.length = 0;
    }

    // Leaderboard changes slowly relative to the tick rate; recomputing and
    // broadcasting it every tick would be pure waste.
    if (this.world.tick % config.TICK_RATE_HZ === 0) {
      this.broadcastLeaderboard();
    }

    tickDuration.observe(Number(process.hrtime.bigint() - startedAt) / 1e9);
  }

  private evictExpiredDisconnects(nowMs: number): void {
    const grace = config.RECONNECT_GRACE_SECONDS * 1_000;

    for (const seat of this.seats.values()) {
      if (seat.disconnectedAtMs === null) continue;
      if (nowMs - seat.disconnectedAtMs >= grace) {
        this.removePlayer(seat.playerId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  /**
   * Builds and emits a per-viewer delta snapshot.
   *
   * This is the hot path. Each viewer gets only entities inside their AOI, so
   * cost scales with visible entities rather than room population.
   */
  broadcastSnapshots(): void {
    for (const seat of this.seats.values()) {
      if (seat.disconnectedAtMs !== null) continue;

      const snake = this.simulation.getByPlayerId(this.world, seat.playerId);
      // A dead player still watches, anchored where they died.
      const origin = snake ? this.simulation.headOf(snake) : { x: 0, y: 0 };

      const snapshot = this.buildSnapshot(seat, origin);
      const buffer = encodeSnapshot(snapshot, { origin });

      snapshotBytes.inc(buffer.byteLength);
      this.io.to(seat.socketId).emit(ServerEvent.Snapshot, buffer);
    }
  }

  private buildSnapshot(seat: Seat, origin: { x: number; y: number }): Snapshot {
    const snakes: SnakeState[] = [];
    const food: FoodState[] = [];
    const visibleIds: number[] = [];

    for (const other of this.world.snakes.values()) {
      if (!other.alive) continue;

      const head = this.simulation.headOf(other);
      if (!withinRadius(head.x, head.y, origin.x, origin.y, AOI_RADIUS)) continue;

      visibleIds.push(other.id);
      snakes.push(this.toSnakeState(other));
    }

    for (const pellet of this.world.food.values()) {
      if (!withinRadius(pellet.x, pellet.y, origin.x, origin.y, AOI_RADIUS)) continue;
      food.push({
        id: pellet.id,
        position: { x: pellet.x, y: pellet.y },
        mass: pellet.mass,
        hue: pellet.hue,
      });
    }

    const view = updateAoiView(seat.aoi, visibleIds);

    // Entities that left the view are despawned client-side. Without this the
    // client keeps rendering a snake that walked over the horizon.
    const removedFood: number[] = [];
    for (const id of view.exited) removedFood.push(id);

    const self = this.simulation.getByPlayerId(this.world, seat.playerId);

    return {
      tick: this.world.tick,
      serverTime: Math.floor(this.world.elapsedMs),
      ackSeq: self?.lastAckSeq ?? 0,
      snakes,
      food,
      removedSnakes: [...this.recentlyRemoved],
      removedFood,
    };
  }

  private toSnakeState(snake: SnakeEntity): SnakeState {
    const points: Array<{ x: number; y: number }> = [];
    // Cap the transmitted spine: beyond a screen's worth of body the extra
    // points are invisible and are pure bandwidth.
    const limit = Math.min(snake.spineLength, 120);

    for (let offset = 0; offset < limit; offset += 1) {
      points.push(this.simulation.pointAt(snake, offset));
    }

    return {
      id: snake.playerId,
      nickname: snake.nickname,
      points,
      angle: snake.angle,
      mass: snake.mass,
      radius: snake.radius,
      boosting: snake.boosting,
      isBot: snake.isBot,
    };
  }

  private broadcastLeaderboard(): void {
    const top = this.simulation.leaderboard(this.world, 10);

    this.leaderboardCache = top.map((snake, index) => ({
      playerId: snake.playerId,
      nickname: snake.nickname,
      score: snake.score,
      kills: snake.kills,
      rank: index + 1,
    }));

    this.io.to(this.roomId).emit(ServerEvent.Leaderboard, this.leaderboardCache);
  }

  get leaderboard(): LeaderboardEntry[] {
    return this.leaderboardCache;
  }

  /**
   * Final standings, ordered by score.
   *
   * Includes players who already died: they still placed, and omitting them
   * would make the settlement side reject the report for a missing entrant.
   * Placement is assigned here, on the authority, rather than inferred later
   * from scores that may have tied.
   */
  buildResult(gameId: string): {
    gameId: string;
    roomId: string;
    nodeId: string;
    endedAtMs: number;
    standings: Array<{
      playerId: string;
      placement: number;
      score: number;
      kills: number;
      survivedMs: number;
    }>;
  } {
    const matchMs = Math.floor(this.world.elapsedMs);

    // Over everyone who ever sat down, not the current seats.
    //
    // `removePlayer` deletes the seat, so anyone who was knocked out and left
    // had already vanished from here by the time the match resolved. Settlement
    // rejects a report that omits an entrant — `missing-player`, on the grounds
    // that a missing one would silently forfeit — so a match where the loser
    // quit could never be settled at all.
    const rows = [...this.entrants].map((playerId) => {
      const snake = this.simulation.getByPlayerId(this.world, playerId);
      const elimination = this.eliminations.get(playerId);

      return {
        playerId,
        score: snake?.score ?? this.finalScores.get(playerId)?.score ?? 0,
        kills: snake?.kills ?? this.finalScores.get(playerId)?.kills ?? 0,
        // Survivors are credited with the full match; the eliminated with the
        // moment they went out.
        survivedMs: elimination?.survivedMs ?? matchMs,
        // Never eliminated means still alive at the end. `Infinity` sorts them
        // ahead of everyone who died, which is exactly the ranking wanted.
        eliminationOrder: elimination?.tick ?? Number.POSITIVE_INFINITY,
      };
    });

    // Last standing wins. Survivors (no elimination) come first; among the
    // eliminated, whoever died latest ranks highest. Score breaks a tie between
    // two players knocked out on the same tick, and player id breaks that in
    // turn so two nodes replaying the same match agree on the ordering.
    rows.sort(
      (a, b) =>
        b.eliminationOrder - a.eliminationOrder ||
        b.score - a.score ||
        b.kills - a.kills ||
        a.playerId.localeCompare(b.playerId),
    );

    return {
      gameId,
      roomId: this.roomId,
      nodeId: config.NODE_ID,
      endedAtMs: Date.now(),
      standings: rows.map(({ eliminationOrder: _eliminationOrder, ...row }, index) => ({
        ...row,
        placement: index + 1,
      })),
    };
  }

  /** Players still holding a live snake. */
  aliveCount(): number {
    let alive = 0;
    for (const seat of this.seats.values()) {
      if (this.simulation.getByPlayerId(this.world, seat.playerId)) alive += 1;
    }
    return alive;
  }

  /**
   * Whether this match has produced a winner worth reporting.
   *
   * The last snake standing decides a staked match, so the moment at most one
   * remains alive there is nothing left to play for. Requires two entrants:
   * a lone player in a room they opened is not a match, and reporting one would
   * settle a pot they were the only contributor to.
   *
   * Reported once — the alive count stays at one for every tick after the
   * winner emerges, and settlement is not idempotent on repeat reports.
   */
  hasResult(): boolean {
    return (
      !this.reported &&
      this.gameId !== null &&
      this.entrants.size >= 2 &&
      this.aliveCount() <= 1 &&
      (this.status === 'active' || this.status === 'draining')
    );
  }

  /** Marks the standings as handed off. See `hasResult`. */
  markReported(): void {
    this.reported = true;
  }

  /** Reverses `markReported` so a failed publish is retried on the next tick. */
  unmarkReported(): void {
    this.reported = false;
  }

  /** Stops accepting joins and lets the room empty out. */
  drain(): void {
    this.status = 'draining';
  }

  close(): void {
    this.status = 'closed';
    this.seats.clear();
  }
}
