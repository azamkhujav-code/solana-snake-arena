import type { Logger } from '@arena/logger';
import type { RedisClient } from '@arena/redis';
import { randomUUID } from 'node:crypto';

import { config, TICK_INTERVAL_MS } from '../config.js';
import type { ArenaServer } from '../io/socket-server.js';
import { playersGauge, roomsGauge, tickLag } from '../metrics.js';
import { Room } from './room.js';

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
  ensureRoom(roomId: string, mode = 'casual', region = 'us-east'): Room {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;

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

    this.reapEmptyRooms();

    roomsGauge.set(this.rooms.size);
    playersGauge.set(this.playerCount);

    this.scheduleNext();
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
