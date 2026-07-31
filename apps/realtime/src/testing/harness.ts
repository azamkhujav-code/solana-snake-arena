import { createLogger, type Logger } from '@arena/logger';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@arena/protocol';
import { createServer, type Server as HttpServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { Server } from 'socket.io';

import { config } from '../config.js';
import { registerConnectionHandlers } from '../io/handlers/connection.js';
import { registerAuthMiddleware } from '../io/middleware/authenticate.js';
import { registerRateLimitMiddleware } from '../io/middleware/rate-limit.js';
import { buildTicketClaims, mintTicket } from './ticket.js';
import { RoomManager } from '../rooms/room-manager.js';
import type { ArenaServer } from '../io/socket-server.js';

/**
 * A real Socket.IO server on a real port, for multiplayer tests.
 *
 * Real transport rather than a mocked emitter, because everything worth testing
 * here lives in the parts a mock replaces: the handshake, middleware ordering,
 * acknowledgement round trips, binary framing, and what actually happens to a
 * socket on disconnect. A test that calls the handler function directly proves
 * the handler works and nothing about whether a client can reach it.
 *
 * Only Redis is substituted — the ticket store is a Map with the same GETDEL
 * semantics, and the Redis adapter is omitted since these tests run one node.
 */

export interface Harness {
  io: ArenaServer;
  rooms: RoomManager;
  url: string;
  /** Ticket store, so a test can assert single-use consumption directly. */
  tickets: Map<string, string>;
  /** Mints a ticket and registers it, exactly as the matchmaker would. */
  issueTicket: (params: { playerId: string; roomId?: string; nickname?: string }) => string;
  connect: (ticket: string) => Promise<TestClient>;
  close: () => Promise<void>;
}

export type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents> & {
  /** Resolves with the next payload for an event, or rejects on timeout. */
  next: <T = unknown>(event: string, timeoutMs?: number) => Promise<T>;
};

/** Redis stand-in with real GETDEL semantics — the single-use guarantee. */
function createTicketRedis(store: Map<string, string>) {
  return {
    getdel: async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    get: async (key: string) => store.get(key) ?? null,
  };
}

/**
 * Wraps a client so a test can await a specific event.
 *
 * Events are **buffered from the moment the socket is created**, not from the
 * moment a test asks for one. The server emits `Joined` the instant the
 * connection is established, which routinely lands before the test attaches its
 * listener — a race that shows up as an intermittent timeout and gets written
 * off as flakiness. Buffering makes `next()` mean "the next one I have not yet
 * consumed", which is what a test actually wants.
 *
 * The timeout matters too: without it a missing event hangs until the
 * suite-level limit, and the failure names the whole test rather than the event
 * that never arrived.
 */
function wrapClient(socket: ClientSocket): TestClient {
  const client = socket as TestClient;
  const buffered = new Map<string, unknown[]>();
  const waiting = new Map<string, (payload: unknown) => void>();

  socket.onAny((event: string, payload: unknown) => {
    const pending = waiting.get(event);
    if (pending) {
      waiting.delete(event);
      pending(payload);
      return;
    }
    buffered.set(event, [...(buffered.get(event) ?? []), payload]);
  });

  client.next = <T>(event: string, timeoutMs = 2_000): Promise<T> => {
    const queue = buffered.get(event);
    if (queue && queue.length > 0) {
      const [head, ...rest] = queue;
      buffered.set(event, rest);
      return Promise.resolve(head as T);
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(event);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for "${event}"`));
      }, timeoutMs);

      waiting.set(event, (payload) => {
        clearTimeout(timer);
        resolve(payload as T);
      });
    });
  };

  return client;
}

export async function createHarness(options: { log?: Logger } = {}): Promise<Harness> {
  const log =
    options.log ?? createLogger({ service: 'realtime-test', level: 'silent', pretty: false });

  const httpServer: HttpServer = createServer();

  const io: ArenaServer = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    path: '/ws',
    transports: ['websocket'],
    // Faster than production so a heartbeat test does not take 20 seconds.
    pingInterval: 200,
    pingTimeout: 500,
    maxHttpBufferSize: 4_096,
    perMessageDeflate: false,
    connectionStateRecovery: {
      maxDisconnectionDuration: config.RECONNECT_GRACE_SECONDS * 1_000,
      skipMiddlewares: false,
    },
  });

  const tickets = new Map<string, string>();
  const rooms = new RoomManager({
    logger: log,
    redis: createTicketRedis(tickets) as never,
    io,
  });

  registerAuthMiddleware(io, createTicketRedis(tickets) as never);
  registerRateLimitMiddleware(io);
  registerConnectionHandlers(io, rooms, log);

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const clients: ClientSocket[] = [];

  return {
    io,
    rooms,
    url,
    tickets,

    issueTicket({ playerId, roomId = 'test-room', nickname = 'tester' }) {
      const claims = buildTicketClaims({
        playerId,
        wallet: `wallet-${playerId}`,
        roomId,
        nodeId: config.NODE_ID,
        nickname,
      });
      const ticket = mintTicket(claims, config.JWT_SECRET);
      tickets.set(`ticket:${playerId}`, ticket);
      return ticket;
    },

    async connect(ticket: string) {
      const socket = createClient(url, {
        path: '/ws',
        transports: ['websocket'],
        auth: { ticket },
        reconnection: false,
        forceNew: true,
      });
      clients.push(socket);

      // Wrapped *before* awaiting the connection, not after. The server emits
      // `Joined` the instant the handshake completes, and that packet can be
      // processed in the same turn the `connect` promise resolves — so a buffer
      // attached afterwards misses it entirely.
      const client = wrapClient(socket);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connect timed out')), 3_000);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('connect_error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      return client;
    },

    async close() {
      for (const client of clients) client.disconnect();
      await io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** Attempts a connection and resolves with the rejection reason. */
export async function expectConnectionRejected(url: string, ticket: string): Promise<string> {
  const socket = createClient(url, {
    path: '/ws',
    transports: ['websocket'],
    auth: { ticket },
    reconnection: false,
    forceNew: true,
  });

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('expected a rejection, got silence')), 3_000);

      socket.once('connect_error', (error) => {
        clearTimeout(timer);
        resolve(error.message);
      });
      socket.once('connect', () => {
        clearTimeout(timer);
        reject(new Error('expected the connection to be rejected but it succeeded'));
      });
    });
  } finally {
    socket.disconnect();
  }
}
