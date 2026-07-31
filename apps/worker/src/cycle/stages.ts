import {
  GameMode,
  GameStatus,
  PoolAccountKind,
  Region,
  RoomStatus,
  RoomVisibility,
  SettlementStatus,
} from '@arena/db';
import { requireTier } from '@arena/lobby';
import { redisChannels } from '@arena/redis';
import { roomIdFromUuid } from '@arena/solana';
import { settleGame } from '../settlement/settle.js';
import { matchDurationMs, type CycleStage } from './plan.js';
import type { CycleJobData, StageContext, StageHandler, StageResult } from './types.js';

/**
 * Stage handlers.
 *
 * Every one is idempotent. BullMQ retries on failure, and a stage can also be
 * re-run after a worker restart, so "already done" must be a success rather
 * than a duplicate — the pipeline is at-least-once, not exactly-once.
 */

/** Maps a tier's fee to the game mode recorded against it. */
function modeForTier(tierId: string): GameMode {
  return requireTier(tierId).entryFeeLamports > 0n ? GameMode.WAGER : GameMode.CASUAL;
}

// ---------------------------------------------------------------------------
// 1. create-game
// ---------------------------------------------------------------------------

/**
 * What an unlimited room passes to the on-chain `create_room`.
 *
 * `u16::MAX`, matching `MAX_PLAYERS_PER_ROOM` in the program. The instruction
 * validates the argument against that range, and `Room::player_count` is a u16,
 * so this is the real ceiling rather than an arbitrary large number.
 */
const ON_CHAIN_UNLIMITED_PLAYERS = 65_535;

const createGame: StageHandler = async (data, ctx) => {
  const tier = requireTier(data.tierId);

  // The Room row is per-tier and long-lived; only the Game is per-cycle.
  const room = await ctx.prisma.room.upsert({
    where: { code: tier.id },
    update: { entryFeeLamports: tier.entryFeeLamports, maxPlayers: tier.maxPlayers },
    create: {
      code: tier.id,
      name: tier.name,
      mode: modeForTier(tier.id),
      region: Region.US_EAST,
      visibility: RoomVisibility.PUBLIC,
      status: RoomStatus.ACTIVE,
      maxPlayers: tier.maxPlayers,
      entryFeeLamports: tier.entryFeeLamports,
    },
    select: { id: true },
  });

  // Deterministic on the cycle id, so a retry finds the existing row instead of
  // creating a second game for the same window.
  const existing = await ctx.prisma.game.findFirst({
    where: { roomId: room.id, nodeId: data.cycleId },
    select: { id: true },
  });
  if (existing) {
    ctx.log.info({ cycleId: data.cycleId, gameId: existing.id }, 'game already created');
    return { patch: { gameId: existing.id, roomId: room.id } };
  }

  const game = await ctx.prisma.game.create({
    data: {
      roomId: room.id,
      status: GameStatus.PENDING,
      // Seed is recorded so a disputed match can be replayed from inputs.
      seed: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
      // Reused as the cycle marker until placement assigns a real node.
      nodeId: data.cycleId,
      startedAt: new Date(data.cycleStartedAt),
    },
    select: { id: true },
  });

  return { patch: { gameId: game.id, roomId: room.id } };
};

// ---------------------------------------------------------------------------
// 2. create-pool
// ---------------------------------------------------------------------------

const createPool: StageHandler = async (data, ctx) => {
  const tier = requireTier(data.tierId);
  if (!data.gameId) throw new Error('create-pool ran without a gameId');

  // Free tiers hold no funds, so there is nothing to escrow.
  if (tier.entryFeeLamports === 0n) {
    return { patch: {} };
  }

  const onChainRoomId = roomIdFromUuid(data.gameId);

  // Each match gets its own vault address, derived from its own id. This is
  // pure address arithmetic — `findProgramAddressSync` hashes seeds against the
  // program id and touches no network — so every match has a distinct wallet
  // address whether or not the chain is reachable.
  const vault = ctx.solana.getRoomVaultAddress(onChainRoomId);

  // The off-chain counterpart, created first and unconditionally. Stakes are
  // debited from custody and credited here, so the ledger needs somewhere for
  // the pot to live; without it the entry-fee legs have no destination and
  // `close-lobby` aborts the match. Creating it before the on-chain attempt
  // means a chain outage costs the match its on-chain leg, not its existence.
  await ctx.prisma.poolAccount.upsert({
    where: { name: `escrow:${data.gameId}` },
    update: { onchainAddress: vault.toBase58() },
    create: {
      name: `escrow:${data.gameId}`,
      kind: PoolAccountKind.GAME_ESCROW,
      gameId: data.gameId,
      onchainAddress: vault.toBase58(),
    },
  });

  await ctx.prisma.game.update({
    where: { id: data.gameId },
    data: { onchainMatchPda: vault.toBase58() },
  });

  /**
   * The on-chain leg is best-effort, and its absence is recorded rather than
   * hidden.
   *
   * `settlementStatus` is the honest signal: PENDING once the vault is really
   * initialised on chain, FAILED when it could not be. Nothing downstream may
   * infer "the vault holds lamports" from the address alone — the address
   * exists for every match, funded or not, because it is derived rather than
   * created.
   */
  if (!ctx.solana.canSignOnChain) {
    ctx.log.warn(
      { gameId: data.gameId, vault: vault.toBase58() },
      'no settlement authority; match wallet is ledger-only for this game',
    );
    await ctx.prisma.game.update({
      where: { id: data.gameId },
      data: {
        settlementStatus: SettlementStatus.FAILED,
        settlementError: 'on-chain settlement disabled: no settlement authority configured',
      },
    });
    return { patch: {} };
  }

  try {
    // The vault already holding lamports is the idempotency check: `create_room`
    // fails with "account already in use" on a retry, which is success.
    const balance = await ctx.solana.connection.getBalance(vault);
    if (balance > 0) {
      ctx.log.info({ gameId: data.gameId, vault: vault.toBase58() }, 'escrow vault already exists');
      return { patch: {} };
    }

    await ctx.solana.createRoom({
      roomId: onChainRoomId,
      entryFeeLamports: tier.entryFeeLamports,
      // The instruction takes a u16 and has no way to express "no limit", so an
      // unlimited room passes the largest value the type holds. That is not a
      // fudge — `Room::player_count` is a u16 too, so 65,535 is genuinely where
      // the chain stops counting.
      maxPlayers: tier.maxPlayers ?? ON_CHAIN_UNLIMITED_PLAYERS,
    });

    await ctx.prisma.game.update({
      where: { id: data.gameId },
      data: { settlementStatus: SettlementStatus.PENDING, settlementError: null },
    });
  } catch (error) {
    // Deliberately not rethrown. The pot is safe either way: it lives in the
    // ledger, which is the balance players are actually paid from. Failing the
    // stage would instead cancel a match that can be played and settled
    // correctly, which is the worse outcome — and it would do so every ten
    // minutes, for every tier, until someone noticed.
    const message = error instanceof Error ? error.message : String(error);
    ctx.log.error(
      { gameId: data.gameId, vault: vault.toBase58(), err: error },
      'on-chain room creation failed; continuing with a ledger-only match wallet',
    );
    await ctx.prisma.game.update({
      where: { id: data.gameId },
      data: {
        settlementStatus: SettlementStatus.FAILED,
        settlementError: `create_room failed: ${message}`.slice(0, 500),
      },
    });
  }

  return { patch: {} };
};

// ---------------------------------------------------------------------------
// 3. open-lobby
// ---------------------------------------------------------------------------

const openLobby: StageHandler = async (data, ctx) => {
  /**
   * Every room runs itself.
   *
   * The ten-minute cadence existed for the money: entry fees were reserved at
   * join and consumed together at a moment the whole tier shared, so the match
   * had to start on a clock everyone agreed on.
   *
   * Direct entry removes that. Each player's fee lands in the match vault as
   * they join, under their own signature, so there is nothing left to
   * coordinate — the pot is already correct whenever the room decides to start.
   * A room now waits for its minimum and counts down ten seconds, which is what
   * a player expects from a game rather than from a scheduled tournament.
   */
  const scheduled = false;

  await ctx.lobbies.open(data.tierId, { gameId: data.gameId ?? null, scheduled });
  ctx.log.info({ tierId: data.tierId, gameId: data.gameId, scheduled }, 'lobby open');
  return { patch: {} };
};

// ---------------------------------------------------------------------------
// 4. close-lobby
// ---------------------------------------------------------------------------

const closeLobby: StageHandler = async (data, ctx) => {
  const tier = requireTier(data.tierId);

  // Free rooms launch themselves on their own countdown, so closing one here
  // would yank a match out from under whoever is in it.
  if (tier.entryFeeLamports === 0n) {
    return { patch: {} };
  }

  const lobby = await ctx.lobbies.close(data.tierId);

  if (!lobby || lobby.playerCount < tier.minPlayers) {
    /**
     * Not enough players. Abort rather than fail: an empty lobby is a normal
     * outcome at 4am, not an incident worth retrying or alerting on.
     *
     * But reopen it first. `close` has already run, so the lobby is shut, and
     * aborting here used to leave it that way until the next cycle's
     * `open-lobby` — roughly five minutes of a board showing "In progress" for
     * a match that never started. That is a deadlock, not a wait: the room
     * cannot fill because it is closed, and it closed because it did not fill.
     * Anyone arriving in that window is told to come back later by a room with
     * nobody in it.
     */
    await ctx.lobbies.open(data.tierId, { gameId: data.gameId ?? null });

    ctx.log.info(
      { tierId: data.tierId, players: lobby?.playerCount ?? 0, minimum: tier.minPlayers },
      'not enough players; lobby reopened for the next cycle',
    );

    return {
      abort: { reason: `only ${lobby?.playerCount ?? 0} players; minimum is ${tier.minPlayers}` },
    };
  }

  // Consume the reservations taken at join: the lamports leave each player's
  // custody balance and become the room's pot. Reserving at join and consuming
  // here is what makes this step safe to attempt — by now the money is already
  // known to be present and already spoken for.
  const escrow = await ctx.prisma.poolAccount.findUnique({
    where: { name: `escrow:${data.gameId ?? ''}` },
  });

  if (tier.entryFeeLamports > 0n && !escrow) {
    // Without the escrow account the stakes have nowhere to go. Aborting is
    // the safe side: starting anyway would take money with no ledger record.
    return { abort: { reason: 'escrow pool account is missing; create-pool did not run' } };
  }

  /**
   * The pot is whatever the vault holds.
   *
   * It used to be computed from reservations: `consumeReservations` moved each
   * player's held balance into escrow and the total became the pot. There are
   * no reservations any more — players pay from their own wallets during the
   * countdown — so that call found nothing, threw `StakeMismatchError`, and
   * aborted every paid match before it could start.
   *
   * Reading the vault instead is both simpler and more truthful: the pot is not
   * what we expected players to pay, it is what they actually did. A player who
   * queued and never approved the transaction is simply not in it.
   */
  const vaultLamports = data.gameId
    ? BigInt(
        await ctx.solana.connection
          .getBalance(ctx.solana.getRoomVaultAddress(roomIdFromUuid(data.gameId)))
          .catch(() => 0),
      )
    : 0n;

  // The vault carries its own rent-exempt minimum, which is not prize money.
  // Counting it would pay the winner lamports nobody staked and leave the
  // account below rent, which the runtime refuses.
  const rentFloor = await ctx.solana.connection
    .getMinimumBalanceForRentExemption(0)
    .then((value) => BigInt(value))
    .catch(() => 0n);

  const pot = vaultLamports > rentFloor ? vaultLamports - rentFloor : 0n;

  ctx.log.info(
    { tierId: data.tierId, players: lobby.playerCount, pot: pot.toString() },
    'closing lobby with the fees actually collected',
  );

  if (data.gameId) {
    await ctx.prisma.game.update({
      where: { id: data.gameId },
      data: {
        status: GameStatus.RUNNING,
        playerCount: lobby.playerCount,
        potLamports: pot,
      },
    });
  }

  // Seal the stakes in this room's own on-chain vault. Skipped for free rooms,
  // which have no pot, and when the chain leg is unavailable — by this point
  // the pot has already moved into the escrow account, so throwing would fail a
  // match whose money is sitting exactly where it belongs.
  if (pot > 0n && data.gameId && ctx.solana.canSignOnChain) {
    try {
      await ctx.solana.startRoom(roomIdFromUuid(data.gameId));
    } catch (error) {
      // Already started is the desired end state — a retried stage lands here
      // routinely and must not abort a match that is legitimately running.
      if (isAlreadyStarted(error)) {
        ctx.log.info({ gameId: data.gameId }, 'room already started on chain');
      } else {
        // Recorded, not raised, for the same reason as `create-pool`: the
        // ledger is what players are paid from, and cancelling a playable match
        // over an RPC failure is the worse outcome.
        ctx.log.error({ gameId: data.gameId, err: error }, 'could not seal the vault on chain');
        await ctx.prisma.game.update({
          where: { id: data.gameId },
          data: {
            settlementStatus: SettlementStatus.FAILED,
            settlementError: `start_room failed: ${
              error instanceof Error ? error.message : String(error)
            }`.slice(0, 500),
          },
        });
      }
    }
  }

  return { patch: {} };
};

// ---------------------------------------------------------------------------
// 5. start-match
// ---------------------------------------------------------------------------

const startMatch: StageHandler = async (data, ctx) => {
  if (!data.gameId) throw new Error('start-match ran without a gameId');

  // Announce the match on the room's channel. Clients waiting in the lobby are
  // already subscribed, so they learn the game id and can call `/v1/matchmake`
  // for a ticket — placement itself stays in the matchmaker rather than being
  // duplicated here.
  await ctx.redis.publish(
    redisChannels.matchStarted(data.tierId),
    JSON.stringify({
      tierId: data.tierId,
      gameId: data.gameId,
      startedAt: ctx.now(),
      // The hard ceiling. A match that somehow outlives this is ended by the
      // end-match stage regardless of what the realtime node reports.
      durationMs: matchDurationMs(),
    }),
  );

  ctx.log.info(
    { gameId: data.gameId, tierId: data.tierId, durationMs: matchDurationMs() },
    'match started',
  );

  return { patch: {} };
};

/** `start_room` is once-only on chain; a retry finding it started is success. */
function isAlreadyStarted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already|InvalidRoomStatus|RoomNotOpen/i.test(message);
}

// ---------------------------------------------------------------------------
// 6. end-match
// ---------------------------------------------------------------------------

const endMatch: StageHandler = async (data, ctx) => {
  if (!data.gameId) throw new Error('end-match ran without a gameId');

  const outcome = await settleGame(
    {
      prisma: ctx.prisma,
      redis: ctx.redis,
      solana: ctx.solana,
      log: ctx.log,
      now: ctx.now,
      feeDestination: ctx.feeDestination,
    },
    data.gameId,
  );

  switch (outcome.status) {
    case 'settled':
    case 'already-settled':
      return { patch: {} };

    case 'no-result':
      // The node has not reported yet. Throwing lets BullMQ back off and retry
      // within this stage's attempt budget rather than skipping settlement.
      throw new Error(`Cannot settle ${data.gameId}: ${outcome.reason}`);

    case 'rejected':
      // Verification failed, and the same report will fail identically — so
      // there is no retry that helps. Parking the game for a human was the old
      // behaviour, but the pot is already in escrow by this point: parking it
      // stranded the entry fees of everyone who played. The match produced no
      // valid result, so the honest outcome is to give the stakes back.
      ctx.log.error({ gameId: data.gameId, reasons: outcome.reasons }, 'settlement rejected');
      return { cancel: { reason: `settlement rejected: ${outcome.reasons.join('; ')}` } };

    default:
      return { patch: {} };
  }
};

// ---------------------------------------------------------------------------
// 7. archive-game
// ---------------------------------------------------------------------------

const archiveGame: StageHandler = async (data, ctx) => {
  if (!data.gameId) throw new Error('archive-game ran without a gameId');

  const participants = await ctx.prisma.gamePlayer.findMany({
    where: { gameId: data.gameId },
    select: {
      userId: true,
      placement: true,
      score: true,
      kills: true,
      survivedMs: true,
      entryPaidLamports: true,
      payoutLamports: true,
    },
  });

  const game = await ctx.prisma.game.findUnique({
    where: { id: data.gameId },
    select: { roomId: true, startedAt: true, room: { select: { mode: true, region: true } } },
  });
  if (!game) return { patch: {} };

  // `createMany` with skipDuplicates leans on the (userId, gameId) unique
  // index, which is what makes replaying this stage a no-op.
  await ctx.prisma.matchHistory.createMany({
    data: participants.map((participant) => ({
      userId: participant.userId,
      gameId: data.gameId!,
      roomId: game.roomId,
      mode: game.room.mode,
      region: game.room.region,
      placement: participant.placement,
      score: participant.score,
      kills: participant.kills,
      survivedMs: participant.survivedMs,
      entryLamports: participant.entryPaidLamports,
      payoutLamports: participant.payoutLamports,
      netLamports: participant.payoutLamports - participant.entryPaidLamports,
      playedAt: game.startedAt,
    })),
    skipDuplicates: true,
  });

  // The lobby is freed for the next cycle regardless of how the match went.
  await ctx.lobbies.reset(data.tierId);

  ctx.log.info(
    { gameId: data.gameId, tierId: data.tierId, archived: participants.length },
    'game archived',
  );

  return { patch: {} };
};

export const STAGE_HANDLERS: Readonly<Record<CycleStage, StageHandler>> = Object.freeze({
  'create-game': createGame,
  'create-pool': createPool,
  'open-lobby': openLobby,
  'close-lobby': closeLobby,
  'start-match': startMatch,
  'end-match': endMatch,
  'archive-game': archiveGame,
});

export async function runStage(
  stage: CycleStage,
  data: CycleJobData,
  context: StageContext,
): Promise<StageResult> {
  const handler = STAGE_HANDLERS[stage];
  if (!handler) throw new Error(`No handler for stage ${stage}`);
  return handler(data, context);
}
