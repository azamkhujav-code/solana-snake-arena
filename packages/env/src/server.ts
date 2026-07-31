import { z } from 'zod';

import { lazyEnv } from './parse.js';
import {
  authEnvSchema,
  baseEnvSchema,
  booleanSchema,
  csvSchema,
  databaseEnvSchema,
  observabilityEnvSchema,
  portSchema,
  redisEnvSchema,
  solanaEnvSchema,
} from './shared.js';

const httpEnvSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: csvSchema.default(['http://localhost:3000']),
  BODY_LIMIT_BYTES: z.coerce.number().int().default(1_048_576),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().default(15_000),
  TRUST_PROXY: booleanSchema.default(true),
  RATE_LIMIT_MAX: z.coerce.number().int().default(200),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(60_000),
  /**
   * Hard ceiling on concurrent sockets per process.
   *
   * A backstop, not a policy: the load balancer should shed load long before
   * this. It exists so a connection flood that gets past the edge exhausts the
   * listener rather than the heap, which fails visibly instead of by OOM.
   */
  MAX_CONNECTIONS: z.coerce.number().int().min(64).default(10_000),
});

/**
 * Gateway: stateless REST API. Handles wallet auth, profiles, leaderboards and
 * on-chain settlement requests. Scales purely horizontally behind an ALB.
 */
export const gatewayEnvSchema = baseEnvSchema
  .merge(httpEnvSchema)
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(authEnvSchema)
  .merge(solanaEnvSchema)
  .merge(observabilityEnvSchema)
  .extend({
    PORT: portSchema.default(4000),
    MATCHMAKER_INTERNAL_URL: z.url().default('http://localhost:4002'),
  });

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;
export const getGatewayEnv = lazyEnv('gateway', gatewayEnvSchema);

/**
 * Realtime: authoritative simulation + Socket.IO fan-out. Stateful and sharded
 * by room; every instance owns a disjoint set of rooms.
 */
export const realtimeEnvSchema = baseEnvSchema
  .merge(httpEnvSchema)
  .merge(redisEnvSchema)
  .merge(authEnvSchema)
  .merge(observabilityEnvSchema)
  .extend({
    PORT: portSchema.default(4001),

    /** Stable identity for this process; used as the room-ownership key. */
    NODE_ID: z.string().min(1).default('realtime-local-1'),
    /** Address other services and clients use to reach this exact instance. */
    ADVERTISE_URL: z.url().default('http://localhost:4001'),

    /** Simulation steps per second. */
    TICK_RATE_HZ: z.coerce.number().int().min(10).max(120).default(30),
    /** Snapshots pushed to clients per second; below tick rate to save bandwidth. */
    SNAPSHOT_RATE_HZ: z.coerce.number().int().min(5).max(60).default(15),

    /** Capacity knobs; the autoscaler reads the derived saturation metric. */
    MAX_ROOMS_PER_NODE: z.coerce.number().int().min(1).default(40),
    MAX_PLAYERS_PER_ROOM: z.coerce.number().int().min(2).max(500).default(120),

    /** Area-of-interest cell size in world units. Drives view culling. */
    AOI_CELL_SIZE: z.coerce.number().int().min(64).default(512),

    /** Reject clients whose input rate exceeds this; basic speed-hack defence. */
    MAX_INPUTS_PER_SECOND: z.coerce.number().int().min(10).default(60),

    /** Seconds a disconnected player's snake stays alive for reconnection. */
    RECONNECT_GRACE_SECONDS: z.coerce.number().int().min(0).max(120).default(15),

    /** Seconds to keep serving before exiting on SIGTERM. */
    DRAIN_TIMEOUT_SECONDS: z.coerce.number().int().min(0).default(30),

    /**
     * TTL on this node's registry entry, refreshed by the heartbeat.
     *
     * If the process dies the key expires and the matchmaker stops placing
     * players here — no explicit deregistration or health sweep needed.
     */
    NODE_HEARTBEAT_TTL_SECONDS: z.coerce.number().int().min(5).default(15),
  });

export type RealtimeEnv = z.infer<typeof realtimeEnvSchema>;
export const getRealtimeEnv = lazyEnv('realtime', realtimeEnvSchema);

/**
 * Matchmaker: room registry and placement. Small, stateless in front of Redis;
 * it decides which realtime node a joining player is sent to.
 */
export const matchmakerEnvSchema = baseEnvSchema
  .merge(httpEnvSchema)
  .merge(redisEnvSchema)
  .merge(authEnvSchema)
  .merge(observabilityEnvSchema)
  .extend({
    PORT: portSchema.default(4002),
    /** Seconds before an un-refreshed node registration is considered dead. */
    NODE_HEARTBEAT_TTL_SECONDS: z.coerce.number().int().min(5).default(15),
    /** Fill rooms to this ratio before opening a new one. */
    ROOM_TARGET_FILL_RATIO: z.coerce.number().min(0.1).max(1).default(0.8),
    PLACEMENT_STRATEGY: z.enum(['least-loaded', 'best-fit', 'region-affinity']).default('best-fit'),
    /**
     * Where to reach the gateway for entry-fee staking.
     *
     * The matchmaker has no database by design — it holds volatile queue state
     * in Redis. Money is the gateway's concern, so joining a paid room calls
     * across rather than reaching into a table this service should not know
     * about.
     */
    GATEWAY_INTERNAL_URL: z.url().default('http://localhost:4000'),
  });

export type MatchmakerEnv = z.infer<typeof matchmakerEnvSchema>;
export const getMatchmakerEnv = lazyEnv('matchmaker', matchmakerEnvSchema);

/**
 * Worker: the match cycle and settlement. The one process that both writes match
 * records and signs settlement transactions, so it needs database, Redis and
 * Solana access together.
 */
export const workerEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(solanaEnvSchema)
  .merge(observabilityEnvSchema)
  .extend({
    /** Stage jobs processed at once. Stages are IO-bound, so this can be high. */
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),

    /**
     * Disables the repeatable scheduler while leaving the worker consuming.
     * Run several workers with only one scheduler, or none during a drain.
     */
    WORKER_SCHEDULER_ENABLED: booleanSchema.default(true),

    /** Base58 secret key for the settlement authority, if this worker settles. */
    SETTLEMENT_AUTHORITY_SECRET: z.string().optional(),

    /**
     * Wallet that receives the platform fee at settlement.
     *
     * Optional: falls back to the settlement authority, which is what a
     * single-key local setup wants. The program checks it against
     * `Config.fee_destination` either way.
     */
    FEE_DESTINATION: z.string().optional(),
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export const getWorkerEnv = lazyEnv('worker', workerEnvSchema);

export { EnvValidationError, lazyEnv, parseEnv } from './parse.js';
export * from './shared.js';
