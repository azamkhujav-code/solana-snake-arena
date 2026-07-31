import { createHmac, timingSafeEqual } from 'node:crypto';

import { redisKeys, type RedisClient } from '@arena/redis';

import { config } from '../../config.js';
import type { ArenaServer } from '../socket-server.js';
import { clientAddress, ConnectionGuard } from './connection-guard.js';

/**
 * Where a player is allowed back into, and for how long.
 *
 * Deliberately keyed by player rather than by ticket: the ticket is gone by the
 * time this matters, and the question being answered is "is this the person
 * whose seat is still warm", not "is this credential fresh".
 */
const reconnectKey = (playerId: string): string => `reconnect:${playerId}`;

/**
 * Slack on top of the room's grace window.
 *
 * The room evicts the seat on a tick, not on a timer, and a reconnecting client
 * spends a moment on DNS and the handshake. Expiring this first would refuse a
 * player the room was still holding a place for.
 */
const RECONNECT_MARGIN_SECONDS = 10;

export interface TicketClaims {
  playerId: string;
  wallet: string;
  roomId: string;
  nodeId: string;
  nickname: string;
  /** Set when a launch prepared a game; absent for direct entry. */
  gameId?: string;
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
          /**
           * Spent — but this may be the same player coming back.
           *
           * The socket reconnects automatically, and the room holds a seat for
           * `RECONNECT_GRACE_SECONDS` precisely so a dropped connection does not
           * cost a run. Those two could never meet: the ticket is consumed on
           * the first handshake, so the reconnect presented a spent one and was
           * refused with "ticket already used or expired" — mid-match, to a
           * player who had done nothing but lose their network for a moment.
           * The grace window was unreachable.
           *
           * A reconnect note is written below on every successful handshake and
           * lives exactly as long as the seat does. It readmits one player to
           * the one room they are already sitting in, which is not the hole the
           * single-use rule closes: a stolen ticket still cannot open a session
           * anywhere, and a second player still cannot enter on somebody else's.
           */
          const note = await redis.get(reconnectKey(claims.playerId));

          if (note !== claims.roomId) {
            next(new Error('INVALID_TICKET: ticket already used or expired'));
            return;
          }
        }

        // Refreshed on every handshake, so it tracks the seat rather than the
        // original join — a player who reconnects twice gets the same window
        // the first reconnect had.
        await redis.set(
          reconnectKey(claims.playerId),
          claims.roomId,
          'EX',
          config.RECONNECT_GRACE_SECONDS + RECONNECT_MARGIN_SECONDS,
        );

        socket.data.playerId = claims.playerId;
        socket.data.wallet = claims.wallet;
        socket.data.roomId = claims.roomId;
        socket.data.gameId = claims.gameId ?? null;
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
