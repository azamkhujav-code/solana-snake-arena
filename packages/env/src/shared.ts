import { z } from 'zod';

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

export const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const solanaClusterSchema = z.enum(['devnet', 'testnet', 'mainnet-beta', 'localnet']);
export type SolanaCluster = z.infer<typeof solanaClusterSchema>;

/**
 * Comma-separated list -> trimmed string array.
 *
 * Note for callers: in Zod 4 `.default()` on a transformed schema takes the
 * OUTPUT type, so defaults here are arrays (`['a', 'b']`), not strings.
 */
export const csvSchema = z.string().transform((value) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean),
);

export const portSchema = z.coerce.number().int().min(1).max(65_535);

/** Accepts the usual truthy spellings. `.default()` takes a boolean. */
export const booleanSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/** Present in every service. */
export const baseEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  LOG_LEVEL: logLevelSchema.default('info'),
  LOG_PRETTY: booleanSchema.default(false),
  SERVICE_NAME: z.string().min(1).default('arena'),
  GIT_SHA: z.string().default('unknown'),
  DEPLOY_REGION: z.string().default('local'),
});

/** Postgres access, shared by every service that touches the database. */
export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /** Bypasses PgBouncer; required for Prisma migrations. */
  DIRECT_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
});

/** Redis is the backbone for pub/sub, presence, sessions and leaderboards. */
export const redisEnvSchema = z.object({
  REDIS_URL: z.string().min(1),
  /** Set when running Redis Cluster; overrides REDIS_URL for the data path. */
  REDIS_CLUSTER_NODES: csvSchema.optional(),
  REDIS_TLS: booleanSchema.default(false),
  REDIS_KEY_PREFIX: z.string().default('arena:'),
});

/** Signed-nonce wallet auth. */
export const authEnvSchema = z.object({
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /**
   * Access-token lifetime, in **seconds**.
   *
   * Numeric rather than a `'15m'` string because the revocation denylist TTL is
   * computed from it — a duration string would have to be parsed at the one
   * place where getting it wrong means either a Redis keyspace that grows
   * forever or a revoked token that quietly comes back to life.
   *
   * Short by design: it bounds the damage from a leaked token, and refresh
   * rotation makes the shortness invisible to the user.
   */
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .default(30 * 24 * 60 * 60),
  AUTH_NONCE_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  /**
   * Domain shown in the signed message, and pinned as the JWT `iss`/`aud`.
   *
   * It is what a user reads before approving a signature, so it must match the
   * site they believe they are on. Pinning it on the token stops one minted for
   * staging being replayed against production.
   */
  AUTH_DOMAIN: z.string().min(1).default('localhost:3000'),
});

export const solanaEnvSchema = z.object({
  SOLANA_CLUSTER: solanaClusterSchema.default('devnet'),
  SOLANA_RPC_URL: z.url(),
  SOLANA_WS_URL: z.url().optional(),
  SOLANA_COMMITMENT: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
  ARENA_PROGRAM_ID: z.string().min(32),
});

export const observabilityEnvSchema = z.object({
  METRICS_ENABLED: booleanSchema.default(true),
  METRICS_PORT: portSchema.default(9464),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  SENTRY_DSN: z.string().optional(),
});
