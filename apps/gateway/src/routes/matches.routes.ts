import { matchResultSchema } from '@arena/protocol';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

export async function matchRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/matches/:matchId',
    {
      schema: {
        tags: ['games'],
        summary: 'Result of a single match',
        description:
          'The realtime view of a finished match. For the settled financial record and standings use `GET /v1/games/{gameId}`.\n\n> **Not yet implemented.** Currently responds `501`.',
        params: z.object({ matchId: z.uuid() }),
        response: { 200: matchResultSchema },
      },
    },
    async () => {
      throw app.httpErrors.notImplemented();
    },
  );

  /**
   * Called by a realtime node when a wager match ends. Not reachable from the
   * public internet — the ingress only exposes /auth, /players, /leaderboard
   * and /matches GET. Authorised by a service token, not a player JWT.
   */
  api.post(
    '/internal/matches/:matchId/settle',
    {
      schema: {
        tags: ['internal'],
        summary: 'Report a finished match for settlement',
        description:
          'Called by a realtime node, not by players — the ingress does not route `/internal/*`. Idempotent on `matchId`: a retry after a timeout must not pay the pot twice.\n\n> **Not yet implemented.** Currently responds `501`.',
        security: [{ bearerAuth: [] }],
        params: z.object({ matchId: z.uuid() }),
      },
      onRequest: [app.authenticate, app.requireRole('ADMIN')],
    },
    async () => {
      // TODO: enqueue settlement. Must be idempotent on matchId — a retry after
      // a timeout must not pay the pot out twice.
      throw app.httpErrors.notImplemented();
    },
  );
}
