import type { Logger } from '@arena/logger';
import type { RedisClient } from '@arena/redis';
import { randomUUID } from 'node:crypto';

import { config, TICK_INTERVAL_MS } from '../config.js';
import type { ArenaServer } from '../io/socket-server.js';
import { playersGauge, roomsGauge, tickLag } from '../metrics.js';
import { Room } from './room.js';

/**
 * How long a published result stays readable.
 *
 * Long enough to outlive settlement's retry budget, so a worker that is down
 * when the match ends still finds the standings when it comes back.
 */
const RESULT_TTL_SECONDS = 24 * 60 * 60;

export interface RoomManagerOptions {
  logger: Logger;
  redis: RedisClient;
  io: ArenaServer;
}

/**
 * Owns every room hosted by this process.
 *
 * All rooms share one tick loop rather than one timer each. Node has a single
 * event loop, so N timers only add scheduling jitter; a single loop iterating
 * rooms gives a far more stable frame time under load.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  readonly log: Logger;
  readonly redis: RedisClient;
  private readonly io: ArenaServer;

  private loopHandle: NodeJS.Timeout | null = null;
  private nextTickAt = 0;
  private running = false;

  constructor(options: RoomManagerOptions) {
    this.log = options.logger;
    this.redis = options.redis;
    this.io = options.io;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get playerCount(): number {
    let total = 0;
    for (const room of this.rooms.values()) total += room.playerCount;
    return total;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** Returns the room, creating it on first join. */
  ensureRoom(
    roomId: string,
    mode = 'casual',
    region = 'us-east',
    gameId: string | null = null,
  ): Room {
    const existing = this.rooms.get(roomId);
    if (existing) {
      // A room is created by whichever handshake arrives first. If that one was
      // a direct entry it carried no game id, so the first ticket that does
      // supplies it rather than leaving the match unsettleable.
      if (existing.gameId === null && gameId !== null) existing.gameId = gameId;
      return existing;
    }

    if (this.rooms.size >= config.MAX_ROOMS_PER_NODE) {
      throw new Error(`Node ${config.NODE_ID} is at its room cap`);
    }

    const room = new Room({
      roomId,
      mode,
      region,
      maxPlayers: config.MAX_PLAYERS_PER_ROOM,
      // Seeded from the room id so a replay can reproduce the world exactly.
      seed: hashSeed(roomId),
      io: this.io,
      gameId,
    });

    room.start();
    this.rooms.set(roomId, room);
    this.log.info({ roomId, rooms: this.rooms.size }, 'room created');

    return room;
  }

  closeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.close();
    this.rooms.delete(roomId);
    this.log.info({ roomId, rooms: this.rooms.size }, 'room closed');
  }

  /**
   * Fixed-timestep loop.
   *
   * Uses an accumulator against a monotonic deadline rather than a bare
   * `setInterval`, which drifts. Catch-up is capped at a few ticks: an uncapped
   * catch-up turns one slow tick into a death spiral where the loop can never
   * get back in front.
   */
  startLoop(): void {
    if (this.running) return;
    this.running = true;
    this.nextTickAt = Date.now();
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (!this.running) return;

    const delay = Math.max(0, this.nextTickAt - Date.now());
    this.loopHandle = setTimeout(() => this.runTick(), delay);
  }

  private runTick(): void {
    const now = Date.now();
    const lag = now - this.nextTickAt;
    tickLag.set(lag);

    // Cap catch-up at 5 ticks. Beyond that the node is overloaded and trying to
    // simulate the backlog only makes it worse — better to drop time.
    let steps = 1 + Math.floor(lag / TICK_INTERVAL_MS);
    if (steps > 5) {
      this.log.warn({ lag, dropped: steps - 5 }, 'tick loop behind; dropping simulated time');
      steps = 5;
      this.nextTickAt = now;
    }

    for (let i = 0; i < steps; i += 1) {
      for (const room of this.rooms.values()) {
        try {
          room.tick(now);
        } catch (error) {
          // One bad room must not take down every other room on the node.
          this.log.error({ err: error, roomId: room.roomId }, 'room tick failed');
        }
      }
      this.nextTickAt += TICK_INTERVAL_MS;
    }

    this.reportFinishedMatches();
    this.reapEmptyRooms();

    roomsGauge.set(this.rooms.size);
    playersGauge.set(this.playerCount);

    this.scheduleNext();
  }

  /**
   * Publishes standings for any match that has produced a winner.
   *
   * This is the hand-off to settlement, which polls `match:result:{gameId}` and
   * refuses to pay out without it. The room built the standings all along and
   * simply dropped them on close, so a staked match ended with the pot sitting
   * in escrow and no record of who had won it.
   *
   * Fire-and-forget against the tick loop: the loop must not await Redis, and a
   * failed write is retried on the next tick because `markReported` only runs
   * once the write has landed.
   */
  private reportFinishedMatches(): void {
    for (const room of this.rooms.values()) {
      if (!room.hasResult()) continue;

      const gameId = room.gameId;
      if (gameId === null) continue;

      const result = room.buildResult(gameId);
      // Marked before the await so a slow write cannot be started twice by the
      // next tick; a rejection below clears it so the attempt repeats.
      room.markReported();

      void this.redis
        .set(`match:result:${gameId}`, JSON.stringify(result), 'EX', RESULT_TTL_SECONDS)
        .then(() => {
          this.log.info(
            { roomId: room.roomId, gameId, standings: result.standings.length },
            'match result reported',
          );
          // Nothing left to play for. Draining lets the survivor's client see
          // the final frame, then the room is reaped once everyone has gone.
          room.drain();
        })
        .catch((error: unknown) => {
          room.unmarkReported();
          this.log.error({ err: error, roomId: room.roomId, gameId }, 'failed to report result');
        });
    }
  }

  private reapEmptyRooms(): void {
    for (const room of this.rooms.values()) {
      if (room.playerCount === 0 && room.status === 'draining') {
        this.closeRoom(room.roomId);
      }
    }
  }

  stopLoop(): void {
    this.running = false;
    if (this.loopHandle) {
      clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }
  }

  /** Drains every room and resolves once they are all empty or the timeout hits. */
  async drainAll(timeoutSeconds: number): Promise<void> {
    for (const room of this.rooms.values()) room.drain();

    const deadline = Date.now() + timeoutSeconds * 1_000;

    while (this.playerCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    for (const roomId of [...this.rooms.keys()]) this.closeRoom(roomId);
  }

  /** Saturation in 0..1, used by the matchmaker for placement. */
  saturation(): number {
    const byRooms = this.rooms.size / config.MAX_ROOMS_PER_NODE;
    const capacity = config.MAX_ROOMS_PER_NODE * config.MAX_PLAYERS_PER_ROOM;
    const byPlayers = capacity > 0 ? this.playerCount / capacity : 0;
    return Math.min(1, Math.max(byRooms, byPlayers));
  }

  newRoomId(): string {
    return randomUUID().replace(/-/g, '').slice(0, 16);
  }
}

/** Stable 32-bit seed from a room id, so a replay reproduces the world. */
function hashSeed(roomId: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < roomId.length; i += 1) {
    hash ^= roomId.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
