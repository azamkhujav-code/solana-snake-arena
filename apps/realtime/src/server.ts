import { createLogger } from '@arena/logger';
import { createRedisClient } from '@arena/redis';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { config } from './config.js';
import { NodeRegistry } from './cluster/node-registry.js';
import { registerConnectionHandlers } from './io/handlers/connection.js';
import { registerAuthMiddleware } from './io/middleware/authenticate.js';
import { registerRateLimitMiddleware } from './io/middleware/rate-limit.js';
import { createSocketServer } from './io/socket-server.js';
import type { ArenaServer } from './io/socket-server.js';
import { playersGauge, registry, roomsGauge } from './metrics.js';
import { RoomManager } from './rooms/room-manager.js';

export interface RealtimeServer {
  app: FastifyInstance;
  io: ArenaServer;
  rooms: RoomManager;
  registryClient: NodeRegistry;
}

export async function buildServer(): Promise<RealtimeServer> {
  const logger = createLogger({
    service: config.SERVICE_NAME,
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
    base: { nodeId: config.NODE_ID },
  });

  // Annotated so Fastify keeps its default logger type parameter; see the note
  // in apps/gateway/src/app.ts.
  const loggerInstance: FastifyBaseLogger = logger;

  const app = Fastify({
    loggerInstance,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 16 * 1024,
    // Socket.IO owns the upgrade path; Fastify only serves health and metrics,
    // which are scraped constantly and would drown the logs.
    logController: new LogController({ disableRequestLogging: true }),
  });

  const redis = createRedisClient({
    url: config.REDIS_URL,
    clusterNodes: config.REDIS_CLUSTER_NODES,
    tls: config.REDIS_TLS,
    keyPrefix: config.REDIS_KEY_PREFIX,
    role: 'realtime',
    onError: (error, role) => logger.error({ err: error, role }, 'redis connection error'),
  });

  const io = await createSocketServer(app, logger);
  const rooms = new RoomManager({ logger, redis, io });
  const registryClient = new NodeRegistry(redis, rooms, logger);

  registerAuthMiddleware(io, redis);
  registerRateLimitMiddleware(io);
  registerConnectionHandlers(io, rooms, logger);

  app.get('/health/live', { logLevel: 'silent' }, async () => ({ status: 'ok' }));

  app.get('/health/ready', { logLevel: 'silent' }, async (_request, reply) => {
    // A draining node must fail readiness so the load balancer stops sending
    // new WebSocket upgrades while existing games finish.
    const draining = process.env.ARENA_DRAINING === 'true';
    void reply.status(draining ? 503 : 200);
    return {
      status: draining ? 'draining' : 'ok',
      rooms: rooms.roomCount,
      players: rooms.playerCount,
    };
  });

  app.get('/metrics', { logLevel: 'silent' }, async (_request, reply) => {
    roomsGauge.set(rooms.roomCount);
    playersGauge.set(rooms.playerCount);
    void reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  app.addHook('onClose', async () => {
    await redis.quit();
  });

  return { app, io, rooms, registryClient };
}
