import { createGuardState, type InputGuardState } from '../../anticheat/validators.js';
import { config } from '../../config.js';
import type { ArenaServer } from '../socket-server.js';

/**
 * Per-socket guard state, keyed by socket id.
 *
 * Held in a module-level map rather than on `socket.data` so the shape stays
 * internal to the anti-cheat module and cannot be reshaped by a handler.
 */
const guards = new Map<string, InputGuardState>();

export function getGuard(socketId: string): InputGuardState {
  let guard = guards.get(socketId);
  if (!guard) {
    guard = createGuardState(Date.now(), config.MAX_INPUTS_PER_SECOND);
    guards.set(socketId, guard);
  }
  return guard;
}

export function releaseGuard(socketId: string): void {
  guards.delete(socketId);
}

export function guardCount(): number {
  return guards.size;
}

/**
 * Installs guard lifecycle.
 *
 * The limiter itself runs in-process on the input handler, not here: a Redis
 * round-trip per input packet at 20 Hz × 100k players would be two million
 * ops/sec. Redis is only involved when a socket is actually punished.
 */
export function registerRateLimitMiddleware(io: ArenaServer): void {
  io.use((socket, next) => {
    getGuard(socket.id);
    next();
  });

  io.on('connection', (socket) => {
    socket.on('disconnect', () => releaseGuard(socket.id));
  });
}
