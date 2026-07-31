'use client';

import {
  adminAdjustBalanceResponseSchema,
  adminAuditResponseSchema,
  adminGameCancelResponseSchema,
  adminGameDetailSchema,
  adminGameSchema,
  adminGamesResponseSchema,
  adminPlayerSchema,
  adminPlayersResponseSchema,
  adminPoolAccountsResponseSchema,
  adminRoomsResponseSchema,
  adminRoomUpdateResponseSchema,
  adminStatsSchema,
  adminTransactionsResponseSchema,
  adminTreasurySchema,
} from '@arena/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api-client';

/**
 * Admin data access.
 *
 * Poll intervals are deliberately conservative. An operator dashboard left open
 * on a wall display is a client that never goes away, and every one of these
 * endpoints runs aggregate queries — the treasury view even makes a chain call.
 * A five-second refresh across a handful of open tabs is a self-inflicted load
 * test against the database that serves real money.
 */

export const adminKeys = {
  stats: (range: string) => ['admin', 'stats', range] as const,
  treasury: ['admin', 'treasury'] as const,
  pools: (filters: string) => ['admin', 'pools', filters] as const,
  transactions: (filters: string) => ['admin', 'transactions', filters] as const,
  players: (filters: string) => ['admin', 'players', filters] as const,
  player: (id: string) => ['admin', 'player', id] as const,
  games: (filters: string) => ['admin', 'games', filters] as const,
  game: (id: string) => ['admin', 'game', id] as const,
  rooms: ['admin', 'rooms'] as const,
  audit: (filters: string) => ['admin', 'audit', filters] as const,
} as const;

/** Drops empty values so the query key and the URL agree on what a filter is. */
export function toQueryString(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }

  const query = search.toString();
  return query ? `?${query}` : '';
}

export function useAdminStats(from?: string, to?: string) {
  const query = toQueryString({ from, to });

  return useQuery({
    queryKey: adminKeys.stats(query),
    queryFn: ({ signal }) =>
      apiRequest(`/v1/admin/stats${query}`, { schema: adminStatsSchema, signal }),
    // The overview aggregates across several tables; a minute of staleness is
    // invisible against a 24-hour window.
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useAdminTreasury() {
  return useQuery({
    queryKey: adminKeys.treasury,
    queryFn: ({ signal }) =>
      apiRequest('/v1/admin/treasury', { schema: adminTreasurySchema, signal }),
    // Makes an RPC call. Polling this hard would rate-limit the node the game
    // itself depends on.
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useAdminPools(filters: { kind?: string; nonZeroOnly?: boolean; cursor?: string }) {
  const query = toQueryString(filters);

  return useQuery({
    queryKey: adminKeys.pools(query),
    queryFn: ({ signal }) =>
      apiRequest(`/v1/admin/pool-accounts${query}`, {
        schema: adminPoolAccountsResponseSchema,
        signal,
      }),
  });
}

export function useAdminTransactions(filters: Record<string, string | number | undefined>) {
  const query = toQueryString(filters);

  return useQuery({
    queryKey: adminKeys.transactions(query),
    queryFn: ({ signal }) =>
      apiRequest(`/v1/admin/transactions${query}`, {
        schema: adminTransactionsResponseSchema,
        signal,
      }),
  });
}

export function useAdminPlayers(filters: Record<string, string | number | undefined>) {
  const query = toQueryString(filters);

  return useQuery({
    queryKey: adminKeys.players(query),
    queryFn: ({ signal }) =>
      apiRequest(`/v1/admin/players${query}`, { schema: adminPlayersResponseSchema, signal }),
  });
}

export function useAdminGames(filters: Record<string, string | number | boolean | undefined>) {
  const query = toQueryString(filters);

  return useQuery({
    queryKey: adminKeys.games(query),
    queryFn: ({ signal }) =>
      apiRequest(`/v1/admin/games${query}`, { schema: adminGamesResponseSchema, signal }),
  });
}

export function useAdminGame(gameId: string | null) {
  return useQuery({
    queryKey: adminKeys.game(gameId ?? ''),
    queryFn: ({ signal }) =>
      apiRequest(`/v1/admin/games/${gameId ?? ''}`, { schema: adminGameDetailSchema, signal }),
    enabled: gameId !== null,
  });
}

export function useAdminRooms() {
  return useQuery({
    queryKey: adminKeys.rooms,
    queryFn: ({ signal }) =>
      apiRequest('/v1/admin/rooms', { schema: adminRoomsResponseSchema, signal }),
  });
}

export function useAdminAudit(filters: Record<string, string | number | undefined>) {
  const query = toQueryString(filters);

  return useQuery({
    queryKey: adminKeys.audit(query),
    queryFn: ({ signal }) =>
      apiRequest(`/v1/admin/audit${query}`, { schema: adminAuditResponseSchema, signal }),
    // The audit trail is the page an operator watches during an incident.
    refetchInterval: 30_000,
  });
}

/* ---- Mutations --------------------------------------------------------- */

/**
 * Every mutation invalidates the audit log as well as its own resource.
 *
 * The point of the trail is that it shows what just happened; an operator who
 * bans someone and does not immediately see the entry appear has no feedback
 * that the trail is working at all.
 */
function useAdminMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  invalidate: readonly (readonly unknown[])[],
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const key of [...invalidate, ['admin', 'audit'] as const]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useSetPlayerStatus(playerId: string) {
  return useAdminMutation(
    (body: { status: string; reason: string }) =>
      apiRequest(`/v1/admin/players/${playerId}/status`, {
        method: 'PATCH',
        body,
        schema: adminPlayerSchema,
      }),
    [adminKeys.player(playerId), ['admin', 'players']],
  );
}

export function useSetPlayerRole(playerId: string) {
  return useAdminMutation(
    (body: { role: string; reason: string }) =>
      apiRequest(`/v1/admin/players/${playerId}/role`, {
        method: 'PATCH',
        body,
        schema: adminPlayerSchema,
      }),
    [adminKeys.player(playerId), ['admin', 'players']],
  );
}

export function useAdjustBalance(playerId: string) {
  return useAdminMutation(
    (body: { amountLamports: string; reason: string; idempotencyKey: string }) =>
      apiRequest(`/v1/admin/players/${playerId}/adjust-balance`, {
        method: 'POST',
        body,
        schema: adminAdjustBalanceResponseSchema,
      }),
    // A balance change moves the treasury too, so the treasury view is stale.
    [adminKeys.player(playerId), ['admin', 'players'], adminKeys.treasury, ['admin', 'pools']],
  );
}

export function useUpdateRoom(roomId: string) {
  return useAdminMutation(
    (body: { status?: string; name?: string | null; maxPlayers?: number; reason: string }) =>
      apiRequest(`/v1/admin/rooms/${roomId}`, {
        method: 'PATCH',
        body,
        schema: adminRoomUpdateResponseSchema,
      }),
    [adminKeys.rooms],
  );
}

export function useRetrySettlement(gameId: string) {
  return useAdminMutation(
    (body: { reason: string }) =>
      apiRequest(`/v1/admin/games/${gameId}/retry-settlement`, {
        method: 'POST',
        body,
        schema: adminGameSchema,
      }),
    [adminKeys.game(gameId), ['admin', 'games'], adminKeys.stats('')],
  );
}

/**
 * Abandons a match and returns its entry fees.
 *
 * Invalidates the treasury and pool views as well as the game: this is the one
 * game-level action that moves balances, so leaving those cached would show an
 * operator a stranded pot they have just refunded.
 */
export function useCancelGame(gameId: string) {
  return useAdminMutation(
    (body: { reason: string }) =>
      apiRequest(`/v1/admin/games/${gameId}/cancel`, {
        method: 'POST',
        body,
        schema: adminGameCancelResponseSchema,
      }),
    [
      adminKeys.game(gameId),
      ['admin', 'games'],
      adminKeys.treasury,
      ['admin', 'pools'],
      ['admin', 'transactions'],
    ],
  );
}
