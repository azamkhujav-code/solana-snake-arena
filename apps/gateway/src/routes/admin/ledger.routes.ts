import {
  adminAuditQuerySchema,
  adminAuditResponseSchema,
  adminEntryGroupSchema,
  adminTransactionsQuerySchema,
  adminTransactionsResponseSchema,
} from '@arena/protocol';
import type { Prisma } from '@arena/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { signedAmount } from '../../services/admin-treasury.js';

/** Row shape shared by the list and entry-group views. */
type LedgerRow = Prisma.TransactionGetPayload<{
  include: {
    user: { select: { username: true } };
    poolAccount: { select: { name: true } };
  };
}>;

function toAdminTransaction(row: LedgerRow) {
  return {
    id: row.id,
    entryGroupId: row.entryGroupId,
    type: row.type,
    direction: row.direction,
    status: row.status,
    amountLamports: row.amountLamports.toString(),
    signedAmountLamports: signedAmount(row.direction, row.amountLamports).toString(),
    balanceAfterLamports: row.balanceAfterLamports.toString(),
    userId: row.userId,
    username: row.user?.username ?? null,
    poolAccountId: row.poolAccountId,
    poolAccountName: row.poolAccount.name,
    gameId: row.gameId,
    depositId: row.depositId,
    withdrawalId: row.withdrawalId,
    rewardId: row.rewardId,
    idempotencyKey: row.idempotencyKey,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  };
}

const LEDGER_INCLUDE = {
  user: { select: { username: true } },
  poolAccount: { select: { name: true } },
} as const;

/**
 * The ledger browser and the audit trail.
 *
 * Both are append-only and both are read-only here — there is deliberately no
 * endpoint that edits or deletes a transaction. A mistake is corrected by
 * posting a compensating entry, which is what makes the history trustworthy;
 * an admin API that could rewrite it would undo that guarantee in one call.
 */
export async function adminLedgerRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/transactions',
    {
      schema: {
        tags: ['admin'],
        summary: 'Browse the ledger',
        description: [
          'The immutable double-entry ledger. Every row is one leg; `entryGroupId`',
          'ties the legs of a transfer together, and those legs always sum to zero.',
          '',
          '`signedAmountLamports` carries the direction as a sign, so a column of',
          'them sums to the net movement without the reader having to interpret',
          'CREDIT/DEBIT per row.',
          '',
          'Filters compose. `minLamports` is usually the fastest way to find the',
          'movement someone is asking about.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        querystring: adminTransactionsQuerySchema,
        response: { 200: adminTransactionsResponseSchema },
      },
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request) => {
      const { limit, cursor, from, to, type, status, userId, poolAccountId, gameId, minLamports } =
        request.query;

      const where: Prisma.TransactionWhereInput = {
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(userId ? { userId } : {}),
        ...(poolAccountId ? { poolAccountId } : {}),
        ...(gameId ? { gameId } : {}),
        ...(minLamports ? { amountLamports: { gte: BigInt(minLamports) } } : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lt: new Date(to) } : {}),
              },
            }
          : {}),
      };

      const rows = await app.prisma.transaction.findMany({
        where,
        include: LEDGER_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const page = rows.slice(0, limit);

      return {
        transactions: page.map(toAdminTransaction),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
  );

  api.get(
    '/transactions/groups/:entryGroupId',
    {
      schema: {
        tags: ['admin'],
        summary: 'All legs of one transfer',
        description:
          'The view that answers "where did this money actually go?". Legs must sum to zero; `balanced` false means this transfer is the bug.',
        security: [{ bearerAuth: [] }],
        params: z.object({ entryGroupId: z.uuid() }),
        response: { 200: adminEntryGroupSchema },
      },
    },
    async (request) => {
      const legs = await app.prisma.transaction.findMany({
        where: { entryGroupId: request.params.entryGroupId },
        include: LEDGER_INCLUDE,
        orderBy: { createdAt: 'asc' },
      });

      if (legs.length === 0) throw app.httpErrors.notFound('No such entry group');

      const drift = legs.reduce(
        (sum, leg) => sum + signedAmount(leg.direction, leg.amountLamports),
        0n,
      );

      return {
        entryGroupId: request.params.entryGroupId,
        legs: legs.map(toAdminTransaction),
        driftLamports: drift.toString(),
        balanced: drift === 0n,
      };
    },
  );

  api.get(
    '/audit',
    {
      schema: {
        tags: ['admin'],
        summary: 'Admin audit trail',
        description: [
          'Who changed what, when, and why. Written inside the same database',
          'transaction as the change it describes, so there is no path that',
          'produces a mutation nobody can account for.',
          '',
          '**This is not the application log.** Request and error logs go to',
          'stdout and from there to the log shipper; they answer "what did the',
          'process do?" and are subject to retention limits. This table answers',
          '"who touched this player\'s money?" and has to outlive them.',
          '',
          'Client IPs are stored salted-hashed, never raw — the only question',
          'they need to answer is whether two actions came from the same place.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        querystring: adminAuditQuerySchema,
        response: { 200: adminAuditResponseSchema },
      },
    },
    async (request) => {
      const { limit, cursor, from, to, action, severity, actorId, userId } = request.query;

      const where: Prisma.AuditLogWhereInput = {
        ...(action ? { action } : {}),
        ...(severity ? { severity } : {}),
        ...(actorId ? { actorId } : {}),
        ...(userId ? { userId } : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lt: new Date(to) } : {}),
              },
            }
          : {}),
      };

      const rows = await app.prisma.auditLog.findMany({
        where,
        include: { user: { select: { username: true } } },
        orderBy: { id: 'desc' },
        take: limit + 1,
        // The id is a bigint autoincrement, so the cursor arrives as a string
        // and has to go back as one — JSON cannot carry it as a number safely.
        ...(cursor ? { cursor: { id: BigInt(cursor) }, skip: 1 } : {}),
      });

      const page = rows.slice(0, limit);

      return {
        entries: page.map((row) => ({
          id: row.id.toString(),
          action: row.action,
          severity: row.severity,
          actorId: row.actorId,
          userId: row.userId,
          username: row.user?.username ?? null,
          metadata: row.metadata,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id.toString() ?? null) : null,
      };
    },
  );

  api.get(
    '/audit/actions',
    {
      schema: {
        tags: ['admin'],
        summary: 'Distinct actions present in the log',
        description:
          'Populates the filter dropdown from what is actually in the table, rather than from a hard-coded list that drifts as actions are added.',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            actions: z.array(z.object({ action: z.string(), count: z.number().int() })),
          }),
        },
      },
    },
    async () => {
      const rows = await app.prisma.auditLog.groupBy({
        by: ['action'],
        _count: { action: true },
        orderBy: { _count: { action: 'desc' } },
        take: 50,
      });

      return {
        actions: rows.map((row) => ({ action: row.action, count: row._count.action })),
      };
    },
  );
}
