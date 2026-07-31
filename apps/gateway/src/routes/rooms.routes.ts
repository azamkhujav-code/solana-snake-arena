import { lamportsSchema } from '@arena/protocol';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { notFound } from '../lib/errors.js';

const roomSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string().nullable(),
  mode: z.string(),
  region: z.string(),
  status: z.string(),
  /** Seat limit, or null when the room takes any number of players. */
  maxPlayers: z.number().int().nullable(),
  entryFeeLamports: lamportsSchema,
  rakeBps: z.number().int(),
  createdAt: z.iso.datetime(),
  /** Games played in this room. */
  gamesPlayed: z.number().int().nonnegative(),
});

const gameSummarySchema = z.object({
  id: z.uuid(),
  roomId: z.uuid(),
  status: z.string(),
  playerCount: z.number().int(),
  potLamports: lamportsSchema,
  payoutLamports: lamportsSchema,
  settlementStatus: z.string(),
  settlementSignature: z.string().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});

/**
 * Rooms and games.
 *
 * These are the **durable** records — arena configurations and completed
 * matches. Live lobby state (who is queued right now, the countdown) belongs to
 * the matchmaker, which holds it in Redis. Serving a live queue from Postgres
 * would mean writing to the database on every join.
 */
export async function roomRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/rooms',
    {
      schema: {
        tags: ['rooms'],
        summary: 'List arena configurations',
        description:
          'Durable room records. For live queue state — player counts, countdowns, join/leave — use the matchmaker’s `/v1/lobbies`.',
        querystring: z.object({
          mode: z.enum(['CASUAL', 'RANKED', 'WAGER']).optional(),
          status: z.enum(['ACTIVE', 'DRAINING', 'CLOSED']).default('ACTIVE'),
        }),
        response: { 200: z.object({ rooms: z.array(roomSchema) }) },
      },
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const rooms = await app.prisma.room.findMany({
        where: {
          status: request.query.status,
          ...(request.query.mode ? { mode: request.query.mode } : {}),
        },
        orderBy: { entryFeeLamports: 'asc' },
        include: { _count: { select: { games: true } } },
      });

      // Room configuration changes rarely; the live parts are elsewhere.
      void reply.header('cache-control', 'public, max-age=30');

      return {
        rooms: rooms.map((room) => ({
          id: room.id,
          code: room.code,
          name: room.name,
          mode: room.mode,
          region: room.region,
          status: room.status,
          maxPlayers: room.maxPlayers,
          entryFeeLamports: room.entryFeeLamports.toString(),
          rakeBps: room.rakeBps,
          createdAt: room.createdAt.toISOString(),
          gamesPlayed: room._count.games,
        })),
      };
    },
  );

  api.get(
    '/rooms/:roomId',
    {
      schema: {
        tags: ['rooms'],
        summary: 'Get one room',
        params: z.object({ roomId: z.uuid() }),
        response: { 200: roomSchema },
      },
    },
    async (request) => {
      const room = await app.prisma.room.findUnique({
        where: { id: request.params.roomId },
        include: { _count: { select: { games: true } } },
      });
      if (!room) throw notFound('Room');

      return {
        id: room.id,
        code: room.code,
        name: room.name,
        mode: room.mode,
        region: room.region,
        status: room.status,
        maxPlayers: room.maxPlayers,
        entryFeeLamports: room.entryFeeLamports.toString(),
        rakeBps: room.rakeBps,
        createdAt: room.createdAt.toISOString(),
        gamesPlayed: room._count.games,
      };
    },
  );

  api.get(
    '/rooms/:roomId/games',
    {
      schema: {
        tags: ['rooms', 'games'],
        summary: 'Recent games in a room',
        params: z.object({ roomId: z.uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().optional(),
        }),
        response: {
          200: z.object({
            games: z.array(gameSummarySchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const { limit, cursor } = request.query;

      const rows = await app.prisma.game.findMany({
        where: { roomId: request.params.roomId },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const page = rows.slice(0, limit);

      return {
        games: page.map(toGameSummary),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
  );
}

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/games',
    {
      schema: {
        tags: ['games'],
        summary: 'List games',
        querystring: z.object({
          status: z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED']).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().optional(),
        }),
        response: {
          200: z.object({
            games: z.array(gameSummarySchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const { status, limit, cursor } = request.query;

      const rows = await app.prisma.game.findMany({
        where: status ? { status } : {},
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const page = rows.slice(0, limit);

      return {
        games: page.map(toGameSummary),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
  );

  api.get(
    '/games/:gameId',
    {
      schema: {
        tags: ['games'],
        summary: 'Get a game with its final standings',
        params: z.object({ gameId: z.uuid() }),
        response: {
          200: gameSummarySchema.extend({
            standings: z.array(
              z.object({
                userId: z.uuid(),
                nickname: z.string().nullable(),
                placement: z.number().int().nullable(),
                score: z.number().int(),
                kills: z.number().int(),
                survivedMs: z.number().int(),
                payoutLamports: lamportsSchema,
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const game = await app.prisma.game.findUnique({
        where: { id: request.params.gameId },
        include: {
          gamePlayers: {
            orderBy: { placement: 'asc' },
            include: { user: { select: { username: true } } },
          },
        },
      });
      if (!game) throw notFound('Game');

      return {
        ...toGameSummary(game),
        standings: game.gamePlayers.map((player) => ({
          userId: player.userId,
          nickname: player.user.username,
          placement: player.placement,
          score: player.score,
          kills: player.kills,
          survivedMs: player.survivedMs,
          payoutLamports: player.payoutLamports.toString(),
        })),
      };
    },
  );
}

function toGameSummary(game: {
  id: string;
  roomId: string;
  status: string;
  playerCount: number;
  potLamports: bigint;
  payoutLamports: bigint;
  settlementStatus: string;
  settlementSignature: string | null;
  startedAt: Date;
  endedAt: Date | null;
}) {
  return {
    id: game.id,
    roomId: game.roomId,
    status: game.status,
    playerCount: game.playerCount,
    potLamports: game.potLamports.toString(),
    payoutLamports: game.payoutLamports.toString(),
    settlementStatus: game.settlementStatus,
    settlementSignature: game.settlementSignature,
    startedAt: game.startedAt.toISOString(),
    endedAt: game.endedAt?.toISOString() ?? null,
  };
}
