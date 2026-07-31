import { lamportsSchema, requireTier } from '@arena/protocol';
import { PublicKey } from '@solana/web3.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { conflict, notFound } from '../lib/errors.js';

/**
 * Can this player afford a room?
 *
 * Replaces the custody reservation that used to happen at join. There is no
 * platform balance any more: the entry fee is paid from the player's own wallet
 * into the match vault, so the only meaningful question at join time is whether
 * that wallet holds enough.
 *
 * Deliberately a *check*, not a charge. Money changes hands when the match is
 * about to start, once the room has actually reached its minimum — so a player
 * who queues for a room that never fills pays nothing and there is no refund
 * path to get wrong. Reserving at join was what created the need for refunds in
 * the first place.
 *
 * Read from the chain rather than from any local record. A balance we cached is
 * a balance that can be stale, and being wrong here means either turning away a
 * funded player or letting an unfunded one hold a seat.
 */
export async function fundsRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  const responseSchema = z.object({
    tierId: z.string(),
    /** Entry fee for this room. */
    requiredLamports: lamportsSchema,
    /** What the wallet holds right now, on chain. */
    walletLamports: lamportsSchema,
    /** Fee plus a margin for the transaction that will pay it. */
    sufficient: z.boolean(),
  });

  /**
   * Headroom left for the entry transaction itself.
   *
   * A wallet holding exactly the fee cannot pay it: the transaction costs a few
   * thousand lamports and the account must stay rent-exempt. Turning that into
   * a failed signature in the player's wallet, seconds before a match, is a bad
   * way to learn it — so the check demands the fee plus a small margin.
   */
  const TRANSACTION_HEADROOM = 10_000_000n; // 0.01 SOL

  api.post(
    '/wallet/can-afford',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['wallet'],
        summary: 'Check the caller’s wallet can cover a room’s entry fee',
        description: [
          'Reads the connected wallet’s balance from the chain and compares it',
          'against the tier’s entry fee. Nothing is reserved and nothing moves —',
          'the fee is taken when the match starts, so a room that never fills',
          'costs the player nothing.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        body: z.object({ tierId: z.string().min(1).max(32) }),
        response: { 200: responseSchema },
      },
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (request) => {
      const tier = requireTier(request.body.tierId);
      if (!tier) throw notFound('Unknown room');

      // Free rooms need no wallet at all.
      if (tier.entryFeeLamports === 0n) {
        return {
          tierId: tier.id,
          requiredLamports: '0',
          walletLamports: '0',
          sufficient: true,
        };
      }

      const address = request.user.wallet;
      if (!address) throw conflict('No wallet is connected to this session');

      const lamports = BigInt(
        await app.solana.connection.getBalance(new PublicKey(address), 'confirmed'),
      );
      const needed = tier.entryFeeLamports + TRANSACTION_HEADROOM;

      return {
        tierId: tier.id,
        requiredLamports: tier.entryFeeLamports.toString(),
        walletLamports: lamports.toString(),
        sufficient: lamports >= needed,
      };
    },
  );
}
