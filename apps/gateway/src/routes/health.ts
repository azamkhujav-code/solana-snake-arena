import { pingDatabase } from '@arena/db';
import type { FastifyInstance } from 'fastify';

import { config } from '../config.js';

/**
 * Liveness vs readiness are deliberately different.
 *
 * `/health/live` answers "is the process wedged?" and must not touch downstream
 * systems — otherwise a Redis blip restarts every pod at once. `/health/ready`
 * answers "should this replica receive traffic?" and does check dependencies.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const startedAt = Date.now();

  app.get('/health/live', { logLevel: 'silent', schema: { hide: true } }, async () => ({
    status: 'ok' as const,
    version: config.GIT_SHA,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    checks: {},
  }));

  app.get(
    '/health/ready',
    { logLevel: 'silent', schema: { hide: true } },
    async (_request, reply) => {
      const [dbOk, redisOk] = await Promise.all([
        pingDatabase(app.prisma),
        app.redis
          .ping()
          .then(() => true)
          .catch(() => false),
      ]);

      const healthy = dbOk && redisOk;
      void reply.status(healthy ? 200 : 503);

      return {
        status: healthy ? ('ok' as const) : ('degraded' as const),
        version: config.GIT_SHA,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        checks: {
          database: dbOk ? ('ok' as const) : ('fail' as const),
          redis: redisOk ? ('ok' as const) : ('fail' as const),
        },
      };
    },
  );
}
