'use client';

import { useConnection } from '@solana/wallet-adapter-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

import { CLUSTER_IDS, getCluster, isMainnet, type ClusterId } from '@/lib/cluster';
import { useWalletStore } from '@/stores/wallet-store';

export interface UseClusterResult {
  cluster: ClusterId;
  config: ReturnType<typeof getCluster>;
  available: ClusterId[];
  /** True once the RPC's genesis hash has been confirmed to match. */
  verified: boolean;
  /** True when the RPC is serving a different chain than the one selected. */
  mismatch: boolean;
  checking: boolean;
  isMainnet: boolean;
  switchCluster: (next: ClusterId) => void;
  switchToDevnet: () => void;
}

/**
 * Cluster selection and verification.
 *
 * A note on "detect the wallet's network": Phantom does not expose its selected
 * network to dApps, and there is no Wallet Standard method for it. What
 * actually determines where a transaction lands is the *dApp's* RPC endpoint,
 * not Phantom's UI setting — so the endpoint is the thing this app controls and
 * verifies. Phantom's own network toggle only affects what Phantom displays.
 *
 * Verification compares the RPC's genesis hash against the known hash for the
 * selected cluster. That is the only trustworthy signal: a URL containing
 * "devnet" proves nothing.
 */
export function useCluster(): UseClusterResult {
  const { connection } = useConnection();
  const cluster = useWalletStore((state) => state.cluster);
  const setCluster = useWalletStore((state) => state.setCluster);
  const setNetworkMismatch = useWalletStore((state) => state.setNetworkMismatch);

  const config = getCluster(cluster);

  const { data, isLoading } = useQuery({
    queryKey: ['cluster-genesis', config.endpoint],
    queryFn: async () => connection.getGenesisHash(),
    // The genesis hash of a chain never changes; only the endpoint can.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });

  const mismatch = Boolean(data && config.genesisHash && data !== config.genesisHash);
  const verified = Boolean(data && config.genesisHash && data === config.genesisHash);

  useEffect(() => {
    setNetworkMismatch(mismatch);
  }, [mismatch, setNetworkMismatch]);

  const switchCluster = useCallback(
    (next: ClusterId) => {
      if (next === cluster) return;
      setCluster(next);
    },
    [cluster, setCluster],
  );

  const switchToDevnet = useCallback(() => switchCluster('devnet'), [switchCluster]);

  return {
    cluster,
    config,
    available: CLUSTER_IDS,
    verified,
    mismatch,
    checking: isLoading,
    isMainnet: isMainnet(cluster),
    switchCluster,
    switchToDevnet,
  };
}
