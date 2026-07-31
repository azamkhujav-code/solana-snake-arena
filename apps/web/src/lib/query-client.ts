import { QueryClient } from '@tanstack/react-query';

import { ApiRequestError } from './api-client';

/**
 * Shared query defaults.
 *
 * Retrying a 4xx is pointless and, for auth endpoints, actively harmful — it
 * burns the rate-limit budget on a request that will never succeed.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiRequestError && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const queryKeys = {
  session: ['session'] as const,
  player: (playerId: string) => ['player', playerId] as const,
  playerStats: (playerId: string) => ['player', playerId, 'stats'] as const,
  leaderboard: (window: string) => ['leaderboard', window] as const,
  servers: ['servers'] as const,
} as const;
