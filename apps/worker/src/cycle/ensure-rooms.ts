import {
  GameMode,
  GameStatus,
  Region,
  RoomStatus,
  RoomVisibility,
  type PrismaClient,
} from '@arena/db';
import type { Logger } from '@arena/logger';
// Via the lobby rather than `@arena/protocol` directly: the worker depends on
// the lobby, which re-exports the tier table as the published contract it is.
import { ROOM_TIERS, type LobbyService } from '@arena/lobby';
import type { ArenaService } from '@arena/solana';
import { roomIdFromUuid } from '@arena/solana';

/** Matches `create-pool`: the u16 ceiling, since the tiers have no seat limit. */
const ON_CHAIN_UNLIMITED_PLAYERS = 65_535;

export interface EnsureRoomsDeps {
  solana: ArenaService;
  lobbies: LobbyService;
  prisma: PrismaClient;
  log: Logger;
}

/**
 * Gives a queued lobby a game to pay into, if it has none.
 *
 * `open-lobby` binds one per cycle, but a lobby that reset — a launch that
 * failed, a cycle that aborted — carries a null game id until the next window
 * comes round, up to ten minutes later. The room still fills and still counts
 * down, and the client's entry-fee hook needs a game id to build the payment,
 * so it silently did nothing: no wallet prompt, no error, a countdown ticking
 * at players it was never going to charge.
 *
 * Binding it here rather than waiting means the gap is seconds instead of
 * minutes, and never silent.
 */
async function bindGame(
  deps: EnsureRoomsDeps,
  tier: { id: string; name: string; entryFeeLamports: bigint; maxPlayers: number | null },
): Promise<string | null> {
  const room = await deps.prisma.room.upsert({
    where: { code: tier.id },
    update: {},
    create: {
      code: tier.id,
      name: tier.name,
      mode: GameMode.WAGER,
      region: Region.US_EAST,
      visibility: RoomVisibility.PUBLIC,
      status: RoomStatus.ACTIVE,
      maxPlayers: tier.maxPlayers,
      entryFeeLamports: tier.entryFeeLamports,
    },
    select: { id: true },
  });

  const game = await deps.prisma.game.create({
    data: {
      roomId: room.id,
      status: GameStatus.PENDING,
      seed: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
      // Marks where this game came from, so one bound out of band is
      // distinguishable from one the cycle created.
      nodeId: `ensure:${tier.id}:${Date.now()}`,
      startedAt: new Date(),
    },
    select: { id: true },
  });

  return game.id;
}

/**
 * Opens the on-chain room for any paid tier that has someone waiting in it.
 *
 * `create-pool` does this too, but only at a fixed point in the ten-minute
 * cycle — so a player who joined a minute after it ran had no room to pay into
 * and no way to get one until the next window came round. What they saw was the
 * entry fee refusing itself with "this room is not open on chain yet", for up to
 * ten minutes, on a room the board said was counting down.
 *
 * Creating it here instead ties the room to the thing that actually needs it:
 * somebody being in the queue. Empty tiers still cost nothing, which is the
 * point of not doing this on a timer for all seven.
 *
 * Deliberately quiet about the common failure. The settlement authority pays
 * the rent for every room it opens, and when it runs dry this fails on every
 * pass — logging each one turns a funding problem into a wall of identical
 * errors. The first is logged at error and the rest are suppressed until it
 * succeeds again.
 */
export function createRoomEnsurer(deps: EnsureRoomsDeps): () => Promise<void> {
  const complained = new Set<string>();

  return async function ensureRooms(): Promise<void> {
    if (!deps.solana.canSignOnChain) return;

    for (const tier of ROOM_TIERS) {
      if (tier.entryFeeLamports === 0n) continue;

      const lobby = await deps.lobbies.get(tier.id).catch(() => null);
      if (!lobby || lobby.playerCount === 0) continue;

      let gameId = lobby.gameId;

      if (!gameId) {
        // Players are waiting in a room with nothing to pay into. Left alone
        // this is invisible: the countdown runs, the fee hook finds no game and
        // returns without a word, and the room counts down at people it cannot
        // charge until the next cycle rebinds it.
        try {
          gameId = await bindGame(deps, tier);
          if (!gameId) continue;

          await deps.lobbies.open(tier.id, { gameId, scheduled: false });
          deps.log.warn(
            { tierId: tier.id, gameId, players: lobby.playerCount },
            'queued lobby had no game to pay into; bound one',
          );
        } catch (error) {
          deps.log.error({ err: error, tierId: tier.id }, 'could not bind a game to the lobby');
          continue;
        }
      }

      const roomId = roomIdFromUuid(gameId);

      try {
        // The vault holding lamports is the same idempotency check `create-pool`
        // uses: `create_room` fails with "account already in use" on a retry.
        const vault = deps.solana.getRoomVaultAddress(roomId);
        if ((await deps.solana.connection.getBalance(vault)) > 0) {
          complained.delete(tier.id);
          continue;
        }

        await deps.solana.createRoom({
          roomId,
          entryFeeLamports: tier.entryFeeLamports,
          maxPlayers: tier.maxPlayers ?? ON_CHAIN_UNLIMITED_PLAYERS,
        });

        complained.delete(tier.id);
        deps.log.info(
          { tierId: tier.id, gameId, players: lobby.playerCount },
          'opened the on-chain room for a queued tier',
        );
      } catch (error) {
        if (!complained.has(tier.id)) {
          complained.add(tier.id);
          deps.log.error(
            { err: error, tierId: tier.id, gameId },
            'could not open the on-chain room; entry fees cannot be paid into it',
          );
        }
      }
    }
  };
}
