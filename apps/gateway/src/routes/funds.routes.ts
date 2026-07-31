import { lamportsSchema, requireTier } from '@arena/protocol';
import { findRoomPda, findRoomPlayerPda, roomIdFromUuid } from '@arena/solana';
import { PublicKey } from '@solana/web3.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { config } from '../config.js';
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
   * A wallet holding exactly the fee cannot pay it: `enter_room` opens a
   * `RoomPlayer` account for the player, and the payer funds its rent-exempt
   * minimum on top of the fee and the signature. That account is 98 bytes,
   * which is a little over 0.0015 SOL, so 0.002 covers it with room for the
   * signature and a fee bump.
   *
   * This was 0.01 SOL against a comment describing "a few thousand lamports" —
   * a margin six times the real cost and, on the bronze tier, larger than the
   * entry fee itself. A player holding 0.014 SOL was told a 0.01 SOL room was
   * unaffordable, which is both wrong and unarguable: the message quoted the
   * fee, so the two numbers it printed said they had enough.
   */
  const TRANSACTION_HEADROOM = 2_000_000n; // 0.002 SOL

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
        // What the wallet must actually hold, not just the fee. Reporting the
        // fee here while judging `sufficient` against fee-plus-headroom is what
        // produced refusals whose own numbers said the player could pay.
        requiredLamports: needed.toString(),
        walletLamports: lamports.toString(),
        sufficient: lamports >= needed,
      };
    },
  );

  /**
   * Has this player's entry fee actually landed?
   *
   * `enter_room` opens a `RoomPlayer` account for the payer and moves the fee
   * in the same instruction, so the account existing *is* the payment — there
   * is no state where the seat is recorded and the money is not.
   *
   * Read from the chain rather than trusting the client. A staked match must
   * not start until every entrant has paid, and the client's own claim to have
   * paid is exactly the thing an unpaid player would send.
   */
  api.post(
    '/wallet/has-paid',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['wallet'],
        summary: 'Whether the caller has paid into a match vault',
        security: [{ bearerAuth: [] }],
        body: z.object({ gameId: z.uuid() }),
        response: { 200: z.object({ gameId: z.string(), paid: z.boolean() }) },
      },
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request) => {
      const address = request.user.wallet;
      if (!address) throw conflict('No wallet is connected to this session');

      const [roomPlayer] = findRoomPlayerPda(
        new PublicKey(config.ARENA_PROGRAM_ID),
        findRoomPda(new PublicKey(config.ARENA_PROGRAM_ID), roomIdFromUuid(request.body.gameId))[0],
        new PublicKey(address),
      );

      const info = await app.solana.connection.getAccountInfo(roomPlayer, 'confirmed');
      return { gameId: request.body.gameId, paid: info !== null };
    },
  );
}
