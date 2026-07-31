import { lamportsSchema } from '@arena/protocol';
import { RewardStatus } from '@arena/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { conflict, notFound } from '../lib/errors.js';

const rewardSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  status: z.string(),
  amountLamports: lamportsSchema,
  gameId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  grantedAt: z.iso.datetime().nullable(),
  claimedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});

/**
 * Rewards: prize payouts, bonuses and promotional credit.
 *
 * A reward has a lifecycle of its own rather than being a bare ledger entry,
 * because it can be granted now and claimed later, or expire unclaimed — none
 * of which a single immutable transaction row can express.
 */
export async function rewardRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/rewards',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['rewards'],
        summary: 'List the caller’s rewards',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          status: z.enum(['PENDING', 'GRANTED', 'CLAIMED', 'EXPIRED', 'REVOKED']).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().optional(),
        }),
        response: {
          200: z.object({
            rewards: z.array(rewardSchema),
            nextCursor: z.string().nullable(),
            /** Sum of everything granted but not yet claimed. */
            unclaimedLamports: lamportsSchema,
          }),
        },
      },
    },
    async (request) => {
      const { status, limit, cursor } = request.query;
      const userId = request.user.sub;

      const rows = await app.prisma.reward.findMany({
        where: { userId, ...(status ? { status } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const page = rows.slice(0, limit);

      // Aggregated in the database rather than summed over the page — the
      // total must cover every unclaimed reward, not just this page of them.
      const unclaimed = await app.prisma.reward.aggregate({
        where: { userId, status: RewardStatus.GRANTED },
        _sum: { amountLamports: true },
      });

      return {
        rewards: page.map(toReward),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
        unclaimedLamports: (unclaimed._sum.amountLamports ?? 0n).toString(),
      };
    },
  );

  api.get(
    '/rewards/:rewardId',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['rewards'],
        summary: 'Get one reward',
        security: [{ bearerAuth: [] }],
        params: z.object({ rewardId: z.uuid() }),
        response: { 200: rewardSchema },
      },
    },
    async (request) => {
      const reward = await app.prisma.reward.findUnique({
        where: { id: request.params.rewardId },
      });

      // A 404 rather than a 403: confirming someone else's reward id exists
      // leaks that it does.
      if (!reward || reward.userId !== request.user.sub) throw notFound('Reward');

      return toReward(reward);
    },
  );

  api.post(
    '/rewards/:rewardId/claim',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['rewards'],
        summary: 'Claim a granted reward',
        description:
          'Moves a GRANTED reward to CLAIMED and credits the caller’s custody balance. Idempotent: claiming an already-claimed reward returns it unchanged.',
        security: [{ bearerAuth: [] }],
        params: z.object({ rewardId: z.uuid() }),
        response: { 200: rewardSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const reward = await app.prisma.reward.findUnique({
        where: { id: request.params.rewardId },
      });
      if (!reward || reward.userId !== request.user.sub) throw notFound('Reward');

      // Already claimed is the desired end state, not an error — a retried
      // request after a dropped response must not fail.
      if (reward.status === RewardStatus.CLAIMED) return toReward(reward);

      if (reward.status !== RewardStatus.GRANTED) {
        throw conflict(`Reward is ${reward.status} and cannot be claimed`);
      }
      if (reward.expiresAt && reward.expiresAt.getTime() < Date.now()) {
        throw conflict('Reward has expired');
      }

      // TODO: post the ledger legs crediting custody from the REWARDS pool.
      // Left out deliberately rather than faked — marking a reward CLAIMED
      // without moving the money would put the books out by its amount.
      const updated = await app.prisma.reward.update({
        where: { id: reward.id },
        data: { status: RewardStatus.CLAIMED, claimedAt: new Date() },
      });

      return toReward(updated);
    },
  );
}

function toReward(reward: {
  id: string;
  kind: string;
  status: string;
  amountLamports: bigint;
  gameId: string | null;
  createdAt: Date;
  grantedAt: Date | null;
  claimedAt: Date | null;
  expiresAt: Date | null;
}) {
  return {
    id: reward.id,
    kind: reward.kind,
    status: reward.status,
    amountLamports: reward.amountLamports.toString(),
    gameId: reward.gameId,
    createdAt: reward.createdAt.toISOString(),
    grantedAt: reward.grantedAt?.toISOString() ?? null,
    claimedAt: reward.claimedAt?.toISOString() ?? null,
    expiresAt: reward.expiresAt?.toISOString() ?? null,
  };
}
