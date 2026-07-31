import {
  adminPoolAccountsResponseSchema,
  adminStatsSchema,
  adminTreasurySchema,
} from '@arena/protocol';
import { PoolAccountKind } from '@arena/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  countGames,
  countPlayers,
  countStuck,
  custodyBreakdown,
  deriveAlerts,
  resolveWindow,
  sumMoneyFlow,
} from '../../services/admin-stats.js';
import { buildTreasurySnapshot, sumPoolsByKind } from '../../services/admin-treasury.js';

/**
 * Statistics, treasury and pool accounts.
 *
 * All read-only. Nothing here can change state, which is why these are the
 * endpoints a MODERATOR is allowed to reach — see the guard in `index.ts`.
 */
export async function adminOverviewRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/stats',
    {
      schema: {
        tags: ['admin'],
        summary: 'Dashboard overview',
        description: [
          'Every figure is scoped to a window (default 24h) rather than lifetime.',
          'A lifetime total says nothing about whether the platform is healthy',
          'now, which is the only question this page exists to answer.',
          '',
          '`alerts` is empty when nothing needs attention — it is not a status',
          'feed. Anything in it is a real problem.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          from: z.iso.datetime().optional(),
          to: z.iso.datetime().optional(),
        }),
        response: { 200: adminStatsSchema },
      },
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request) => {
      const window = resolveWindow(request.query.from, request.query.to);

      // The treasury snapshot is reused for both the custody breakdown and the
      // solvency alert; running it twice would double the chain read.
      const [players, games, money, stuck, treasury] = await Promise.all([
        countPlayers(app.prisma, window),
        countGames(app.prisma, window),
        sumMoneyFlow(app.prisma, window),
        countStuck(app.prisma),
        buildTreasurySnapshot(app.prisma, app.solana, { groupScanSince: window.from }),
      ]);

      return {
        windowHours: window.hours,
        players,
        games,
        money: {
          depositedInWindow: money.deposited.toString(),
          withdrawnInWindow: money.withdrawn.toString(),
          wageredInWindow: money.wagered.toString(),
          rakeInWindow: money.rake.toString(),
          netFlowInWindow: money.net.toString(),
        },
        custody: custodyBreakdown(treasury.pools),
        alerts: deriveAlerts({
          failedSettlements: games.failedSettlement,
          stuckWithdrawals: stuck,
          ledgerBalanced: treasury.ledgerBalanced,
          custodySolvent: treasury.custodySolvent,
          imbalancedGroups: treasury.imbalancedGroups.length,
        }),
      };
    },
  );

  api.get(
    '/treasury',
    {
      schema: {
        tags: ['admin'],
        summary: 'Chain-versus-ledger reconciliation',
        description: [
          'Three numbers that must agree: what the chain holds, what the pool',
          'balances say, and what the posted ledger sums to.',
          '',
          '`ledgerDriftLamports` non-zero is a software bug — a balance moved',
          'without a matching entry, or the reverse.',
          '',
          '`custodyCoverageLamports` negative is insolvency: the vault holds less',
          'than the platform owes players. It is null, not zero, when the RPC is',
          'unreachable — an outage is not evidence of a shortfall.',
          '',
          '`imbalancedEntryGroups` catches what the global check cannot: two',
          'broken transfers whose errors cancel out platform-wide. Scanned over',
          'the last 24h only, since a dashboard is not the right tool for an',
          'archaeological audit.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        response: { 200: adminTreasurySchema },
      },
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async () => {
      const snapshot = await buildTreasurySnapshot(app.prisma, app.solana, {
        groupScanSince: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });

      return {
        onchain: {
          treasuryLamports: snapshot.onchain.treasuryLamports?.toString() ?? null,
          poolLamports: snapshot.onchain.poolLamports?.toString() ?? null,
          fetchedAt: snapshot.onchain.fetchedAt?.toISOString() ?? null,
          error: snapshot.onchain.error,
        },
        offchain: {
          playerCustodyLamports: snapshot.pools.playerCustody.toString(),
          escrowLamports: snapshot.pools.escrow.toString(),
          treasuryLamports: snapshot.pools.treasury.toString(),
          rakeLamports: snapshot.pools.rake.toString(),
          rewardsLamports: snapshot.pools.rewards.toString(),
          poolTotalLamports: snapshot.pools.total.toString(),
          ledgerTotalLamports: snapshot.ledgerTotal.toString(),
        },
        invariants: {
          ledgerDriftLamports: snapshot.ledgerDrift.toString(),
          ledgerBalanced: snapshot.ledgerBalanced,
          custodyCoverageLamports: snapshot.custodyCoverage?.toString() ?? null,
          custodySolvent: snapshot.custodySolvent,
          imbalancedEntryGroups: snapshot.imbalancedGroups.map((group) => ({
            entryGroupId: group.entryGroupId,
            driftLamports: group.drift.toString(),
          })),
        },
      };
    },
  );

  api.get(
    '/pool-accounts',
    {
      schema: {
        tags: ['admin'],
        summary: 'Browse pool accounts',
        description: [
          'Every account in the double-entry system. `USER_CUSTODY` is one per',
          'player and dominates the count, so it is filtered out by default —',
          'pass `kind=USER_CUSTODY` to page through them.',
          '',
          '`totals` covers every matching account, not just the returned page.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          kind: z
            .enum(['USER_CUSTODY', 'GAME_ESCROW', 'TREASURY', 'RAKE', 'REWARDS', 'EXTERNAL'])
            .optional(),
          /** Hides zero-balance accounts, which are the vast majority. */
          nonZeroOnly: z.coerce.boolean().default(false),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().optional(),
        }),
        response: { 200: adminPoolAccountsResponseSchema },
      },
    },
    async (request) => {
      const { kind, nonZeroOnly, limit, cursor } = request.query;

      const where = {
        ...(kind ? { kind } : {}),
        ...(nonZeroOnly ? { NOT: { balanceLamports: 0n } } : {}),
      };

      const [rows, totalsByKind, count] = await Promise.all([
        app.prisma.poolAccount.findMany({
          where,
          orderBy: [{ balanceLamports: 'desc' }, { id: 'asc' }],
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
        app.prisma.poolAccount.groupBy({
          by: ['kind'],
          where,
          _sum: { balanceLamports: true, reservedLamports: true },
        }),
        app.prisma.poolAccount.count({ where }),
      ]);

      const page = rows.slice(0, limit);
      const totals = sumPoolsByKind(
        totalsByKind.map((row) => ({ kind: row.kind, balance: row._sum.balanceLamports ?? 0n })),
      );
      const reserved = totalsByKind.reduce(
        (sum, row) => sum + (row._sum.reservedLamports ?? 0n),
        0n,
      );

      return {
        accounts: page.map((account) => ({
          id: account.id,
          kind: account.kind,
          name: account.name,
          ownerUserId: account.ownerUserId,
          gameId: account.gameId,
          balanceLamports: account.balanceLamports.toString(),
          reservedLamports: account.reservedLamports.toString(),
          spendableLamports: (account.balanceLamports - account.reservedLamports).toString(),
          onchainAddress: account.onchainAddress,
          version: account.version,
          updatedAt: account.updatedAt.toISOString(),
        })),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
        totals: {
          balanceLamports: totals.total.toString(),
          reservedLamports: reserved.toString(),
          count,
        },
      };
    },
  );

  api.get(
    '/pool-accounts/:accountId/ledger',
    {
      schema: {
        tags: ['admin'],
        summary: 'Statement for one pool account',
        description:
          'Every posted entry against the account, newest first. `balanceAfterLamports` lets an auditor replay the account without recomputing from the beginning.',
        security: [{ bearerAuth: [] }],
        params: z.object({ accountId: z.uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().optional(),
        }),
        response: {
          200: z.object({
            account: z.object({
              id: z.uuid(),
              name: z.string(),
              kind: z.string(),
              balanceLamports: z.string(),
            }),
            entries: z.array(
              z.object({
                id: z.uuid(),
                entryGroupId: z.uuid(),
                type: z.string(),
                direction: z.string(),
                signedAmountLamports: z.string(),
                balanceAfterLamports: z.string(),
                description: z.string().nullable(),
                createdAt: z.iso.datetime(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const account = await app.prisma.poolAccount.findUnique({
        where: { id: request.params.accountId },
      });
      if (!account) throw app.httpErrors.notFound('Pool account not found');

      const { limit, cursor } = request.query;
      const rows = await app.prisma.transaction.findMany({
        where: { poolAccountId: account.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const page = rows.slice(0, limit);

      return {
        account: {
          id: account.id,
          name: account.name,
          kind: account.kind,
          balanceLamports: account.balanceLamports.toString(),
        },
        entries: page.map((row) => ({
          id: row.id,
          entryGroupId: row.entryGroupId,
          type: row.type,
          direction: row.direction,
          signedAmountLamports: (row.direction === 'CREDIT'
            ? row.amountLamports
            : -row.amountLamports
          ).toString(),
          balanceAfterLamports: row.balanceAfterLamports.toString(),
          description: row.description,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
  );

  // A convenience the treasury page links to: the escrow account for a game,
  // which is where money goes missing if a settlement half-completes.
  api.get(
    '/pool-accounts/by-game/:gameId',
    {
      schema: {
        tags: ['admin'],
        summary: 'Escrow account for a game',
        security: [{ bearerAuth: [] }],
        params: z.object({ gameId: z.uuid() }),
        response: {
          200: z.object({
            id: z.uuid(),
            name: z.string(),
            balanceLamports: z.string(),
            reservedLamports: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const account = await app.prisma.poolAccount.findFirst({
        where: { gameId: request.params.gameId, kind: PoolAccountKind.GAME_ESCROW },
      });
      if (!account) throw app.httpErrors.notFound('No escrow account for that game');

      return {
        id: account.id,
        name: account.name,
        balanceLamports: account.balanceLamports.toString(),
        reservedLamports: account.reservedLamports.toString(),
      };
    },
  );
}
