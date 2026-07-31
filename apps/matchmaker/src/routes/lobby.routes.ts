import {
  lobbyActionResponseSchema,
  lobbyJoinRequestSchema,
  lobbyListResponseSchema,
  lobbyReadyRequestSchema,
  lobbySummarySchema,
} from '@arena/protocol';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { getTier } from '@arena/lobby';

import { canAfford, releaseStake, StakeError } from '../services/stake-client.js';

/**
 * Lobby API.
 *
 * The client polls `GET /lobbies` for the board and calls join/leave/ready.
 * Polling rather than a socket because lobby state changes a few times a minute
 * — a WebSocket per browser sitting in a menu is a lot of connections to hold
 * open for that.
 */
export async function lobbyRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    '/lobbies',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['lobbies'],
        summary: 'The room board',
        description: [
          'Every tier with its current queue size, pot and countdown, plus',
          '`currentTierId` — the room the caller is already queued in, or null.',
          '',
          'Poll this every second or two. `startsInMs` should be counted down',
          'locally between polls; polling faster does not make the countdown',
          'smoother, it only costs requests.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        response: { 200: lobbyListResponseSchema },
      },
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const [lobbies, currentTierId] = await Promise.all([
        app.lobbies.list(),
        app.lobbies.whereIs(request.user.sub),
      ]);

      // Short cache: the board is polled hard and a second of staleness is
      // invisible next to a 30-second countdown.
      void reply.header('cache-control', 'private, max-age=1');
      return { lobbies, currentTierId };
    },
  );

  api.get(
    '/lobbies/:tierId',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['lobbies'],
        summary: 'One room’s live state',
        security: [{ bearerAuth: [] }],
        params: z.object({ tierId: z.string().min(1).max(32) }),
        response: { 200: lobbySummarySchema },
      },
    },
    async (request) => {
      const lobby = await app.lobbies.get(request.params.tierId);
      if (!lobby) throw app.httpErrors.notFound('Unknown room');
      return lobby;
    },
  );

  api.post(
    '/lobbies/join',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['lobbies'],
        summary: 'Join a room queue',
        description: [
          'Takes a seat in the tier’s queue. A player occupies at most one queue',
          'at a time — joining while queued elsewhere moves them rather than',
          'holding two seats.',
          '',
          'Responds `409` when the room is full or its countdown has already',
          'closed. `ticket` is null until placement runs; watch for it on the',
          'lobby board.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        body: lobbyJoinRequestSchema,
        response: { 200: lobbyActionResponseSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const tier = getTier(request.body.tierId);
      if (!tier) throw app.httpErrors.notFound('Unknown room');

      /**
       * Check the wallet, take nothing.
       *
       * The fee is collected from every entrant's own wallet just before the
       * match starts, once the room has actually reached its minimum. Charging
       * at join instead meant a player who queued for a room that never filled
       * had money held against them, which is why a release path existed at all
       * — and why a missed release stranded funds.
       *
       * The check still matters: a seat held by somebody who cannot pay is a
       * seat nobody else can use, and a room that reaches its minimum on paper
       * and then fails to collect is worse than one that never filled.
       */
      const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');

      if (tier.entryFeeLamports > 0n) {
        try {
          const funds = await canAfford(tier.id, token);
          if (!funds.sufficient) {
            throw app.httpErrors.conflict(
              `This room costs ${funds.requiredLamports} lamports and your wallet holds ${funds.walletLamports}.`,
            );
          }
        } catch (error) {
          if (error instanceof StakeError) {
            throw app.httpErrors.createError(error.status, error.message);
          }
          throw error;
        }
      }

      // No stake to hand back on a refusal: nothing was taken. Taking payment
      // at match start rather than at join is what removed the release path,
      // and with it the class of bug where a missed release stranded a fee
      // against a lobby the player was never in.
      const result = await app.lobbies.join(tier.id, {
        playerId: request.user.sub,
        nickname: request.body.nickname,
        wallet: request.user.wallet,
      });

      return { ...result, ticket: null };
    },
  );

  api.post(
    '/lobbies/leave',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['lobbies'],
        summary: 'Leave a room queue',
        description:
          'Idempotent — leaving a queue the caller is not in succeeds and returns the room unchanged, so a client that lost track of its own state can always call this safely.',
        security: [{ bearerAuth: [] }],
        body: z.object({ tierId: z.string().min(1).max(32) }),
        response: { 200: lobbyActionResponseSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request) => {
      const result = await app.lobbies.leave(request.body.tierId, request.user.sub);

      // Best effort, deliberately. A player must always be able to leave a
      // lobby; a stranded reservation is recoverable by the reconciler, while
      // a lobby you cannot exit is not.
      const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      await releaseStake(request.body.tierId, token).catch((error: unknown) => {
        request.log.warn(
          { err: error, tierId: request.body.tierId, playerId: request.user.sub },
          'could not release stake on leave',
        );
      });

      return { ...result, ticket: null };
    },
  );

  api.post(
    '/lobbies/ready',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['lobbies'],
        summary: 'Set the caller’s ready flag',
        description:
          'When every queued player is ready the countdown shortens. Ready is a hint that pulls the start forward, not a gate — an idle player never blocks a match from starting.',
        security: [{ bearerAuth: [] }],
        body: lobbyReadyRequestSchema,
        response: { 200: lobbyActionResponseSchema },
      },
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (request) => {
      const result = await app.lobbies.setReady(
        request.body.tierId,
        request.user.sub,
        request.body.ready,
      );
      return { ...result, ticket: null };
    },
  );
}
