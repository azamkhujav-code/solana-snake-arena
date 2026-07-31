import type { Logger } from '@arena/logger';
import type { RedisClient } from '@arena/redis';

import { config } from '../config.js';
import type { RoomManager } from '../rooms/room-manager.js';

/**
 * Publishes this node's capacity so the matchmaker can place players.
 *
 * The registration key carries a TTL that the heartbeat refreshes. If the
 * process dies the key simply expires, so a crashed node stops receiving
 * players without needing any explicit deregistration or health-check sweep.
 */
export class NodeRegistry {
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    readonly redis: RedisClient,
    readonly rooms: RoomManager,
    readonly log: Logger,
  ) {}

  private payload(): string {
    return JSON.stringify({
      nodeId: config.NODE_ID,
      advertiseUrl: config.ADVERTISE_URL,
      region: config.DEPLOY_REGION,
      rooms: this.rooms.roomCount,
      players: this.rooms.playerCount,
      maxRooms: config.MAX_ROOMS_PER_NODE,
      saturation: this.rooms.saturation(),
      updatedAt: Date.now(),
      draining: this.draining,
    });
  }

  async register(): Promise<void> {
    await this.redis.sadd('cluster:nodes', config.NODE_ID);
    await this.redis.set(
      `cluster:node:${config.NODE_ID}`,
      this.payload(),
      'EX',
      config.NODE_HEARTBEAT_TTL_SECONDS,
    );
    this.log.info({ nodeId: config.NODE_ID }, 'node registered');
  }

  /**
   * Refreshes the heartbeat with current load.
   *
   * Saturation is reported rather than raw player count: a node can be well
   * under its player cap and still be unable to hold 30 Hz because one room
   * got dense, and placement needs to know that.
   */
  startHeartbeat(): void {
    if (this.timer) return;

    const intervalMs = Math.max(1_000, (config.NODE_HEARTBEAT_TTL_SECONDS * 1_000) / 3);

    this.timer = setInterval(() => {
      void this.redis
        .set(
          `cluster:node:${config.NODE_ID}`,
          this.payload(),
          'EX',
          config.NODE_HEARTBEAT_TTL_SECONDS,
        )
        .catch((error: unknown) => this.log.error({ err: error }, 'heartbeat failed'));
    }, intervalMs);

    this.timer.unref();
  }

  stopHeartbeat(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Marks the node as draining so placement stops choosing it immediately. */
  async markDraining(): Promise<void> {
    this.draining = true;
    await this.redis
      .set(`cluster:node:${config.NODE_ID}`, this.payload(), 'EX', 60)
      .catch(() => undefined);
  }

  async deregister(): Promise<void> {
    await this.redis.srem('cluster:nodes', config.NODE_ID).catch(() => undefined);
    await this.redis.del(`cluster:node:${config.NODE_ID}`).catch(() => undefined);
    this.log.info({ nodeId: config.NODE_ID }, 'node deregistered');
  }
}
