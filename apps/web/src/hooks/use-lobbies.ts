'use client';

import { lobbyActionResponseSchema, lobbyListResponseSchema } from '@arena/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { apiRequest } from '@/lib/api-client';
import { env } from '@/lib/env';
import { useSessionStore } from '@/stores/session-store';

export const lobbyKeys = {
  list: ['lobbies'] as const,
};

/**
 * The room board.
 *
 * Polled rather than pushed over a socket: lobby state changes a few times a
 * minute, and holding a WebSocket open for every browser sitting in a menu is a
 * lot of connections for that. Two seconds is well inside the shortest
 * countdown, and the card interpolates the timer locally between polls.
 */
export function useLobbies() {
  const authenticated = useSessionStore((state) => state.status === 'authenticated');

  const query = useQuery({
    queryKey: lobbyKeys.list,
    enabled: authenticated,
    queryFn: () =>
      apiRequest('/v1/lobbies', {
        schema: lobbyListResponseSchema,
        baseUrl: env.matchmakerUrl,
      }),
    refetchInterval: 2_000,
    // The board is inherently live; a stale board shows seats that are gone.
    staleTime: 0,
  });

  // Read straight off the query rather than mirroring it into state. Copying it
  // in an effect would re-render on every poll for a value already available,
  // and reading the clock during render is impure.
  //
  // It is 0 until the first fetch lands, which is fine: the board renders a
  // skeleton until `data` exists, so no countdown is computed from it.
  return { ...query, receivedAt: query.dataUpdatedAt };
}

/** Joins a room. The server moves the player if they were queued elsewhere. */
export function useJoinLobby() {
  const queryClient = useQueryClient();
  const nickname = useSessionStore((state) => state.nickname);

  return useMutation({
    mutationFn: (tierId: string) =>
      apiRequest('/v1/lobbies/join', {
        method: 'POST',
        body: { tierId, nickname: nickname || 'Anonymous' },
        schema: lobbyActionResponseSchema,
        baseUrl: env.matchmakerUrl,
      }),
    // Refetch rather than patching the cache: the join may have moved the
    // player out of another room, so more than one card changed.
    onSettled: () => queryClient.invalidateQueries({ queryKey: lobbyKeys.list }),
  });
}

export function useLeaveLobby() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (tierId: string) =>
      apiRequest('/v1/lobbies/leave', {
        method: 'POST',
        body: { tierId },
        schema: lobbyActionResponseSchema,
        baseUrl: env.matchmakerUrl,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: lobbyKeys.list }),
  });
}

export function useSetReady() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ tierId, ready }: { tierId: string; ready: boolean }) =>
      apiRequest('/v1/lobbies/ready', {
        method: 'POST',
        body: { tierId, ready },
        schema: lobbyActionResponseSchema,
        baseUrl: env.matchmakerUrl,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: lobbyKeys.list }),
  });
}

/**
 * Re-renders once a second so countdowns tick.
 *
 * One timer shared by the whole board, not one per card — seven independent
 * intervals would drift apart and the timers would visibly disagree.
 */
export function useSecondTicker(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  return now;
}
