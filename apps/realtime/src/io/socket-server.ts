import type { Logger } from '@arena/logger';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@arena/protocol';
import { createPubSubPair, waitForRedis } from '@arena/redis';
import { createAdapter } from '@socket.io/redis-adapter';
import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';

import { config } from '../config.js';

export type ArenaServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Creates the Socket.IO server bound to Fastify's HTTP server.
 *
 * The Redis adapter is required even though rooms never span processes: it is
 * what lets an operator broadcast to every node, and what lets the matchmaker
 * signal a specific node to drain. Game snapshots deliberately do NOT go
 * through it — they are emitted directly to local sockets, since routing 15 Hz
 * of per-player deltas through Redis would make Redis the bottleneck.
 */
export async function createSocketServer(app: FastifyInstance, log: Logger): Promise<ArenaServer> {
  const io: ArenaServer = new Server(app.server, {
    path: '/ws',
    // WebSocket only. Long-polling doubles connection count and breaks the
    // binary snapshot path.
    transports: ['websocket'],
    pingInterval: 5_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 4_096,
    // Snapshots are already packed binary; a second compression pass costs CPU
    // for almost no gain and adds latency.
    perMessageDeflate: false,
    connectionStateRecovery: {
      maxDisconnectionDuration: config.RECONNECT_GRACE_SECONDS * 1000,
      skipMiddlewares: false,
    },
    cors: {
      origin: config.CORS_ORIGINS,
      credentials: true,
    },
  });

  const { pub, sub } = createPubSubPair({
    url: config.REDIS_URL,
    clusterNodes: config.REDIS_CLUSTER_NODES,
    tls: config.REDIS_TLS,
    keyPrefix: config.REDIS_KEY_PREFIX,
    onError: (error, role) => log.error({ err: error, role }, 'socket adapter redis error'),
  });

  // `createAdapter` issues a `psubscribe` in its constructor, so both clients
  // must be connected before it is called. `enableOfflineQueue` is false by
  // design — a queued command against a dead Redis looks like it succeeded —
  // which turns that race into a hard crash on boot rather than a delay.
  await Promise.all([waitForRedis(pub), waitForRedis(sub)]);

  io.adapter(createAdapter(pub, sub));

  io.engine.on('connection_error', (err: { code: number; message: string }) => {
    log.warn({ code: err.code, message: err.message }, 'socket connection error');
  });

  return io;
}
