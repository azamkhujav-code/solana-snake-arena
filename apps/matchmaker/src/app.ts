import { createLogger } from '@arena/logger';
import { closeRedis, createRedisClient, redisKeys, type RedisClient } from '@arena/redis';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { collectDefaultMetrics, Registry } from 'prom-client';

import { config } from './config.js';
import lobbiesPlugin from './plugins/lobbies.js';
import swaggerPlugin from './plugins/swagger.js';
import { lobbyRoutes } from './routes/lobby.routes.js';
import { matchmakingRoutes } from './routes/match.routes.js';

export type AuthGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Access-token claims, mirroring what the gateway mints.
 *
 * Declared here as well as in the gateway because module augmentation does not
 * cross package boundaries — without it `request.user` is the untyped default
 * and every claim access is a compile error.
 */
export interface AccessTokenClaims {
  sub: string;
  wallet: string;
  role: 'PLAYER' | 'MODERATOR' | 'ADMIN';
  jti: string;
  /**
   * The player's chosen name, for display in game.
   *
   * Carried in the token because the matchmaker mints realtime tickets and has
   * no database to look a name up in. Without it the ticket fell back to the
   * player's UUID, so the in-game leaderboard and kill feed listed everyone as
   * a fragment like `c8ea7d36-ac66-46`.
   */
  nickname?: string | undefined;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenClaims;
    user: AccessTokenClaims;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisClient;
    authenticate: AuthGuard;
    requireRole: (...roles: AccessTokenClaims['role'][]) => AuthGuard;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  // See the note in apps/gateway/src/app.ts: annotating as FastifyBaseLogger
  // keeps Fastify's logger type parameter at its default, which every
  // third-party plugin is typed against.
  const loggerInstance: FastifyBaseLogger = createLogger({
    service: config.SERVICE_NAME,
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
  });

  const app = Fastify({
    loggerInstance,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.BODY_LIMIT_BYTES,
    requestTimeout: config.REQUEST_TIMEOUT_MS,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const redis = createRedisClient({
    url: config.REDIS_URL,
    clusterNodes: config.REDIS_CLUSTER_NODES,
    tls: config.REDIS_TLS,
    keyPrefix: config.REDIS_KEY_PREFIX,
    role: 'matchmaker',
    onError: (error, role) => app.log.error({ err: error, role }, 'redis connection error'),
  });
  // Explicit type argument: RedisClient is a union, and without it `decorate`
  // resolves to its getter/setter overload.
  app.decorate<RedisClient>('redis', redis);

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.CORS_ORIGINS, credentials: true });
  await app.register(jwt, { secret: config.JWT_SECRET });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    redis: redis as never,
    nameSpace: 'mm-rl:',
  });

  const authenticate: AuthGuard = async (request, _reply) => {
    await request.jwtVerify();

    // The gateway's revocation tombstones live in the same Redis, so honouring
    // them here costs one read and stops a banned player from being placed into
    // a room using a token minted seconds before the ban.
    const [revoked, cutoff] = await Promise.all([
      redis.exists(redisKeys.revokedToken(request.user.jti)),
      redis.get(redisKeys.sessionCutoff(request.user.sub)),
    ]);

    if (revoked === 1) throw app.httpErrors.unauthorized('Token has been revoked');

    const cutoffSeconds = cutoff === null ? null : Number.parseInt(cutoff, 10);
    const issuedAt = (request.user as { iat?: number }).iat;
    if (
      cutoffSeconds !== null &&
      Number.isFinite(cutoffSeconds) &&
      issuedAt !== undefined &&
      issuedAt < cutoffSeconds
    ) {
      throw app.httpErrors.unauthorized('Session was revoked; sign in again');
    }
  };
  app.decorate('authenticate', authenticate);

  // 403 rather than 401: the caller proved who they are and simply is not
  // permitted. See the note in the gateway's auth plugin.
  app.decorate(
    'requireRole',
    (...roles: AccessTokenClaims['role'][]): AuthGuard =>
      async (request, _reply) => {
        if (!roles.includes(request.user.role)) {
          throw app.httpErrors.forbidden('Insufficient role');
        }
      },
  );

  const metrics = new Registry();
  metrics.setDefaultLabels({ service: config.SERVICE_NAME });
  if (config.METRICS_ENABLED) collectDefaultMetrics({ register: metrics });

  app.get('/health/live', { logLevel: 'silent', schema: { hide: true } }, async () => ({
    status: 'ok',
  }));
  app.get(
    '/health/ready',
    { logLevel: 'silent', schema: { hide: true } },
    async (_request, reply) => {
      const ok = await redis
        .ping()
        .then(() => true)
        .catch(() => false);
      void reply.status(ok ? 200 : 503);
      return { status: ok ? 'ok' : 'degraded' };
    },
  );
  app.get('/metrics', { logLevel: 'silent', schema: { hide: true } }, async (_request, reply) => {
    void reply.header('content-type', metrics.contentType);
    return metrics.metrics();
  });

  await app.register(lobbiesPlugin);
  // Before the routes it documents: @fastify/swagger collects schemas as they
  // are registered, so anything registered earlier is absent from the spec.
  await app.register(swaggerPlugin);

  await app.register(matchmakingRoutes, { prefix: '/v1' });
  await app.register(lobbyRoutes, { prefix: '/v1' });

  app.addHook('onClose', async () => {
    await closeRedis(redis);
  });

  return app;
}
