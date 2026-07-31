import { createHmac, timingSafeEqual } from 'node:crypto';

import { redisKeys, type RedisClient } from '@arena/redis';

import { config } from '../../config.js';
import type { ArenaServer } from '../socket-server.js';
import { clientAddress, ConnectionGuard } from './connection-guard.js';

export interface TicketClaims {
  playerId: string;
  wallet: string;
  roomId: string;
  nodeId: string;
  nickname: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Verifies a matchmaker-issued ticket.
 *
 * Mirrors `apps/matchmaker/src/placement/ticket.ts`. Duplicated rather than
 * shared because the two services must be independently deployable — but the
 * format is fixed by the HMAC, so a drift fails loudly rather than silently.
 */
export function verifyTicket(ticket: string, secret: string, now: number): TicketClaims {
  const parts = ticket.split('.');
  if (parts.length !== 2) throw new Error('malformed ticket');

  const [payload, signature] = parts as [string, string];
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('base64url'));
  const provided = Buffer.from(signature);

  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new Error('bad ticket signature');
  }

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TicketClaims;
  if (typeof claims.expiresAt !== 'number' || now >= claims.expiresAt) {
    throw new Error('ticket expired');
  }

  return claims;
}

/**
 * Handshake authentication.
 *
 * The client presents a single-use ticket minted by the matchmaker, not a raw
 * JWT. Two reasons: the ticket binds the player to one specific room on one
 * node, so a client cannot pick its own room; and it is consumed atomically in
 * Redis, which prevents the same session being opened twice.
 */
export function registerAuthMiddleware(io: ArenaServer, redis: RedisClient): void {
  const connections = new ConnectionGuard();

  // Sweeping on an interval rather than on every connection: the sweep is O(n)
  // over tracked addresses, and paying that per handshake is exactly the cost a
  // flood is trying to impose.
  // `unref` is what stops this holding the process open at shutdown; Socket.IO
  // has no 'close' event to hang a clearInterval on.
  const sweeper = setInterval(() => connections.sweep(Date.now()), 30_000);
  sweeper.unref();

  // Runs before ticket verification on purpose: rejecting here costs a map
  // lookup, whereas verifying costs an HMAC and a Redis round trip.
  io.use((socket, next) => {
    const address = clientAddress(socket.handshake, config.TRUST_PROXY);

    if (!connections.tryConsume(address, Date.now())) {
      next(new Error('RATE_LIMITED: too many connection attempts'));
      return;
    }

    next();
  });

  io.use((socket, next) => {
    void (async () => {
      try {
        const ticket = socket.handshake.auth?.ticket as string | undefined;
        if (!ticket) {
          next(new Error('PROTOCOL_MISMATCH: no ticket supplied'));
          return;
        }

        const claims = verifyTicket(ticket, config.JWT_SECRET, Date.now());

        if (claims.nodeId !== config.NODE_ID) {
          // The client reached the wrong node; re-matchmaking will send it to
          // the right one rather than us silently hosting a foreign room.
          next(new Error('INVALID_TICKET: ticket is for a different node'));
          return;
        }

        // GETDEL is atomic. A read-then-delete pair would let two concurrent
        // connections both observe the ticket as unused — exactly the duplicate
        // session the single-use rule exists to prevent.
        const consumed = await redis.getdel(redisKeys.matchTicket(claims.playerId));
        if (consumed === null) {
          next(new Error('INVALID_TICKET: ticket already used or expired'));
          return;
        }

        socket.data.playerId = claims.playerId;
        socket.data.wallet = claims.wallet;
        socket.data.roomId = claims.roomId;
        socket.data.nickname = claims.nickname;
        socket.data.joinedAt = Date.now();
        socket.data.inputBudget = config.MAX_INPUTS_PER_SECOND;

        next();
      } catch (error) {
        next(new Error(`INVALID_TICKET: ${(error as Error).message}`));
      }
    })();
  });
}
