'use client';

import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';

import { env } from '@/lib/env';

/**
 * Whether the arena program actually exists on the connected cluster.
 *
 * Deposits and withdrawals are instructions *to that program*. If it is not
 * deployed, the transaction cannot succeed — and the failure surfaces inside the
 * wallet as "Failed to simulate the results of this request", a red banner that
 * says nothing about the cause and implicates the user's wallet rather than the
 * app. Asking the cluster first turns that into a sentence we can write.
 *
 * Deliberately a query rather than a one-off check: the answer changes the
 * moment the program is deployed, and a value read once at boot would keep a
 * working app disabled until someone reloaded.
 */
export const programStatusKey = (cluster: string) => ['program-status', cluster] as const;

export function useProgramDeployed(): {
  deployed: boolean | null;
  programId: string;
  checking: boolean;
} {
  const { connection } = useConnection();
  const programId = env.arenaProgramId;

  const query = useQuery({
    queryKey: programStatusKey(connection.rpcEndpoint),
    queryFn: async () => {
      // `getAccountInfo` on a program id returns the executable account. Null
      // means nothing has been deployed at that address.
      const info = await connection.getAccountInfo(new PublicKey(programId));
      return info !== null && info.executable;
    },
    // Deployment happens once. Polling every minute from every open tab spends
    // the IP's shared RPC quota on a fact that almost never changes — and the
    // public devnet endpoint throttles by IP, so this app competes with the
    // user's own wallet transactions. Five minutes still picks up a deploy
    // without anyone reloading, and a reload is instant anyway.
    staleTime: 120_000,
    refetchInterval: 300_000,
    // The answer is cached; a failed poll is not worth a retry storm against an
    // endpoint that is already returning 429.
    retry: false,
    refetchOnWindowFocus: true,
  });

  return {
    // Null while unknown. Callers must not treat "loading" as "missing", or the
    // deposit form would flash a scary warning on every page load.
    deployed: query.data ?? null,
    programId,
    checking: query.isLoading,
  };
}
