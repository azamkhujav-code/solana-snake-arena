import { findMatchRequestSchema, matchTicketSchema } from '@arena/protocol';
import { redisKeys } from '@arena/redis';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { config } from '../config.js';
import { loadNodes } from '../placement/registry.js';
import { filterHealthy, selectPlacement } from '../placement/strategy.js';
import { buildTicketClaims, mintTicket, TICKET_TTL_MS } from '../placement/ticket.js';

/**
 * Placement onto a realtime node.
 *
 * The client cannot choose its own room or node — it asks for a mode and gets a
 * ticket naming exactly one of each. That is why a ticket exists rather than
 * the realtime server simply accepting a player JWT: a JWT says who you are and
 * says nothing about which room you are entitled to enter.
 */
export async function matchmakingRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.post(
    '/matchmake',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['matchmaking'],
        summary: 'Place the caller on a realtime node',
        description: [
          'Returns a single-use ticket naming the node and room to connect to.',
          'Present it as `auth.ticket` on the Socket.IO handshake.',
          '',
          'The ticket is HMAC-signed so the realtime node validates it with no',
          'network call, and registered in Redis so it can be consumed exactly',
          'once — a signature alone would let one ticket open unlimited sockets.',
          '',
          'Lives for 30 seconds. It is a hand-off, not a session.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        body: findMatchRequestSchema,
        response: { 200: matchTicketSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const { mode } = request.body;
      const region = request.body.region ?? 'us-east';
      const playerId = request.user.sub;

      const nodes = await loadNodes(app.redis);
      const healthy = filterHealthy(nodes, config.NODE_HEARTBEAT_TTL_SECONDS * 1_000, Date.now());

      if (healthy.length === 0) {
        // 503, not 500: nothing is broken, there is simply no capacity. The
        // distinction tells the client to retry rather than to give up.
        throw app.httpErrors.serviceUnavailable('No realtime capacity available');
      }

      const decision = selectPlacement(
        healthy,
        { mode, region, playerId },
        config.PLACEMENT_STRATEGY,
      );

      if (!decision) {
        throw app.httpErrors.serviceUnavailable('No node could accept this placement');
      }

      /**
       * The realtime room to join — a *match*, not a tier.
       *
       * Keying this on the tier was wrong in a way that only showed up in play:
       * a tier is permanent, so its room never ended. Every player entering
       * that tier landed in the same long-running world, joining a game already
       * seven minutes deep with other people's snakes and food already on the
       * board. There was no such thing as starting a match; you only ever
       * arrived in the middle of one.
       *
       * A match is one game, with a start and an end. Each launch already mints
       * a room id from a fresh game id and issues every entrant a ticket for
       * it, which is what puts the players of one match together *and* keeps
       * them apart from the next. So when a launch has already issued this
       * player a ticket, that is the room they belong in — reusing it rather
       * than inventing another is the whole point.
       *
       * Otherwise this is a direct entry with no launch behind it, and a fresh
       * id gives a world that starts empty at 0:00 rather than resuming
       * somebody else's.
       */
      const staged = await app.redis.get(`ticket:meta:${playerId}`);

      if (staged) {
        const meta = JSON.parse(staged) as {
          roomId: string;
          gameId: string;
          realtimeUrl: string;
        };
        const issued = await app.redis.get(`ticket:${playerId}`);

        if (issued) {
          // Move it to the key the realtime node consumes, so the handshake
          // finds it exactly once.
          await app.redis.set(redisKeys.matchTicket(playerId), issued, 'PX', TICKET_TTL_MS);

          return {
            roomId: meta.roomId,
            realtimeUrl: meta.realtimeUrl,
            ticket: issued,
            expiresAt: Date.now() + TICKET_TTL_MS,
            region,
            mode,
          };
        }
      }

      const roomId = randomUUID().replace(/-/g, '').slice(0, 16);

      const claims = buildTicketClaims({
        playerId,
        wallet: request.user.wallet,
        roomId,
        nodeId: decision.nodeId,
        // The player's own name. This used to be `playerId.slice(0, 16)`, which
        // put a UUID fragment above every snake and down the leaderboard —
        // players could not tell each other apart, let alone recognise
        // themselves.
        nickname: request.user.nickname ?? playerId.slice(0, 8),
      });

      const ticket = mintTicket(claims, config.JWT_SECRET);

      // Registered under the player id, which is what the realtime node
      // GETDELs on handshake. A second /matchmake overwrites the first, so a
      // player cannot bank tickets and open several sockets at once.
      await app.redis.set(redisKeys.matchTicket(playerId), ticket, 'PX', TICKET_TTL_MS);

      return {
        roomId,
        realtimeUrl: decision.advertiseUrl,
        ticket,
        expiresAt: claims.expiresAt,
        region,
        mode,
      };
    },
  );

  api.post(
    '/internal/rooms',
    {
      onRequest: [app.authenticate, app.requireRole('ADMIN')],
      schema: {
        tags: ['internal'],
        summary: 'Register or refresh a room',
        description:
          'Called by realtime nodes, not browsers. Doubles as the liveness heartbeat: a room that stops reporting ages out of the registry and stops receiving placements.\n\n> **Not yet implemented.** Currently responds `501`.',
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      throw app.httpErrors.notImplemented();
    },
  );

  api.get(
    '/servers',
    {
      schema: {
        tags: ['matchmaking'],
        summary: 'Regional capacity',
        description:
          'Public view used by the lobby to show region population before a player commits to a room. Node ids and URLs are withheld — a client has no use for them, and publishing the topology only helps someone map it.',
        response: {
          200: z.object({
            regions: z.array(
              z.object({
                region: z.string(),
                nodes: z.number().int().nonnegative(),
                players: z.number().int().nonnegative(),
                /** 0..1 across the region; the lobby renders this as a load bar. */
                saturation: z.number(),
              }),
            ),
          }),
        },
      },
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (_request, reply) => {
      const nodes = await loadNodes(app.redis);
      const healthy = filterHealthy(nodes, config.NODE_HEARTBEAT_TTL_SECONDS * 1_000, Date.now());

      const byRegion = new Map<string, { nodes: number; players: number; saturation: number }>();
      for (const node of healthy) {
        const bucket = byRegion.get(node.region) ?? { nodes: 0, players: 0, saturation: 0 };
        bucket.nodes += 1;
        bucket.players += node.players;
        bucket.saturation += node.saturation;
        byRegion.set(node.region, bucket);
      }

      void reply.header('cache-control', 'public, max-age=5');

      return {
        regions: [...byRegion.entries()].map(([region, bucket]) => ({
          region,
          nodes: bucket.nodes,
          players: bucket.players,
          // Mean, not sum: a region with two nodes at 50% is half full, not
          // fully loaded.
          saturation: bucket.nodes === 0 ? 0 : bucket.saturation / bucket.nodes,
        })),
      };
    },
  );
}
