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
  log: Logger;
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
      if (!lobby?.gameId || lobby.playerCount === 0) continue;

      const roomId = roomIdFromUuid(lobby.gameId);

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
          { tierId: tier.id, gameId: lobby.gameId, players: lobby.playerCount },
          'opened the on-chain room for a queued tier',
        );
      } catch (error) {
        if (!complained.has(tier.id)) {
          complained.add(tier.id);
          deps.log.error(
            { err: error, tierId: tier.id, gameId: lobby.gameId },
            'could not open the on-chain room; entry fees cannot be paid into it',
          );
        }
      }
    }
  };
}
