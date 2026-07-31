import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { DEFAULT_CLUSTER, type ClusterId } from '@/lib/cluster';

export interface WalletState {
  /** Cluster the app talks to. Drives the ConnectionProvider endpoint. */
  cluster: ClusterId;
  /**
   * Last connected wallet address.
   *
   * Persisted purely so an account switch can be *detected* on the next load —
   * comparing it against what the adapter reconnects to. It is not an auth
   * credential and grants nothing on its own.
   */
  lastWallet: string | null;
  /** Set when the RPC's genesis hash disagrees with the selected cluster. */
  networkMismatch: boolean;
  /**
   * Why the last connection attempt failed, in words a player can act on.
   *
   * The adapter reports failures through an `onError` callback and nowhere
   * else — a failed connect simply leaves the button reading "Connect Wallet"
   * again. Without somewhere to put the reason, the entire failure mode is
   * indistinguishable from a click that did nothing.
   */
  connectionError: string | null;

  setCluster: (cluster: ClusterId) => void;
  setLastWallet: (address: string | null) => void;
  setNetworkMismatch: (mismatch: boolean) => void;
  setConnectionError: (message: string | null) => void;
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set) => ({
      cluster: DEFAULT_CLUSTER,
      lastWallet: null,
      networkMismatch: false,
      connectionError: null,

      setCluster: (cluster) => set({ cluster, networkMismatch: false }),
      setLastWallet: (lastWallet) => set({ lastWallet }),
      setNetworkMismatch: (networkMismatch) => set({ networkMismatch }),
      setConnectionError: (connectionError) => set({ connectionError }),
    }),
    {
      name: 'arena-wallet',
      // `networkMismatch` is derived at runtime; persisting it would surface a
      // stale warning on a reload that has not checked anything yet.
      partialize: (state) => ({ cluster: state.cluster, lastWallet: state.lastWallet }),
    },
  ),
);

/**
 * localStorage key the wallet adapter uses to remember the selected wallet.
 *
 * Named explicitly rather than left as the library default so it is greppable
 * and so clearing app state clears wallet selection with it.
 */
export const WALLET_ADAPTER_STORAGE_KEY = 'arena-wallet-name';
