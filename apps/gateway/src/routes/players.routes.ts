import {
  matchHistoryQuerySchema,
  matchHistoryResponseSchema,
  playerStatsSchema,
  updateProfileRequestSchema,
} from '@arena/protocol';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/** Marks an endpoint whose handler still throws 501, so the spec does not lie. */
const NOT_IMPLEMENTED = '\n\n> **Not yet implemented.** Currently responds `501`.';

export async function playerRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/players/:playerId',
    {
      schema: {
        tags: ['players'],
        summary: 'Public profile',
        description: `Public fields only — never balances or ledger entries.${NOT_IMPLEMENTED}`,
        params: z.object({ playerId: z.uuid() }),
      },
    },
    async () => {
      // TODO: read-through cache in Redis; profiles are hot and rarely change.
      throw app.httpErrors.notImplemented();
    },
  );

  api.get(
    '/players/:playerId/stats',
    {
      schema: {
        tags: ['players'],
        summary: 'Lifetime statistics',
        description: `Aggregate counters maintained by a background job rather than recomputed per request.${NOT_IMPLEMENTED}`,
        params: z.object({ playerId: z.uuid() }),
        response: { 200: playerStatsSchema },
      },
    },
    async () => {
      throw app.httpErrors.notImplemented();
    },
  );

  api.patch(
    '/players/me',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['players'],
        summary: 'Update the caller’s profile',
        description: `A nickname collision responds \`409\`, not \`500\`.${NOT_IMPLEMENTED}`,
        security: [{ bearerAuth: [] }],
        body: updateProfileRequestSchema,
      },
    },
    async () => {
      // TODO: nickname uniqueness is enforced by a DB constraint; map the
      // unique-violation to a 409 rather than a 500.
      throw app.httpErrors.notImplemented();
    },
  );

  /**
   * Match history, served from the `match_history` read model.
   *
   * That table exists precisely for this query: joining games + game_players +
   * rooms and ordering by time over hundreds of millions of rows is the query
   * that falls over first. Every column needed here is denormalised onto it.
   */
  const history: RouteHandlerMethod = async (request) => {
    const { limit, cursor, mode } = request.query as z.infer<typeof matchHistoryQuerySchema>;
    const userId = request.user.sub;

    // Keyset pagination on (playedAt, id). OFFSET degrades badly at this
    // table's expected size.
    const rows = await app.prisma.matchHistory.findMany({
      where: { userId, ...(mode ? { mode: mode.toUpperCase() as never } : {}) },
      orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

    // Lifetime totals come from the aggregate columns on `users`, which a
    // background job maintains — recomputing them from history on every page
    // request would scan the whole table.
    const totals = await app.prisma.user.findUnique({
      where: { id: userId },
      select: {
        gamesPlayed: true,
        wins: true,
        kills: true,
        lifetimeWon: true,
        lifetimeWagered: true,
      },
    });

    return {
      matches: page.map((row) => ({
        id: row.id,
        gameId: row.gameId,
        roomId: row.roomId,
        mode: row.mode,
        region: row.region,
        placement: row.placement,
        score: row.score,
        kills: row.kills,
        survivedMs: row.survivedMs,
        entryLamports: row.entryLamports.toString(),
        payoutLamports: row.payoutLamports.toString(),
        netLamports: row.netLamports.toString(),
        playedAt: row.playedAt.toISOString(),
      })),
      nextCursor,
      totals: {
        played: totals?.gamesPlayed ?? 0,
        wins: totals?.wins ?? 0,
        kills: totals?.kills ?? 0,
        netLamports: ((totals?.lifetimeWon ?? 0n) - (totals?.lifetimeWagered ?? 0n)).toString(),
      },
    };
  };

  api.get(
    '/history',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['history'],
        summary: 'The caller’s match history',
        description: [
          'Reverse-chronological, keyset paginated. Pass the returned `nextCursor`',
          'as `cursor` to page; offsets are not supported because they degrade as',
          'the table grows.',
          '',
          'Alongside the page, `totals` carries lifetime aggregates so a client can',
          'render a summary header without walking every page.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        querystring: matchHistoryQuerySchema,
        response: { 200: matchHistoryResponseSchema },
      },
    },
    history,
  );

  // The original path, kept working so existing clients do not break. Marked
  // deprecated in the spec rather than removed — a redirect on an authenticated
  // XHR is a worse failure mode than a documented alias.
  api.get(
    '/players/me/matches',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['history'],
        summary: 'The caller’s match history (alias)',
        description: 'Deprecated alias for `GET /v1/history`. Identical response.',
        deprecated: true,
        security: [{ bearerAuth: [] }],
        querystring: matchHistoryQuerySchema,
        response: { 200: matchHistoryResponseSchema },
      },
    },
    history,
  );
}
