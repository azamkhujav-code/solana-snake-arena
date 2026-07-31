'use client';

import { useWallet } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { setAccessToken } from '@/lib/api-client';
import { useSessionStore } from '@/stores/session-store';
import { useWalletStore } from '@/stores/wallet-store';

export interface WalletSessionState {
  /** Adapter is reconnecting a previously approved wallet. */
  restoring: boolean;
  connected: boolean;
  wallet: string | null;
  /** The wallet changed since the last session; auth must be redone. */
  changedAccount: boolean;
}

/**
 * Keeps the app session in step with the wallet.
 *
 * Mount once, near the root. Three things it exists to handle:
 *
 * 1. **Account switch.** Phantom lets the user change accounts without
 *    disconnecting. The adapter simply reports a new `publicKey`. Any session
 *    minted for the old wallet is now the wrong identity, so it is dropped
 *    immediately — leaving it in place would let someone act as account A while
 *    the UI shows account B.
 *
 * 2. **Disconnect.** Clearing the session on disconnect stops a stale access
 *    token outliving the wallet that authorised it.
 *
 * 3. **Session restoration.** `autoConnect` restores the *wallet*, not the
 *    *session*. The access token is memory-only by design (localStorage is
 *    readable by any XSS), so after a reload the app is connected but
 *    anonymous, and the UI prompts to sign in again.
 */
export function useWalletSession(): WalletSessionState {
  const { publicKey, connected, connecting, wallet } = useWallet();
  const sessionWallet = useSessionStore((state) => state.wallet);
  const signOutStore = useSessionStore((state) => state.signOut);
  const lastWallet = useWalletStore((state) => state.lastWallet);
  const setLastWallet = useWalletStore((state) => state.setLastWallet);
  const queryClient = useQueryClient();

  const address = publicKey?.toBase58() ?? null;
  const previousAddress = useRef<string | null>(null);

  useEffect(() => {
    const previous = previousAddress.current;
    previousAddress.current = address;

    // Account switched while connected.
    if (previous && address && previous !== address) {
      setAccessToken(null);
      signOutStore();
      queryClient.clear();
      setLastWallet(address);
      return;
    }

    // Disconnected.
    if (previous && !address) {
      setAccessToken(null);
      signOutStore();
      return;
    }

    if (address) setLastWallet(address);
  }, [address, queryClient, setLastWallet, signOutStore]);

  useEffect(() => {
    // The stored session belongs to a different wallet than the connected one.
    // Reachable when persisted state and the adapter disagree after a reload.
    if (sessionWallet && address && sessionWallet !== address) {
      setAccessToken(null);
      signOutStore();
    }
  }, [sessionWallet, address, signOutStore]);

  return {
    restoring: connecting && wallet !== null,
    connected,
    wallet: address,
    changedAccount: Boolean(lastWallet && address && lastWallet !== address),
  };
}
