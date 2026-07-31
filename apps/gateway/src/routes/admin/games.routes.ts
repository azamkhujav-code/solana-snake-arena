import {
  adminGameCancelRequestSchema,
  adminGameCancelResponseSchema,
  adminGameDetailSchema,
  adminGameSchema,
  adminGamesQuerySchema,
  adminGamesResponseSchema,
  adminRoomUpdateRequestSchema,
  adminRoomUpdateResponseSchema,
  adminRoomsResponseSchema,
} from '@arena/protocol';
import {
  cancelGameAndRefund,
  GameAlreadySettledError,
  GameNotFoundError,
  GameStatus,
  type Prisma,
  RefundShortfallError,
  Severity,
  SettlementStatus,
} from '@arena/db';
import type { FastifyInstance } from 'fastify';

import { config } from '../../config.js';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AUDIT_ACTIONS, auditContext, writeAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { signedAmount } from '../../services/admin-treasury.js';

type GameRow = Prisma.GameGetPayload<{
  include: {
    room: { select: { code: true; mode: true; region: true } };
    escrow: { select: { balanceLamports: true } };
  };
}>;

/**
 * Money that entered a game but did not leave it.
 *
 * On a finished game this should be zero. Non-zero means lamports are stranded
 * in the escrow account — the single most useful triage number on the games
 * page, because it distinguishes "settlement failed loudly" from "settlement
 * succeeded but paid the wrong amount", and only the second is silent.
 *
 * Read straight off the escrow balance rather than computed as
 * `pot - payout - rake`. The formula is a restatement of that balance which is
 * only correct while every way of moving money out of an escrow is one of its
 * three terms, and it was wrong in both directions:
 *
 *  * A refunded match still showed its whole pot as unaccounted, because a
 *    REFUND is not a payout and not rake — the books were clean and the page
 *    said otherwise.
 *  * A match whose `close-lobby` consumed the stakes and then died before
 *    writing `potLamports` showed **zero**, because the formula's own inputs
 *    were never recorded. That is the case where money really is stranded, and
 *    it was the one case the number could not see.
 *
 * The account balance has no such blind spot: it is the stranded lamports, not
 * a derivation of them.
 */
export function unaccountedLamports(game: { escrow: { balanceLamports: bigint } | null }): bigint {
  return game.escrow?.balanceLamports ?? 0n;
}

function toAdminGame(game: GameRow) {
  return {
    id: game.id,
    roomId: game.roomId,
    roomCode: game.room.code,
    // Mode and region are properties of the room the game ran in; a game
    // cannot have been played under different terms than its room.
    mode: game.room.mode,
    region: game.room.region,
    status: game.status,
    settlementStatus: game.settlementStatus,
    settlementSignature: game.settlementSignature,
    playerCount: game.playerCount,
    potLamports: game.potLamports.toString(),
    payoutLamports: game.payoutLamports.toString(),
    rakeLamports: game.rakeLamports.toString(),
    unaccountedLamports: unaccountedLamports(game).toString(),
    startedAt: game.startedAt.toISOString(),
    endedAt: game.endedAt?.toISOString() ?? null,
  };
}

/**
 * Games and rooms.
 *
 * The read side is generous; the write side is deliberately thin. There is no
 * "edit game" endpoint — a finished match is a financial record, and the way to
 * fix a wrong one is a compensating ledger entry, not a mutation that leaves no
 * evidence it happened.
 */
export async function adminGameRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/games',
    {
      schema: {
        tags: ['admin'],
        summary: 'Browse games',
        description: [
          '`unaccountedOnly` is the triage filter: it returns games whose escrow',
          'account still holds lamports, meaning money entered the pot and never',
          'came out — neither paid to a winner nor refunded. On a healthy',
          'platform it returns nothing.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        querystring: adminGamesQuerySchema,
        response: { 200: adminGamesResponseSchema },
      },
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request) => {
      const { limit, cursor, from, to, status, settlementStatus, roomId, unaccountedOnly } =
        request.query;

      const where: Prisma.GameWhereInput = {
        ...(status === undefined ? {} : { status }),
        ...(settlementStatus === undefined ? {} : { settlementStatus }),
        ...(roomId === undefined ? {} : { roomId }),
        ...(from === undefined && to === undefined
          ? {}
          : {
              startedAt: {
                ...(from === undefined ? {} : { gte: new Date(from) }),
                ...(to === undefined ? {} : { lt: new Date(to) }),
              },
            }),
      };

      // Applied after the fetch. Bounded by pairing it with COMPLETED — an
      // in-flight game holds its pot by definition and would swamp the result.
      const effectiveWhere: Prisma.GameWhereInput = unaccountedOnly
        ? { ...where, status: status ?? GameStatus.COMPLETED }
        : where;

      const rows = await app.prisma.game.findMany({
        where: effectiveWhere,
        include: {
          room: { select: { code: true, mode: true, region: true } },
          escrow: { select: { balanceLamports: true } },
        },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        // Over-fetch when filtering in memory so a full page can still be
        // returned after the discards.
        take: unaccountedOnly ? Math.min(limit * 10 + 1, 1000) : limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const matching = unaccountedOnly
        ? rows.filter((game) => unaccountedLamports(game) !== 0n)
        : rows;

      const page = matching.slice(0, limit);
      // The cursor must come from the *scanned* rows, not the filtered ones,
      // or paging would restart from the last match and re-scan what it just
      // rejected.
      const scanned = rows.slice(0, unaccountedOnly ? rows.length : limit);
      const more = unaccountedOnly ? rows.length > limit * 10 : rows.length > limit;

      return {
        games: page.map(toAdminGame),
        nextCursor: more ? (scanned[scanned.length - 1]?.id ?? null) : null,
      };
    },
  );

  api.get(
    '/games/:gameId',
    {
      schema: {
        tags: ['admin'],
        summary: 'Game with standings and ledger',
        description:
          'Includes every ledger entry tagged with this game, so the money can be traced from entry fees through to payout without leaving the page.',
        security: [{ bearerAuth: [] }],
        params: z.object({ gameId: z.uuid() }),
        response: { 200: adminGameDetailSchema },
      },
    },
    async (request) => {
      const game = await app.prisma.game.findUnique({
        where: { id: request.params.gameId },
        include: {
          room: { select: { code: true, mode: true, region: true } },
          escrow: { select: { balanceLamports: true } },
          gamePlayers: {
            orderBy: { placement: 'asc' },
            include: { user: { select: { username: true } } },
          },
        },
      });
      if (!game) throw notFound('Game');

      const ledger = await app.prisma.transaction.findMany({
        where: { gameId: game.id },
        include: {
          user: { select: { username: true } },
          poolAccount: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 500,
      });

      return {
        ...toAdminGame(game),
        players: game.gamePlayers.map((player) => ({
          userId: player.userId,
          username: player.user.username,
          placement: player.placement,
          score: player.score,
          kills: player.kills,
          survivedMs: player.survivedMs,
          entryLamports: player.entryPaidLamports.toString(),
          payoutLamports: player.payoutLamports.toString(),
          state: player.result,
        })),
        ledger: ledger.map((row) => ({
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
        })),
      };
    },
  );

  api.post(
    '/games/:gameId/retry-settlement',
    {
      schema: {
        tags: ['admin'],
        summary: 'Re-queue a failed settlement',
        description: [
          'Moves a FAILED settlement back to PENDING so the worker picks it up.',
          'Does not itself move money — payout stays idempotent on the game id,',
          'so this cannot double-pay even if the original attempt partly',
          'succeeded.',
          '',
          'Refuses on games that are not FAILED: re-queueing a settled game is',
          'never the right fix and is usually a misread of the dashboard.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        params: z.object({ gameId: z.uuid() }),
        body: z.object({ reason: z.string().min(8).max(512) }),
        response: { 200: adminGameSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const { actorId, ipHash } = auditContext(request, config.JWT_SECRET);

      const game = await app.prisma.$transaction(async (tx) => {
        const before = await tx.game.findUnique({
          where: { id: request.params.gameId },
          select: { settlementStatus: true },
        });
        if (!before) throw notFound('Game');
        if (before.settlementStatus !== SettlementStatus.FAILED) {
          throw conflict(`Settlement is ${before.settlementStatus}, not FAILED`);
        }

        const updated = await tx.game.update({
          where: { id: request.params.gameId },
          data: { settlementStatus: SettlementStatus.PENDING },
          include: {
            room: { select: { code: true, mode: true, region: true } },
            escrow: { select: { balanceLamports: true } },
          },
        });

        await writeAudit(tx, {
          action: AUDIT_ACTIONS.settlementRetried,
          actorId,
          severity: Severity.WARN,
          metadata: { gameId: updated.id, reason: request.body.reason },
          ipHash,
        });

        return updated;
      });

      return toAdminGame(game);
    },
  );

  api.post(
    '/games/:gameId/cancel',
    {
      schema: {
        tags: ['admin'],
        summary: 'Cancel a match and refund its entry fees',
        description: [
          'For a match that took entry fees and will never produce a result —',
          'a stage that died past `close-lobby`, a node that never reported, a',
          'result that failed verification. Marks the game CANCELLED and posts',
          'balanced REFUND legs returning each stake from the game escrow to',
          'the custody account it came from.',
          '',
          'Idempotent per player on `refund:{gameId}:{userId}`, so a second',
          'call reports the game as already cancelled and moves nothing.',
          '',
          'Refuses on a settled game: the pot has already been paid to a',
          'winner, and refunding it as well would pay it out twice. Refuses',
          'too if the escrow holds less than the entry fees posted against it,',
          'because covering the difference would invent lamports — that case',
          'is a reconciliation, not a refund.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        params: z.object({ gameId: z.uuid() }),
        body: adminGameCancelRequestSchema,
        response: { 200: adminGameCancelResponseSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const { actorId, ipHash } = auditContext(request, config.JWT_SECRET);
      const { gameId } = request.params;

      let result;
      try {
        result = await cancelGameAndRefund(app.prisma, {
          gameId,
          reason: request.body.reason,
          // Written inside the refund's own transaction, so there is no state
          // in which the money moved and the trail does not say who moved it.
          audit: (tx) =>
            writeAudit(tx, {
              action: AUDIT_ACTIONS.gameCancelled,
              actorId,
              severity: Severity.WARN,
              metadata: { gameId, reason: request.body.reason },
              ipHash,
            }),
        });
      } catch (error) {
        if (error instanceof GameNotFoundError) throw notFound('Game');
        if (error instanceof GameAlreadySettledError) {
          throw conflict('This game has already been settled; its pot was paid to the winner');
        }
        if (error instanceof RefundShortfallError) {
          throw conflict(
            `Escrow holds ${error.availableLamports} lamports but ${error.owedLamports} is owed. ` +
              'Reconcile the account before cancelling.',
          );
        }
        throw error;
      }

      const game = await app.prisma.game.findUniqueOrThrow({
        where: { id: gameId },
        include: {
          room: { select: { code: true, mode: true, region: true } },
          escrow: { select: { balanceLamports: true } },
        },
      });

      return {
        game: toAdminGame(game),
        refunds: result.refunds.map((refund) => ({
          userId: refund.userId,
          lamports: refund.lamports.toString(),
        })),
        refundedLamports: result.totalLamports.toString(),
        cancelled: result.cancelled,
      };
    },
  );
}

/** Room configuration. Separate export so the two can be mounted independently. */
export async function adminRoomRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/rooms',
    {
      schema: {
        tags: ['admin'],
        summary: 'Rooms with lifetime volume',
        description:
          'Includes CLOSED rooms, unlike the public endpoint — an operator needs to see the room a complaint refers to even after it was retired.',
        security: [{ bearerAuth: [] }],
        response: { 200: adminRoomsResponseSchema },
      },
    },
    async () => {
      const rooms = await app.prisma.room.findMany({
        orderBy: [{ status: 'asc' }, { entryFeeLamports: 'asc' }],
        include: { _count: { select: { games: true } } },
      });

      // One grouped query rather than a per-room aggregate, which would be a
      // query per row on a page that lists every room.
      const volumes = await app.prisma.game.groupBy({
        by: ['roomId'],
        _sum: { potLamports: true },
      });
      const volumeByRoom = new Map(volumes.map((row) => [row.roomId, row._sum.potLamports ?? 0n]));

      return {
        rooms: rooms.map((room) => ({
          id: room.id,
          code: room.code,
          name: room.name,
          mode: room.mode,
          region: room.region,
          status: room.status,
          visibility: room.visibility,
          maxPlayers: room.maxPlayers,
          entryFeeLamports: room.entryFeeLamports.toString(),
          rakeBps: room.rakeBps,
          gamesPlayed: room._count.games,
          volumeLamports: (volumeByRoom.get(room.id) ?? 0n).toString(),
          createdAt: room.createdAt.toISOString(),
        })),
      };
    },
  );

  api.patch(
    '/rooms/:roomId',
    {
      schema: {
        tags: ['admin'],
        summary: 'Update room configuration',
        description: [
          'Entry fee and rake are **not** editable. Changing the price of a room',
          'players are already queued in changes the deal they agreed to; the',
          'honest operation is to close the room and open a new one, which',
          'leaves the old terms visible in history.',
          '',
          'Set `status` to `DRAINING` to stop new joins while letting the current',
          'match finish — closing outright would strand players mid-game.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        params: z.object({ roomId: z.uuid() }),
        body: adminRoomUpdateRequestSchema,
        response: { 200: adminRoomUpdateResponseSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const { status, name, maxPlayers, reason } = request.body;
      const { actorId, ipHash } = auditContext(request, config.JWT_SECRET);

      if (status === undefined && name === undefined && maxPlayers === undefined) {
        throw conflict('Nothing to change');
      }

      const room = await app.prisma.$transaction(async (tx) => {
        const before = await tx.room.findUnique({
          where: { id: request.params.roomId },
          select: { status: true, name: true, maxPlayers: true },
        });
        if (!before) throw notFound('Room');

        const updated = await tx.room.update({
          where: { id: request.params.roomId },
          data: {
            ...(status === undefined ? {} : { status }),
            ...(name === undefined ? {} : { name }),
            ...(maxPlayers === undefined ? {} : { maxPlayers }),
          },
        });

        await writeAudit(tx, {
          action: AUDIT_ACTIONS.roomUpdated,
          actorId,
          severity: Severity.INFO,
          metadata: {
            roomId: updated.id,
            before,
            after: { status: updated.status, name: updated.name, maxPlayers: updated.maxPlayers },
            reason,
          },
          ipHash,
        });

        return updated;
      });

      return { id: room.id, status: room.status };
    },
  );
}
