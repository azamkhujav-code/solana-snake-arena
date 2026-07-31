import {
  adminAdjustBalanceRequestSchema,
  adminAdjustBalanceResponseSchema,
  adminPlayerRoleRequestSchema,
  adminPlayerSchema,
  adminPlayerStatusRequestSchema,
  adminPlayersQuerySchema,
  adminPlayersResponseSchema,
} from '@arena/protocol';
import {
  type Prisma,
  PoolAccountKind,
  Severity,
  TransactionDirection,
  TransactionType,
  UserStatus,
} from '@arena/db';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { config } from '../../config.js';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AUDIT_ACTIONS, auditContext, writeAudit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { revokeAllSessions } from '../../services/auth.service.js';
import { getOrCreateCustodyAccount } from '../../services/ledger.js';

type PlayerRow = Prisma.UserGetPayload<{
  include: {
    custodyAccounts: { select: { balanceLamports: true; reservedLamports: true } };
    wallets: { select: { address: true; isPrimary: true } };
  };
}>;

function toAdminPlayer(user: PlayerRow) {
  const custody = user.custodyAccounts[0];
  const primary = user.wallets.find((wallet) => wallet.isPrimary) ?? user.wallets[0];

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    gamesPlayed: user.gamesPlayed,
    wins: user.wins,
    kills: user.kills,
    bestScore: user.bestScore,
    lifetimeWagered: user.lifetimeWagered.toString(),
    lifetimeWon: user.lifetimeWon.toString(),
    netLamports: (user.lifetimeWon - user.lifetimeWagered).toString(),
    balanceLamports: (custody?.balanceLamports ?? 0n).toString(),
    reservedLamports: (custody?.reservedLamports ?? 0n).toString(),
    primaryWallet: primary?.address ?? null,
    walletCount: user.wallets.length,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    deletedAt: user.deletedAt?.toISOString() ?? null,
  };
}

const PLAYER_INCLUDE = {
  custodyAccounts: { select: { balanceLamports: true, reservedLamports: true } },
  wallets: { select: { address: true, isPrimary: true } },
} as const;

/**
 * Player administration.
 *
 * Every mutation here writes an audit row in the same transaction as the change
 * — see `lib/audit.ts`. That coupling is the point: an operator who can move a
 * balance without leaving a trace is indistinguishable from an attacker who has
 * stolen an admin token.
 */
export async function adminPlayerRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/players',
    {
      schema: {
        tags: ['admin'],
        summary: 'Search players',
        description:
          'Free-text `q` matches username or wallet address. Sorting by balance or wagered is what support uses to find the account behind a complaint.',
        security: [{ bearerAuth: [] }],
        querystring: adminPlayersQuerySchema,
        response: { 200: adminPlayersResponseSchema },
      },
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request) => {
      const { q, status, role, sort, limit, cursor } = request.query;

      const where: Prisma.UserWhereInput = {
        ...(status ? { status } : {}),
        ...(role ? { role } : {}),
        ...(q
          ? {
              OR: [
                { username: { contains: q, mode: 'insensitive' } },
                // Wallet addresses are case-sensitive base58, so an
                // insensitive match here would be wrong as well as slower.
                { wallets: { some: { address: { contains: q } } } },
              ],
            }
          : {}),
      };

      // Only `recent` is keyset-safe; the aggregate sorts fall back to offset.
      // Acceptable because they are always used with a filter narrowing the set,
      // and a support agent never pages a hundred deep.
      const orderBy: Prisma.UserOrderByWithRelationInput[] =
        sort === 'wagered'
          ? [{ lifetimeWagered: 'desc' }, { id: 'asc' }]
          : sort === 'games'
            ? [{ gamesPlayed: 'desc' }, { id: 'asc' }]
            : sort === 'balance'
              ? [{ lifetimeWon: 'desc' }, { id: 'asc' }]
              : [{ createdAt: 'desc' }, { id: 'desc' }];

      const rows = await app.prisma.user.findMany({
        where,
        include: PLAYER_INCLUDE,
        orderBy,
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const page = rows.slice(0, limit);

      return {
        players: page.map(toAdminPlayer),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
  );

  api.get(
    '/players/:playerId',
    {
      schema: {
        tags: ['admin'],
        summary: 'Full player record',
        security: [{ bearerAuth: [] }],
        params: z.object({ playerId: z.uuid() }),
        response: { 200: adminPlayerSchema },
      },
    },
    async (request) => {
      const user = await app.prisma.user.findUnique({
        where: { id: request.params.playerId },
        include: PLAYER_INCLUDE,
      });
      if (!user) throw notFound('Player');

      return toAdminPlayer(user);
    },
  );

  api.patch(
    '/players/:playerId/status',
    {
      schema: {
        tags: ['admin'],
        summary: 'Ban, shadowban or reinstate',
        description: [
          '`reason` is mandatory and goes into the audit trail. An unexplained',
          'ban is unreviewable months later, which makes it indistinguishable',
          'from an abusive one.',
          '',
          'A ban does not touch the player’s balance — their money remains theirs',
          'and withdrawable. Confiscation is a separate, deliberate act.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        params: z.object({ playerId: z.uuid() }),
        body: adminPlayerStatusRequestSchema,
        response: { 200: adminPlayerSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const { status, reason } = request.body;
      const { actorId, ipHash } = auditContext(request, config.JWT_SECRET);

      const updated = await app.prisma.$transaction(async (tx) => {
        const before = await tx.user.findUnique({
          where: { id: request.params.playerId },
          select: { status: true, role: true },
        });
        if (!before) throw notFound('Player');

        // Refusing the no-op keeps the audit trail meaningful: a log full of
        // "banned -> banned" entries buries the one that actually changed things.
        if (before.status === status) {
          throw conflict(`Player is already ${status}`);
        }
        // An admin who can be banned by another admin is a support escalation
        // waiting to happen. Role changes go through the role endpoint first.
        if (before.role === 'ADMIN' && status !== UserStatus.ACTIVE) {
          throw badRequest('Demote the admin before changing their status');
        }

        const user = await tx.user.update({
          where: { id: request.params.playerId },
          data: { status },
          include: PLAYER_INCLUDE,
        });

        await writeAudit(tx, {
          action: AUDIT_ACTIONS.playerStatusChanged,
          actorId,
          userId: user.id,
          // A ban is what someone will come asking about; INFO would bury it.
          severity: status === UserStatus.ACTIVE ? Severity.INFO : Severity.WARN,
          metadata: { from: before.status, to: status, reason },
          ipHash,
        });

        return user;
      });

      // Outside the transaction on purpose. The ban is committed by this point,
      // so a Redis failure must not roll it back — a banned player with a live
      // token for a few more minutes is a far better outcome than a ban that
      // silently did not happen. The reconciling read is the session cut-off,
      // which every authenticated request checks.
      if (status !== UserStatus.ACTIVE) {
        try {
          await revokeAllSessions(
            {
              prisma: app.prisma,
              redis: app.redis,
              jwtSign: () => '',
              accessTtlSeconds: config.JWT_ACCESS_TTL_SECONDS,
              domain: config.AUTH_DOMAIN,
            },
            updated.id,
          );
        } catch (error) {
          request.log.error(
            { err: error, userId: updated.id },
            'ban committed but session revocation failed; token expires naturally',
          );
        }
      }

      return toAdminPlayer(updated);
    },
  );

  api.patch(
    '/players/:playerId/role',
    {
      schema: {
        tags: ['admin'],
        summary: 'Grant or revoke privileges',
        description:
          'Granting ADMIN is logged CRITICAL — privilege escalation is the first thing to look for in a compromised-account investigation.',
        security: [{ bearerAuth: [] }],
        params: z.object({ playerId: z.uuid() }),
        body: adminPlayerRoleRequestSchema,
        response: { 200: adminPlayerSchema },
      },
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request) => {
      const { role, reason } = request.body;
      const { actorId, ipHash } = auditContext(request, config.JWT_SECRET);

      // Self-demotion locks the last admin out of their own dashboard, and
      // self-promotion is the move an attacker with a moderator token makes.
      if (request.params.playerId === actorId) {
        throw badRequest('Cannot change your own role');
      }

      const updated = await app.prisma.$transaction(async (tx) => {
        const before = await tx.user.findUnique({
          where: { id: request.params.playerId },
          select: { role: true },
        });
        if (!before) throw notFound('Player');
        if (before.role === role) throw conflict(`Player is already ${role}`);

        const user = await tx.user.update({
          where: { id: request.params.playerId },
          data: { role },
          include: PLAYER_INCLUDE,
        });

        await writeAudit(tx, {
          action: AUDIT_ACTIONS.playerRoleChanged,
          actorId,
          userId: user.id,
          severity: role === 'ADMIN' ? Severity.CRITICAL : Severity.WARN,
          metadata: { from: before.role, to: role, reason },
          ipHash,
        });

        return user;
      });

      return toAdminPlayer(updated);
    },
  );

  api.post(
    '/players/:playerId/adjust-balance',
    {
      schema: {
        tags: ['admin'],
        summary: 'Manually correct a balance',
        description: [
          'Posts a two-leg `ADJUSTMENT` entry between the player’s custody',
          'account and the treasury. It is a real ledger movement, not a balance',
          'edit — the books stay balanced and the correction is as auditable as',
          'any other transfer.',
          '',
          'A positive amount credits the player. Idempotent on',
          '`idempotencyKey`: retrying the same key returns the existing entry',
          'rather than paying twice.',
          '',
          'Logged CRITICAL. This endpoint is the one an attacker would want most.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        params: z.object({ playerId: z.uuid() }),
        body: adminAdjustBalanceRequestSchema,
        response: { 200: adminAdjustBalanceResponseSchema },
      },
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request) => {
      const { amountLamports, reason, idempotencyKey } = request.body;
      const { actorId, ipHash } = auditContext(request, config.JWT_SECRET);
      const delta = BigInt(amountLamports);

      const player = await app.prisma.user.findUnique({
        where: { id: request.params.playerId },
        select: { id: true },
      });
      if (!player) throw notFound('Player');

      const custody = await getOrCreateCustodyAccount(app.prisma, player.id);
      const treasury = await app.prisma.poolAccount.findFirst({
        where: { kind: PoolAccountKind.TREASURY },
      });
      if (!treasury) throw conflict('No treasury account is configured');

      // Scoped by the caller's key so two different corrections cannot collide,
      // and so a retry of *this* correction is recognised as the same one.
      const playerKey = `adjust:${player.id}:${idempotencyKey}`;

      const existing = await app.prisma.transaction.findUnique({
        where: { idempotencyKey: playerKey },
        select: { entryGroupId: true },
      });
      if (existing) {
        const account = await app.prisma.poolAccount.findUnique({ where: { id: custody.id } });
        return {
          entryGroupId: existing.entryGroupId,
          balanceLamports: (account?.balanceLamports ?? 0n).toString(),
          appliedLamports: amountLamports,
          alreadyApplied: true,
        };
      }

      const entryGroupId = randomUUID();

      const result = await app.prisma.$transaction(async (tx) => {
        // Locked read-modify-write via the version counter, same as every other
        // balance mutation — a concurrent settlement must not be clobbered.
        const account = await tx.poolAccount.findUniqueOrThrow({ where: { id: custody.id } });
        const nextBalance = account.balanceLamports + delta;

        // A negative custody balance would mean the player owes the platform,
        // which nothing downstream is built to represent.
        if (nextBalance < 0n) {
          throw badRequest('Adjustment would drive the balance negative');
        }

        const updatedCustody = await tx.poolAccount.update({
          where: { id: account.id, version: account.version },
          data: { balanceLamports: nextBalance, version: { increment: 1 } },
        });

        const treasuryAccount = await tx.poolAccount.findUniqueOrThrow({
          where: { id: treasury.id },
        });
        const treasuryBalance = treasuryAccount.balanceLamports - delta;

        await tx.poolAccount.update({
          where: { id: treasuryAccount.id, version: treasuryAccount.version },
          data: { balanceLamports: treasuryBalance, version: { increment: 1 } },
        });

        // Two legs summing to zero, exactly like any other transfer.
        await tx.transaction.createMany({
          data: [
            {
              entryGroupId,
              type: TransactionType.ADJUSTMENT,
              direction: delta > 0n ? TransactionDirection.CREDIT : TransactionDirection.DEBIT,
              amountLamports: delta > 0n ? delta : -delta,
              balanceAfterLamports: nextBalance,
              userId: player.id,
              poolAccountId: account.id,
              idempotencyKey: playerKey,
              description: `Manual adjustment: ${reason}`.slice(0, 256),
            },
            {
              entryGroupId,
              type: TransactionType.ADJUSTMENT,
              direction: delta > 0n ? TransactionDirection.DEBIT : TransactionDirection.CREDIT,
              amountLamports: delta > 0n ? delta : -delta,
              balanceAfterLamports: treasuryBalance,
              poolAccountId: treasuryAccount.id,
              idempotencyKey: `${playerKey}:treasury`,
              description: `Manual adjustment offset: ${reason}`.slice(0, 256),
            },
          ],
        });

        await writeAudit(tx, {
          action: AUDIT_ACTIONS.balanceAdjusted,
          actorId,
          userId: player.id,
          // Moving a player's money by hand is the highest-consequence thing
          // this API can do.
          severity: Severity.CRITICAL,
          metadata: {
            entryGroupId,
            deltaLamports: delta.toString(),
            balanceBefore: account.balanceLamports.toString(),
            balanceAfter: nextBalance.toString(),
            reason,
          },
          ipHash,
        });

        return updatedCustody;
      });

      return {
        entryGroupId,
        balanceLamports: result.balanceLamports.toString(),
        appliedLamports: amountLamports,
        alreadyApplied: false,
      };
    },
  );
}
