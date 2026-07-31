'use client';

import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import {
  ConnectionProvider,
  WalletProvider as BaseWalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { useCallback, useMemo, type ReactNode } from 'react';

import { getCluster } from '@/lib/cluster';
import { useWalletStore, WALLET_ADAPTER_STORAGE_KEY } from '@/stores/wallet-store';

import '@solana/wallet-adapter-react-ui/styles.css';

/**
 * Wallet and RPC context.
 *
 * The endpoint is driven by the persisted cluster selection rather than being a
 * constant, which is what makes "switch to devnet" work without a reload: the
 * ConnectionProvider re-creates its Connection when `endpoint` changes, and
 * every hook reading `useConnection()` follows.
 */
export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const cluster = useWalletStore((state) => state.cluster);
  const config = getCluster(cluster);

  /**
   * Phantom registers itself as a Wallet Standard wallet, and the provider
   * auto-discovers those. The legacy adapter is still listed so the modal has
   * an entry (with an install link) on a browser where Phantom is absent —
   * the provider de-duplicates by name, so it does not appear twice.
   */
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  const setConnectionError = useWalletStore((state) => state.setConnectionError);

  /**
   * Turns an adapter error into something a player can act on.
   *
   * Previously this swallowed `WalletConnectionError` outright on the theory
   * that it only ever means "user cancelled". It does not — a locked wallet, a
   * rejected origin and an extension that failed to inject all surface as the
   * same class, and swallowing them made every one of those look like a button
   * that did nothing.
   *
   * A genuine cancellation is still silent; there is nothing to tell someone
   * who just decided not to connect.
   */
  const onError = useCallback(
    (error: unknown) => {
      const name = (error as { name?: string } | undefined)?.name ?? '';
      const message = (error as { message?: string } | undefined)?.message ?? '';

      // Phantom reports a user rejection as EIP-1193 code 4001, and the
      // adapter passes the message through.
      if (/user rejected|user denied|4001/i.test(message)) {
        setConnectionError(null);
        return;
      }

      if (name === 'WalletNotSelectedError') return;

      if (name === 'WalletNotReadyError') {
        setConnectionError(
          'Phantom was not detected. Install the extension, then reload this page.',
        );
        return;
      }

      // Everything else is a real failure the player needs to see. The console
      // still gets the original for anyone debugging.
      console.warn('[wallet]', error);
      setConnectionError(
        message ||
          'Could not connect. Open the Phantom extension — it may be locked or waiting for approval.',
      );
    },
    [setConnectionError],
  );

  return (
    <ConnectionProvider
      // Remounts the connection when the cluster changes.
      key={config.endpoint}
      endpoint={config.endpoint}
      config={{ commitment: 'confirmed' }}
    >
      <BaseWalletProvider
        wallets={wallets}
        // Reconnects a wallet the user previously approved, with no popup.
        // It cannot silently connect one they never approved.
        autoConnect
        localStorageKey={WALLET_ADAPTER_STORAGE_KEY}
        onError={onError}
      >
        <WalletModalProvider>{children}</WalletModalProvider>
      </BaseWalletProvider>
    </ConnectionProvider>
  );
}
