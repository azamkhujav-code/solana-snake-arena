'use client';

import { matchTicketSchema, type MatchTicket } from '@arena/protocol';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiRequest } from '@/lib/api-client';
import { env } from '@/lib/env';
import { useGameStore } from '@/stores/game-store';

import { useLeaveLobby, useLobbies } from './use-lobbies';

/**
 * Takes the player into the match when the room they queued for starts.
 *
 * This was the missing link in the flow. Joining a room reserved the entry fee
 * and took a seat, the worker started the match ten minutes later, and then
 * nothing happened: the client polled a board that said "Match in progress"
 * while the player sat in the lobby watching a game they had paid for and could
 * not reach. The only route to `/play` was a "Quick play" link that bypassed
 * rooms entirely and placed them in an unstaked match.
 *
 * A ticket is minted once, on the transition into `launching`. Tickets are
 * single-use and live thirty seconds, so requesting one per poll would mint a
 * dozen and invalidate each with the next — the guard is what makes this work
 * at all, not an optimisation.
 */
export function useMatchLaunch(): {
  launching: boolean;
  error: string | null;
  playNow: (tierId: string) => Promise<void>;
} {
  const { data } = useLobbies();
  const leaveLobby = useLeaveLobby();
  const router = useRouter();
  const setTicket = useGameStore((state) => state.setTicket);
  const [error, setError] = useState<string | null>(null);

  // The tier a ticket has already been requested for. Reset when the player
  // leaves, so re-queueing the same room later still works.
  const claimed = useRef<string | null>(null);

  const currentTierId = data?.currentTierId ?? null;
  const lobby = currentTierId
    ? (data?.lobbies.find((entry) => entry.tierId === currentTierId) ?? null)
    : null;

  /**
   * Launched, as something a poll can actually see.
   *
   * `status === 'launching'` was the only signal, and it is not one: the lobby
   * launches and reopens for the next round in the same breath, so a poll every
   * two seconds walked straight past it. The player stayed on the room board
   * watching a match they had paid into start without them, and sixty seconds
   * later the seat held for them expired.
   *
   * `pendingMatch` is that seat. It lasts as long as the ticket does, so it is
   * still there whenever the next poll happens to land.
   */
  const pending = data?.pendingMatch ?? null;
  const launching = lobby?.status === 'launching' || pending !== null;

  const enterMatch = useCallback(
    async (tierId: string) => {
      try {
        const ticket = await apiRequest('/v1/matchmake', {
          method: 'POST',
          // The tier is what puts this player in the same room as everyone else
          // who paid into the same pot.
          body: { mode: 'casual', tierId },
          schema: matchTicketSchema,
          baseUrl: env.matchmakerUrl,
        });

        setTicket(ticket as MatchTicket);

        /**
         * Queued and playing are different states.
         *
         * The staked path clears the queue when the lobby launches, but this
         * one mints a ticket directly and never launches the lobby — so the
         * player stayed in the roster for the whole match. Coming back from a
         * game, they were still counted as waiting in the room they had just
         * played: the board showed "Leave", and because the minimum was already
         * met the room counted straight down and pulled them back in.
         *
         * Not awaited. Leaving is bookkeeping; making the player watch a second
         * request before the arena opens would trade a real delay for it. If it
         * fails they are queued for one more round, which the next join
         * corrects anyway — a player occupies at most one queue.
         */
        leaveLobby.mutate(tierId);

        router.push('/play');
      } catch (cause) {
        // Left visible rather than retried: a ticket that cannot be minted
        // usually means no realtime capacity, and hammering it makes that
        // worse. The player keeps their seat and can retry by hand.
        claimed.current = null;
        setError(cause instanceof Error ? cause.message : 'Could not join the match');
      }
    },
    [router, setTicket, leaveLobby],
  );

  useEffect(() => {
    // The tier to enter comes from the staged match when there is one: the
    // launch clears the queue, so `currentTierId` can already be null by the
    // time a seat is being held for this player.
    const tierId = pending?.tierId ?? currentTierId;

    if (!tierId) {
      claimed.current = null;
      return;
    }
    if (!launching || claimed.current === tierId) return;

    claimed.current = tierId;
    void enterMatch(tierId);
  }, [currentTierId, pending, launching, enterMatch]);

  /**
   * Enters a match straight away, without waiting on the lobby.
   *
   * For free rooms. A paid match has to wait: its escrow must exist and every
   * entrant's fee must be consumed in the same moment, which is what the
   * ten-minute cycle coordinates. None of that applies without a pot, and
   * making someone wait up to ten minutes to move a snake around an empty
   * arena — with nothing at stake and nothing to settle — is a cost with no
   * matching benefit.
   *
   * Waiting on `status === 'launching'` does not work here either. A free lobby
   * launches itself the instant its countdown expires, so that state lasts a
   * moment and a two-second poll routinely steps over it. Asking for the ticket
   * directly is both simpler and reliable: the realtime room is keyed by tier
   * and accepts a valid ticket whenever it arrives.
   */
  const playNow = useCallback(
    async (tierId: string) => {
      claimed.current = tierId;
      await enterMatch(tierId);
    },
    [enterMatch],
  );

  return { launching, error, playNow };
}
