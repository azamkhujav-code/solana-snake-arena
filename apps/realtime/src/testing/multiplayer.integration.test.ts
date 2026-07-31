import { ClientEvent, PROTOCOL_VERSION, ServerEvent } from '@arena/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  expectConnectionRejected,
  type Harness,
  type TestClient,
} from './harness.js';
import { buildTicketClaims, mintTicket } from './ticket.js';
import { config } from '../config.js';

/**
 * Multiplayer tests over a real WebSocket.
 *
 * Everything worth checking here lives in the parts a mock would replace: the
 * handshake, middleware ordering, acknowledgement round trips, and what happens
 * to a socket on disconnect. Calling a handler directly proves the handler
 * works and nothing about whether a client can reach it.
 */
describe('multiplayer', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  describe('handshake authentication', () => {
    it('admits a client holding a valid ticket', async () => {
      const ticket = harness.issueTicket({ playerId: 'p1' });
      const client = await harness.connect(ticket);

      expect(client.connected).toBe(true);
    });

    it('refuses a connection with no ticket', async () => {
      const reason = await expectConnectionRejected(harness.url, '');
      expect(reason).toMatch(/PROTOCOL_MISMATCH|no ticket/i);
    });

    it('refuses a forged signature', async () => {
      // The HMAC is what lets a node validate without a network call, so
      // forging it is the obvious attack.
      const claims = buildTicketClaims({
        playerId: 'attacker',
        wallet: 'w',
        roomId: 'test-room',
        nodeId: config.NODE_ID,
        nickname: 'x',
      });
      const forged = `${mintTicket(claims, 'the-wrong-secret').split('.')[0]}.deadbeef`;

      const reason = await expectConnectionRejected(harness.url, forged);
      expect(reason).toMatch(/INVALID_TICKET/);
    });

    it('refuses a ticket minted with the wrong secret', async () => {
      const claims = buildTicketClaims({
        playerId: 'attacker',
        wallet: 'w',
        roomId: 'test-room',
        nodeId: config.NODE_ID,
        nickname: 'x',
      });
      const ticket = mintTicket(claims, 'a-completely-different-secret-value');
      harness.tickets.set('ticket:attacker', ticket);

      const reason = await expectConnectionRejected(harness.url, ticket);
      expect(reason).toMatch(/INVALID_TICKET/);
    });

    it('refuses an expired ticket', async () => {
      const claims = buildTicketClaims({
        playerId: 'p-late',
        wallet: 'w',
        roomId: 'test-room',
        nodeId: config.NODE_ID,
        nickname: 'x',
        now: Date.now() - 120_000,
      });
      const ticket = mintTicket(claims, config.JWT_SECRET);
      harness.tickets.set('ticket:p-late', ticket);

      const reason = await expectConnectionRejected(harness.url, ticket);
      expect(reason).toMatch(/expired/i);
    });

    it('refuses a ticket addressed to a different node', async () => {
      // Otherwise this node silently hosts a room it was never assigned, and
      // the matchmaker's view of who owns what stops being true.
      const claims = buildTicketClaims({
        playerId: 'p-elsewhere',
        wallet: 'w',
        roomId: 'test-room',
        nodeId: 'some-other-node',
        nickname: 'x',
      });
      const ticket = mintTicket(claims, config.JWT_SECRET);
      harness.tickets.set('ticket:p-elsewhere', ticket);

      const reason = await expectConnectionRejected(harness.url, ticket);
      expect(reason).toMatch(/different node/i);
    });

    it('consumes a ticket exactly once', async () => {
      // A signature alone would let one ticket open unlimited sockets. The
      // Redis GETDEL is what actually enforces single use.
      const ticket = harness.issueTicket({ playerId: 'p-once' });
      await harness.connect(ticket);

      expect(harness.tickets.has('ticket:p-once')).toBe(false);
    });

    it('readmits the player to the seat they still hold', async () => {
      // The socket reconnects on its own and the room holds a seat for the
      // grace window — but the ticket was spent on the first handshake, so a
      // dropped connection came back to "already used or expired" and lost the
      // player a match they were in the middle of. The grace window could never
      // be reached.
      const ticket = harness.issueTicket({ playerId: 'p-back', roomId: 'test-room' });
      const first = await harness.connect(ticket);
      first.disconnect();

      const second = await harness.connect(ticket);
      expect(second.connected).toBe(true);
      second.disconnect();
    });

    it('does not let a spent ticket reach a different room', async () => {
      // Readmission is bound to the room the seat is in, so a spent ticket
      // cannot be replayed to get in somewhere the player was never placed.
      await harness.connect(harness.issueTicket({ playerId: 'p-else', roomId: 'test-room' }));

      const elsewhere = harness.issueTicket({ playerId: 'p-else', roomId: 'other-room' });
      harness.tickets.delete('ticket:p-else');

      const reason = await expectConnectionRejected(harness.url, elsewhere);
      expect(reason).toMatch(/already used|expired/i);
    });
  });

  describe('joining', () => {
    it('emits Joined with the parameters the client needs to simulate', async () => {
      const client = await harness.connect(harness.issueTicket({ playerId: 'p1' }));
      const joined = await client.next<{
        playerId: string;
        roomId: string;
        tickRate: number;
        snapshotRate: number;
        worldRadius: number;
      }>(ServerEvent.Joined);

      expect(joined.playerId).toBe('p1');
      expect(joined.roomId).toBe('test-room');
      // Client-side prediction runs at the server's tick rate; guessing it
      // would desync every prediction.
      expect(joined.tickRate).toBe(config.TICK_RATE_HZ);
      expect(joined.snapshotRate).toBe(config.SNAPSHOT_RATE_HZ);
      expect(joined.worldRadius).toBeGreaterThan(0);
    });

    it('places the player into a room the manager knows about', async () => {
      await harness.connect(harness.issueTicket({ playerId: 'p1' }));

      expect(harness.rooms.roomCount).toBe(1);
      expect(harness.rooms.playerCount).toBe(1);
    });

    it('puts two players with the same room id into one room', async () => {
      // The property that makes it multiplayer rather than two solo games.
      await harness.connect(harness.issueTicket({ playerId: 'p1', roomId: 'shared' }));
      await harness.connect(harness.issueTicket({ playerId: 'p2', roomId: 'shared' }));

      expect(harness.rooms.roomCount).toBe(1);
      expect(harness.rooms.playerCount).toBe(2);
    });

    it('keeps players in different rooms apart', async () => {
      await harness.connect(harness.issueTicket({ playerId: 'p1', roomId: 'room-a' }));
      await harness.connect(harness.issueTicket({ playerId: 'p2', roomId: 'room-b' }));

      expect(harness.rooms.roomCount).toBe(2);
    });

    it('rejects a client speaking an incompatible protocol', async () => {
      // A stale browser tab after a deploy would otherwise desync silently
      // rather than reconnecting.
      const client = await harness.connect(harness.issueTicket({ playerId: 'p1' }));

      const ack = await new Promise<Partial<{ code: string; playerId: string }>>((resolve) => {
        // A different *major*: the compatibility rule only compares that field.
        client.emit(
          ClientEvent.Join,
          {
            roomId: 'test-room',
            ticket: 'already-consumed',
            nickname: 'p1',
            protocolVersion: '2.0.0',
          },
          resolve as never,
        );
      });

      expect(ack.code).toBe('PROTOCOL_MISMATCH');
    });

    it('accepts a client on the current protocol', async () => {
      const client = await harness.connect(harness.issueTicket({ playerId: 'p1' }));

      const ack = await new Promise<Partial<{ code: string; playerId: string }>>((resolve) => {
        client.emit(
          ClientEvent.Join,
          {
            roomId: 'test-room',
            ticket: 'already-consumed',
            nickname: 'p1',
            protocolVersion: PROTOCOL_VERSION,
          },
          resolve as never,
        );
      });

      expect(ack.code).toBeUndefined();
      expect(ack.playerId).toBe('p1');
    });
  });

  describe('latency', () => {
    it('answers a ping with server time', async () => {
      // The client derives clock offset from this; interpolation renders at
      // `serverTime - delay`, so a wrong offset is permanent stutter.
      const client = await harness.connect(harness.issueTicket({ playerId: 'p1' }));

      const serverTime = await new Promise<number>((resolve) => {
        client.emit(ClientEvent.Ping, Date.now(), resolve);
      });

      expect(typeof serverTime).toBe('number');
      expect(serverTime).toBeGreaterThanOrEqual(0);
    });

    it('throttles a ping flood without dropping the socket', async () => {
      // Rate limiting must degrade, not disconnect: kicking a client for a
      // network hiccup that made it re-ping is worse than ignoring the extras.
      const client = await harness.connect(harness.issueTicket({ playerId: 'p1' }));

      const answered = await Promise.all(
        Array.from(
          { length: 20 },
          () =>
            new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => resolve(false), 300);
              client.emit(ClientEvent.Ping, Date.now(), () => {
                clearTimeout(timer);
                resolve(true);
              });
            }),
        ),
      );

      const served = answered.filter(Boolean).length;
      expect(served).toBeGreaterThan(0);
      expect(served).toBeLessThan(20);
      expect(client.connected).toBe(true);
    });
  });

  describe('chat', () => {
    it('broadcasts a message to the other player in the room', async () => {
      const a = await harness.connect(harness.issueTicket({ playerId: 'p1', roomId: 'shared' }));
      const b = await harness.connect(harness.issueTicket({ playerId: 'p2', roomId: 'shared' }));

      const received = b.next<{ playerId: string; body: string }>(ServerEvent.Chat);
      a.emit(ClientEvent.Chat, { body: 'hello' });

      expect(await received).toMatchObject({ playerId: 'p1', body: 'hello' });
    });

    it('does not leak chat across rooms', async () => {
      const a = await harness.connect(harness.issueTicket({ playerId: 'p1', roomId: 'room-a' }));
      const b = await harness.connect(harness.issueTicket({ playerId: 'p2', roomId: 'room-b' }));

      let leaked = false;
      b.on(ServerEvent.Chat, () => {
        leaked = true;
      });

      a.emit(ClientEvent.Chat, { body: 'private' });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(leaked).toBe(false);
    });

    it('survives a malformed payload without dropping the socket', async () => {
      // The old handler read `payload.body` directly, so this threw inside the
      // socket handler.
      const client = await harness.connect(harness.issueTicket({ playerId: 'p1' }));

      client.emit(ClientEvent.Chat, null as never);
      client.emit(ClientEvent.Chat, { body: 123 } as never);
      client.emit(ClientEvent.Chat, {} as never);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(client.connected).toBe(true);
    });

    it('strips invisible characters before broadcasting', async () => {
      const a = await harness.connect(harness.issueTicket({ playerId: 'p1', roomId: 'shared' }));
      const b = await harness.connect(harness.issueTicket({ playerId: 'p2', roomId: 'shared' }));

      const received = b.next<{ body: string }>(ServerEvent.Chat);
      a.emit(ClientEvent.Chat, { body: 'safe‮desrever' });

      expect((await received).body).toBe('safedesrever');
    });
  });

  describe('input', () => {
    it('accepts a well-formed batch', async () => {
      const client = await harness.connect(harness.issueTicket({ playerId: 'p1' }));

      client.emit(ClientEvent.Input, {
        clientTime: Date.now(),
        commands: [{ seq: 1, angle: 0.5, boost: false, dt: 33 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(client.connected).toBe(true);
    });

    it('ignores a malformed batch without dropping the socket', async () => {
      const client = await harness.connect(harness.issueTicket({ playerId: 'p1' }));

      client.emit(ClientEvent.Input, { commands: 'not-an-array' } as never);
      client.emit(ClientEvent.Input, null as never);
      client.emit(ClientEvent.Input, {
        clientTime: 0,
        commands: [{ seq: -1, angle: Number.NaN, boost: 'yes', dt: 1e9 }],
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(client.connected).toBe(true);
    });

    it('survives a sustained input flood', async () => {
      // The token bucket should throttle rather than let a client drive the
      // simulation, and must not take the connection down doing it.
      const client = await harness.connect(harness.issueTicket({ playerId: 'p1' }));

      for (let seq = 1; seq <= 500; seq += 1) {
        client.emit(ClientEvent.Input, {
          clientTime: Date.now(),
          commands: [{ seq, angle: 0, boost: true, dt: 33 }],
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(client.connected).toBe(true);
      expect(harness.rooms.playerCount).toBe(1);
    });
  });

  describe('disconnect and reconnect', () => {
    it('keeps the seat during the grace window', async () => {
      // A brief network blip must not cost a player their run — the seat is
      // held, not removed, and the room tick evicts it only on timeout.
      const client = await harness.connect(harness.issueTicket({ playerId: 'p1' }));
      expect(harness.rooms.playerCount).toBe(1);

      client.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(harness.rooms.playerCount).toBe(1);
    });

    it('lets a player reconnect with a fresh ticket', async () => {
      const first = await harness.connect(harness.issueTicket({ playerId: 'p1' }));
      first.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const second = await harness.connect(harness.issueTicket({ playerId: 'p1' }));
      const joined = await second.next<{ playerId: string }>(ServerEvent.Joined);

      expect(joined.playerId).toBe('p1');
      // Still one seat: reconnecting must not duplicate the player.
      expect(harness.rooms.playerCount).toBe(1);
    });

    it('leaves the room intact when one of two players drops', async () => {
      const a = await harness.connect(harness.issueTicket({ playerId: 'p1', roomId: 'shared' }));
      await harness.connect(harness.issueTicket({ playerId: 'p2', roomId: 'shared' }));

      a.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(harness.rooms.roomCount).toBe(1);
    });

    it('removes the seat on an explicit leave', async () => {
      // Distinct from a disconnect: leaving is intentional, so there is nothing
      // to hold a seat for.
      const client = await harness.connect(harness.issueTicket({ playerId: 'p1' }));
      client.emit(ClientEvent.Leave);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(harness.rooms.playerCount).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('admits many players into one room without losing any', async () => {
      const clients: TestClient[] = [];

      // Sequential rather than parallel: the connection guard throttles bursts
      // from one address, which is the behaviour under test elsewhere.
      for (let i = 0; i < 8; i += 1) {
        clients.push(
          await harness.connect(harness.issueTicket({ playerId: `p${i}`, roomId: 'busy' })),
        );
      }

      expect(harness.rooms.playerCount).toBe(8);
      expect(harness.rooms.roomCount).toBe(1);
      expect(clients.every((client) => client.connected)).toBe(true);
    });

    it('throttles a connection burst from one address', async () => {
      // Default burst is 10; the eleventh onward should be refused.
      const attempts = await Promise.allSettled(
        Array.from({ length: 16 }, (_, i) =>
          harness.connect(harness.issueTicket({ playerId: `burst${i}`, roomId: 'burst' })),
        ),
      );

      const rejected = attempts.filter((result) => result.status === 'rejected');
      expect(rejected.length).toBeGreaterThan(0);
    });
  });
});
