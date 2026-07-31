import { ServerEvent } from '@arena/protocol';
import type { FastifyBaseLogger } from 'fastify';

import type { ArenaServer } from '../io/socket-server.js';
import type { RoomManager } from '../rooms/room-manager.js';
import type { NodeRegistry } from './node-registry.js';

/**
 * Graceful drain on SIGTERM.
 *
 * The order is load-bearing. Deregister first so the matchmaker stops sending
 * new players, then tell connected clients to re-matchmake, and only then close.
 * Killing sockets first would dump every player into a reconnect storm aimed at
 * a node that is still advertised as healthy — they would be placed straight
 * back onto the node that is shutting down.
 */
export async function drainNode(options: {
  io: ArenaServer;
  rooms: RoomManager;
  registry: NodeRegistry;
  log: FastifyBaseLogger;
  timeoutSeconds: number;
}): Promise<void> {
  const { io, rooms, registry, log, timeoutSeconds } = options;

  // 1. Stop receiving new placements.
  await registry.markDraining();
  await registry.deregister();
  log.info('deregistered from the node registry');

  // 2. Tell clients to go elsewhere. Staggered so a full node does not
  //    stampede the matchmaker in a single millisecond.
  let index = 0;
  for (const [, socket] of io.sockets.sockets) {
    const jitter = (index % 20) * 100;
    socket.emit(ServerEvent.Migrate, {
      reason: 'node draining',
      reconnectAfterMs: 500 + jitter,
    });
    index += 1;
  }
  log.info({ sockets: index }, 'migration notices sent');

  // 3. Let in-flight games finish, up to the deadline.
  await rooms.drainAll(timeoutSeconds);
  log.info({ remaining: rooms.playerCount }, 'rooms drained');
}
