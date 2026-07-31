import { lamportsSchema, requireTier } from '@arena/protocol';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { InsufficientBalanceError, releaseEntryFee, reserveEntryFee } from '@arena/db';

import { conflict, notFound } from '../lib/errors.js';

/**
 * Entry-fee staking.
 *
 * Lives in the gateway rather than the matchmaker because money is an Identity
 * and Custody concern — the matchmaker holds volatile queue state in Redis and
 * has no database at all. The matchmaker calls these on join and leave.
 *
 * The amount is **never taken from the request**. It is looked up from the tier
 * definition server-side, so a client cannot stake one lamport for a five SOL
 * room by asking nicely.
 */
export async function stakeRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  const stakeResponseSchema = z.object({
    tierId: z.string(),
    reservedLamports: lamportsSchema,
    spendableLamports: lamportsSchema,
    /** True when this player had already staked — a retry, not a second charge. */
    alreadyStaked: z.boolean(),
  });

  api.post(
    '/wallet/stake',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['wallet'],
        summary: 'Reserve the entry fee for a room',
        description: [
          'Commits the caller’s stake for a tier. The lamports stay in their',
          'custody account but stop being spendable, so one balance cannot',
          'stake several rooms and a withdrawal cannot drain money a match is',
          'about to lock on chain.',
          '',
          'The fee comes from the tier definition, not the request body.',
          '',
          'Idempotent per player per tier: a double-clicked join reserves once.',
          'Responds `409` when the spendable balance is short.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        body: z.object({ tierId: z.string().min(1).max(32) }),
        response: { 200: stakeResponseSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const tier = requireTierOr404(request.body.tierId);

      const result = await reserveEntryFee(app.prisma, {
        userId: request.user.sub,
        tierId: tier.id,
        lamports: tier.entryFeeLamports,
      }).catch((error: unknown) => {
        // A short balance is the caller's problem, not a server fault.
        if (error instanceof InsufficientBalanceError) throw conflict(error.message);
        throw error;
      });

      return {
        tierId: tier.id,
        reservedLamports: result.reserved.toString(),
        spendableLamports: result.spendableAfter.toString(),
        alreadyStaked: result.already,
      };
    },
  );

  api.post(
    '/wallet/stake/release',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['wallet'],
        summary: 'Release a reserved entry fee',
        description:
          'Called when a player leaves a lobby. Idempotent and silent on a missing reservation — a client that lost track of its own state must be able to call this safely.',
        security: [{ bearerAuth: [] }],
        body: z.object({ tierId: z.string().min(1).max(32) }),
        response: { 200: z.object({ releasedLamports: lamportsSchema }) },
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const result = await releaseEntryFee(app.prisma, {
        userId: request.user.sub,
        tierId: request.body.tierId,
      });

      return { releasedLamports: result.released.toString() };
    },
  );

  /** Unknown tier is a 404, not a 500 from `requireTier` throwing. */
  function requireTierOr404(tierId: string) {
    try {
      return requireTier(tierId);
    } catch {
      throw notFound('Room tier');
    }
  }
}
