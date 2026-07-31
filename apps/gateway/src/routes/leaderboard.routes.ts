import { LeaderboardWindow } from '@arena/db';
import { leaderboardRowSchema } from '@arena/protocol';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * Leaderboards.
 *
 * Served from the materialised `leaderboard` table, not by aggregating
 * `game_players` — a global `ORDER BY` over that table cannot hold up at this
 * scale. The settlement worker upserts the windows as matches complete.
 */

const WINDOW_BY_NAME = {
  daily: LeaderboardWindow.DAILY,
  weekly: LeaderboardWindow.WEEKLY,
  monthly: LeaderboardWindow.MONTHLY,
  'all-time': LeaderboardWindow.ALL_TIME,
} as const;

export type WindowName = keyof typeof WINDOW_BY_NAME;

/**
 * The period key for a window at a given instant.
 *
 * Exported and pure so the bucketing can be tested — an off-by-one here shows
 * a player yesterday's board and is invisible until someone complains.
 */
export function periodKeyFor(window: WindowName, now: Date): string {
  const iso = now.toISOString();

  switch (window) {
    case 'daily':
      return iso.slice(0, 10);
    case 'monthly':
      return iso.slice(0, 7);
    case 'all-time':
      return 'all';
    case 'weekly': {
      // ISO-8601 week: Thursday of the current week decides the year, which is
      // what stops the first days of January landing in the wrong bucket.
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const day = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() + 4 - day);

      const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);

      return `${date.getUTCFullYear()}-W${week.toString().padStart(2, '0')}`;
    }
    default:
      return 'all';
  }
}

// The shared contract, not a local copy. The two drifted before: the client
// schema expected `playerId`, a `wallet`, and a numeric score, while this
// endpoint served `userId` and a string. An empty leaderboard parses fine under
// both, so the mismatch stayed invisible until there was data.
const entrySchema = leaderboardRowSchema;

export async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/leaderboard',
    {
      schema: {
        tags: ['leaderboard'],
        summary: 'Top players for a window',
        querystring: z.object({
          window: z.enum(['daily', 'weekly', 'monthly', 'all-time']).default('daily'),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          offset: z.coerce.number().int().min(0).max(10_000).default(0),
        }),
        response: {
          200: z.object({
            window: z.string(),
            periodKey: z.string(),
            entries: z.array(entrySchema),
            total: z.number().int().nonnegative(),
          }),
        },
      },
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const { window, limit, offset } = request.query;
      const periodKey = periodKeyFor(window, new Date());

      // Offset is acceptable here, unlike on the ledger: the board is bounded
      // to the top few thousand and the index covers (window, period, rank).
      const [rows, total] = await Promise.all([
        app.prisma.leaderboard.findMany({
          where: { window: WINDOW_BY_NAME[window], periodKey },
          orderBy: [{ score: 'desc' }, { userId: 'asc' }],
          skip: offset,
          take: limit,
          include: { user: { select: { username: true } } },
        }),
        app.prisma.leaderboard.count({
          where: { window: WINDOW_BY_NAME[window], periodKey },
        }),
      ]);

      // The board moves constantly and clients poll it; a few seconds of
      // staleness is invisible next to the cost of recomputing per request.
      void reply.header('cache-control', 'public, max-age=10, stale-while-revalidate=60');

      return {
        window,
        periodKey,
        // Rank is derived from position here rather than read from the row:
        // the stored `rank` is only correct after a full re-ranking pass, and
        // ordering by score is right at every moment in between.
        entries: rows.map((row, index) => ({
          rank: offset + index + 1,
          userId: row.userId,
          nickname: row.user.username,
          score: row.score.toString(),
          gamesPlayed: row.gamesPlayed,
          wins: row.wins,
          kills: row.kills,
        })),
        total,
      };
    },
  );

  api.get(
    '/leaderboard/me',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['leaderboard'],
        summary: 'The caller’s own standing',
        description:
          'Returns the caller’s rank even when they are outside the visible top N — a board that simply omits you leaves you unable to tell whether you are 11th or 400th.',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          window: z.enum(['daily', 'weekly', 'monthly', 'all-time']).default('daily'),
        }),
        response: {
          200: z.object({
            window: z.string(),
            periodKey: z.string(),
            entry: entrySchema.nullable(),
          }),
        },
      },
    },
    async (request) => {
      const { window } = request.query;
      const periodKey = periodKeyFor(window, new Date());
      const userId = request.user.sub;

      const row = await app.prisma.leaderboard.findUnique({
        where: {
          window_periodKey_userId: { window: WINDOW_BY_NAME[window], periodKey, userId },
        },
        include: { user: { select: { username: true } } },
      });

      if (!row) return { window, periodKey, entry: null };

      // Rank is "how many scored higher, plus one" — computed on demand so it
      // is correct without waiting for a re-ranking pass.
      const ahead = await app.prisma.leaderboard.count({
        where: {
          window: WINDOW_BY_NAME[window],
          periodKey,
          score: { gt: row.score },
        },
      });

      return {
        window,
        periodKey,
        entry: {
          rank: ahead + 1,
          userId: row.userId,
          nickname: row.user.username,
          score: row.score.toString(),
          gamesPlayed: row.gamesPlayed,
          wins: row.wins,
          kills: row.kills,
        },
      };
    },
  );
}
