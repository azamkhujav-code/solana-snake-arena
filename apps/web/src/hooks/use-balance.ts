'use client';

import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { useWalletStore } from '@/stores/wallet-store';

export function balanceQueryKey(cluster: string, address: string | null) {
  return ['balance', cluster, address] as const;
}

export interface UseBalanceResult {
  lamports: bigint | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * The connected wallet's SOL balance.
 *
 * Polling alone is either stale or wasteful, so this pairs one fetch with an
 * `onAccountChange` subscription: the websocket pushes the new balance the
 * moment a transaction lands, and a slow interval acts purely as a safety net
 * for a dropped subscription.
 */
export function useBalance(): UseBalanceResult {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const cluster = useWalletStore((state) => state.cluster);
  const queryClient = useQueryClient();

  const address = useMemo(() => publicKey?.toBase58() ?? null, [publicKey]);
  const queryKey = balanceQueryKey(cluster, address);

  const query = useQuery({
    queryKey,
    enabled: publicKey !== null,
    queryFn: async (): Promise<bigint> => {
      if (!publicKey) return 0n;
      return BigInt(await connection.getBalance(publicKey, 'confirmed'));
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!publicKey) return;

    const subscriptionId = connection.onAccountChange(
      publicKey,
      (accountInfo) => {
        queryClient.setQueryData(queryKey, BigInt(accountInfo.lamports));
      },
      { commitment: 'confirmed' },
    );

    return () => {
      // Leaking subscriptions across cluster switches would keep the old
      // socket alive and write stale balances into the cache.
      void connection.removeAccountChangeListener(subscriptionId);
    };
    // `queryKey` is derived from cluster + address, both already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, publicKey, queryClient, cluster, address]);

  return {
    lamports: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}

/**
 * Requests an airdrop. Devnet and localnet only — the faucet does not exist
 * elsewhere, and the public devnet faucet is heavily rate-limited.
 */
export function useAirdrop() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const cluster = useWalletStore((state) => state.cluster);
  const queryClient = useQueryClient();

  const canAirdrop = cluster === 'devnet' || cluster === 'localnet';

  const request = async (sol = 1): Promise<string> => {
    if (!publicKey) throw new Error('Connect a wallet first');
    if (!canAirdrop) throw new Error(`Airdrop is not available on ${cluster}`);

    const signature = await connection.requestAirdrop(publicKey, sol * 1_000_000_000);
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature, ...latest }, 'confirmed');

    await queryClient.invalidateQueries({
      queryKey: balanceQueryKey(cluster, publicKey.toBase58()),
    });
    return signature;
  };

  return { canAirdrop, request };
}
