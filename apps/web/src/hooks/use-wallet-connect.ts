'use client';

import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useCallback, useEffect, useRef } from 'react';

import { useWalletStore } from '@/stores/wallet-store';

/**
 * Opens the wallet modal and completes the connection.
 *
 * The completion half is not optional, and it is not obvious why.
 *
 * `WalletProvider`'s `autoConnect` calls `adapter.autoConnect()` when the
 * selected wallet changes. For a legacy adapter that is just `connect()`. But
 * Phantom registers itself as a **Wallet Standard** wallet, so the adapter in
 * play is `StandardWalletAdapter`, whose `autoConnect()` is:
 *
 *     connect({ silent: true })
 *
 * `silent` means *never prompt*. On an origin the wallet has already approved
 * that reconnects invisibly, which is the whole point. On a first connection it
 * does nothing at all — no prompt, no connection, and no error, because
 * declining to prompt is not a failure.
 *
 * The symptom is a user picking Phantom from the modal and watching nothing
 * happen. So a user-initiated selection has to call `connect()` — the
 * prompting path — explicitly.
 *
 * The `intent` ref is what keeps the two apart. Without it, an effect that
 * connects whenever a wallet is selected-but-not-connected would also fire on
 * page load when a silent reconnect legitimately failed, popping an approval
 * dialog at someone who never clicked anything.
 */
export interface WalletConnector {
  /** Opens the modal. Connection is completed automatically once chosen. */
  openWalletModal: () => void;
  connecting: boolean;
}

export function useWalletConnect(): WalletConnector {
  const { wallet, connected, connecting, connect } = useWallet();
  const { setVisible } = useWalletModal();
  const setConnectionError = useWalletStore((state) => state.setConnectionError);

  /** True from the moment the user asks to connect until it resolves. */
  const intent = useRef(false);

  const openWalletModal = useCallback(() => {
    intent.current = true;
    // Clear the previous failure, or a stale message sits under a fresh
    // attempt and reads as a new error.
    setConnectionError(null);
    setVisible(true);
  }, [setConnectionError, setVisible]);

  useEffect(() => {
    if (!intent.current) return;
    if (!wallet || connected || connecting) return;

    // Consumed before awaiting: `connect()` triggers a state update that
    // re-runs this effect, and without clearing first it would fire twice and
    // throw `WalletConnectionError: already connecting`.
    intent.current = false;

    void connect().catch(() => {
      // Reported through the provider's `onError`, which turns it into a
      // message the player can act on. Swallowed here so a rejected prompt is
      // not also an unhandled rejection in the console.
    });
  }, [wallet, connected, connecting, connect]);

  // A modal dismissed without choosing anything leaves the intent set, which
  // would connect on the *next* selection from somewhere else. Clear it when
  // the user ends up connected, or when they pick nothing.
  useEffect(() => {
    if (connected) intent.current = false;
  }, [connected]);

  return { openWalletModal, connecting };
}
