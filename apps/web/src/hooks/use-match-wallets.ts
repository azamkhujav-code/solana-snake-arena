'use client';

import { matchWalletListResponseSchema, type matchWalletSchema } from '@arena/protocol';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { z } from 'zod';

import { apiRequest } from '@/lib/api-client';
import { useSessionStore } from '@/stores/session-store';

export type MatchWallet = z.infer<typeof matchWalletSchema>;

export const matchWalletKeys = {
  list: ['match-wallets'] as const,
};

/**
 * The wallet holding each room's prize pot.
 *
 * A separate request from the lobby board because they come from different
 * services: the board is the matchmaker's Redis queue state, the pot is the
 * gateway's ledger. Joining them server-side would mean giving the matchmaker a
 * database, which is exactly the coupling it was built without.
 *
 * Polled on the same two-second cadence as the board so the two never disagree
 * by more than a tick — a pot that lags the player count makes the arithmetic
 * look wrong even when both numbers are individually correct.
 */
export function useMatchWallets() {
  const authenticated = useSessionStore((state) => state.status === 'authenticated');

  const query = useQuery({
    queryKey: matchWalletKeys.list,
    enabled: authenticated,
    queryFn: () =>
      apiRequest('/v1/matches/wallets', { schema: matchWalletListResponseSchema }),
    refetchInterval: 2_000,
    staleTime: 0,
  });

  // Indexed by tier so a card can look up its own wallet without scanning.
  const byTier = useMemo(() => {
    const map = new Map<string, MatchWallet>();
    for (const wallet of query.data?.wallets ?? []) map.set(wallet.tierId, wallet);
    return map;
  }, [query.data]);

  return { ...query, byTier };
}
