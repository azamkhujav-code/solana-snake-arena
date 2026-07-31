'use client';

import { matchTicketSchema, type GameMode, type MatchTicket } from '@arena/protocol';
import { useMutation } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api-client';
import { env } from '@/lib/env';
import { useGameStore } from '@/stores/game-store';

/**
 * Requests a room placement from the matchmaker.
 *
 * Deliberately a mutation, not a query: it has a side effect (a single-use
 * ticket is minted and reserved) and must never be replayed from cache or
 * refetched on window focus.
 */
export function useMatchmaking() {
  const setStatus = useGameStore((state) => state.setStatus);

  return useMutation<MatchTicket, Error, { mode: GameMode; tierId?: string }>({
    mutationFn: async ({ mode, tierId }) => {
      setStatus('matchmaking');
      return apiRequest('/v1/matchmake', {
        method: 'POST',
        // The tier decides which realtime room this lands in. Without it the
        // placement falls back to node-and-mode, which puts everyone who asked
        // for a casual game in one room regardless of what they paid to enter.
        body: tierId === undefined ? { mode } : { mode, tierId },
        schema: matchTicketSchema,
        baseUrl: env.matchmakerUrl,
      });
    },
    onError: () => setStatus('disconnected'),
    onSuccess: () => setStatus('connecting'),
  });
}
