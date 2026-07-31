import { closeRedis, createRedisClient, type RedisClient } from '@arena/redis';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisClient;
  }
}

async function redisPlugin(app: FastifyInstance): Promise<void> {
  const redis = createRedisClient({
    url: config.REDIS_URL,
    clusterNodes: config.REDIS_CLUSTER_NODES,
    tls: config.REDIS_TLS,
    keyPrefix: config.REDIS_KEY_PREFIX,
    role: 'gateway',
    onError: (error, role) => app.log.error({ err: error, role }, 'redis connection error'),
  });

  // The explicit type argument is required: RedisClient is a union
  // (Redis | Cluster) and without it `decorate` resolves to its getter/setter
  // overload and rejects the value.
  app.decorate<RedisClient>('redis', redis);

  app.addHook('onClose', async () => {
    await closeRedis(redis);
  });
}

export default fp(redisPlugin, { name: 'redis' });
