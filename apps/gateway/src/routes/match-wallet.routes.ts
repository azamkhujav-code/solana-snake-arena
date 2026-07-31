import { matchWalletListResponseSchema } from '@arena/protocol';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { listMatchWallets } from '../services/match-wallet.service.js';

/**
 * The wallet holding each room's current prize pot.
 *
 * Separate from the lobby board, which the matchmaker serves from Redis and
 * which has no database access at all — money lives here, with the ledger.
 *
 * One endpoint for all seven rooms rather than one per room: the board renders
 * every tier at once, and seven requests per poll to fill in seven numbers is
 * the kind of thing that is invisible locally and expensive in aggregate.
 */
export async function matchWalletRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/matches/wallets',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['games'],
        summary: 'Prize pot and wallet address for each room’s current match',
        description: [
          'Every match gets its own wallet, derived from the match id, so a pot',
          'is never commingled between matches.',
          '',
          'Three amounts, because they answer different questions:',
          '`committedLamports` is reserved against queued players and has not',
          'moved; `balanceLamports` is what the wallet actually holds, which is',
          'zero until the match starts because entry fees are consumed at launch',
          'rather than at join; `prizeLamports` is the balance less the rake —',
          'what the last surviving snake wins.',
          '',
          '`onChain` false means the address is derived but not yet initialised,',
          'so the pot is tracked in the platform ledger only. Look the address up',
          'on an explorer in that state and you will find an empty account.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        response: { 200: matchWalletListResponseSchema },
      },
      // Polled alongside the lobby board, so it needs the same headroom.
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (_request, reply) => {
      const wallets = await listMatchWallets(app.prisma);

      // Matches the lobby board's cache window: a second of staleness is
      // invisible next to a ten-minute cycle, and the two are read together.
      void reply.header('cache-control', 'private, max-age=1');

      return {
        wallets: wallets.map((wallet) => ({
          ...wallet,
          balanceLamports: wallet.balanceLamports.toString(),
          committedLamports: wallet.committedLamports.toString(),
          prizeLamports: wallet.prizeLamports.toString(),
        })),
      };
    },
  );
}
