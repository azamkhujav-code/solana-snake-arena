'use client';

import { leaderboardResponseSchema } from '@arena/protocol';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-client';

export type LeaderboardWindow = 'daily' | 'weekly' | 'all-time';

export function useLeaderboard(window: LeaderboardWindow = 'daily') {
  return useQuery({
    queryKey: queryKeys.leaderboard(window),
    queryFn: ({ signal }) =>
      apiRequest(`/v1/leaderboard?window=${window}`, {
        schema: leaderboardResponseSchema,
        signal,
      }),
    // The board is served from a Redis sorted set behind a 5s cache header;
    // polling faster only adds load without showing anything new.
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}
