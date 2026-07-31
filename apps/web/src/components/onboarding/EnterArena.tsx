'use client';

import { Button } from '@arena/ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { useEffect, useRef, useState } from 'react';

import { useConnect } from '@/hooks/use-connect';
import { useMounted } from '@/hooks/use-mounted';
import { useWalletConnect } from '@/hooks/use-wallet-connect';
import { useSessionStore } from '@/stores/session-store';
import { useWalletStore } from '@/stores/wallet-store';

const MAX_NICKNAME = 16;

/**
 * The way in: pick a name, connect a wallet, play.
 *
 * Two steps, in that order, because the first one costs nothing. Asking for a
 * wallet before a player has typed anything puts the highest-friction action
 * first, in front of someone who has not yet decided they want to be here — and
 * a nickname box is the clearest possible signal that this is a game rather
 * than a finance app.
 *
 * There is no deposit step. Entry fees are paid per match, straight from the
 * player's wallet into that match's vault, so there is no platform balance to
 * fund up front and nothing to reclaim if they never play. What used to be a
 * four-step onboarding is now two, and neither of them moves any money.
 */
export function EnterArena() {
  const mounted = useMounted();
  const { connected, wallets } = useWallet();
  const { openWalletModal } = useWalletConnect();
  const { connect, connecting, error } = useConnect();
  const connectionError = useWalletStore((state) => state.connectionError);

  const storedNickname = useSessionStore((state) => state.nickname);
  const authenticated = useSessionStore((state) => state.status === 'authenticated');
  const [nickname, setNickname] = useState(storedNickname);

  const trimmed = nickname.trim();
  const nameReady = trimmed.length > 0;

  /**
   * Starts the session the moment the wallet connects.
   *
   * The flow is "name, wallet, rooms" — three things, not four. Approving in
   * Phantom and then being shown a second button to press is a step with no
   * decision in it: the player has already said who they are and which wallet
   * they are using, and nothing new is being asked. Worse, it looks like
   * nothing happened, because the visible result of approving the connection is
   * that a button changes its label.
   *
   * Guarded by a ref rather than by `connecting`, because a failure must not
   * retry on every render — a rejected connect would otherwise loop against the
   * gateway for as long as the page is open. One attempt per connection; the
   * button below is the manual retry.
   */
  const attempted = useRef(false);

  useEffect(() => {
    if (!connected) {
      // Reset on disconnect so reconnecting tries again.
      attempted.current = false;
      return;
    }
    if (authenticated || attempted.current || !nameReady) return;

    attempted.current = true;
    void connect(trimmed);
  }, [connected, authenticated, nameReady, trimmed, connect]);

  /**
   * Hidden only when the player is genuinely ready: session *and* wallet.
   *
   * A session on its own comes back by itself after a reload, because the
   * refresh token is a cookie. The wallet connection does not — that belongs to
   * the extension, and a reload drops it. Hiding this panel on the session
   * alone left the player looking at a room board with no wallet attached,
   * which fails at the moment they try to pay.
   */
  if (authenticated && connected) return null;

  // Before mount the browser has not been asked what it has, so every answer
  // would differ between the server render and the first client render.
  const hasWallet =
    !mounted ||
    wallets.some((entry) => entry.readyState === 'Installed' || entry.readyState === 'Loadable');

  return (
    <section
      data-testid="enter-arena"
      className="mx-auto w-full max-w-md rounded-xl border border-slate-800 bg-slate-900/50 p-6"
    >
      <h2 className="text-xl font-semibold text-slate-100">
        {authenticated ? 'Reconnect your wallet' : 'Play Slither Arena'}
      </h2>
      <p className="mt-1 text-sm text-slate-400">
        {authenticated
          ? 'Your wallet disconnected. Entry fees are paid straight from it, so reconnect to see the rooms.'
          : 'Pick a name, connect a wallet, and join a room. Entry fees are paid per match — there is no balance to top up.'}
      </p>

      <label className="mt-5 block">
        <span className="text-xs font-medium uppercase tracking-widest text-slate-400">
          Your nickname
        </span>
        <input
          value={nickname}
          onChange={(event) => setNickname(event.target.value.slice(0, MAX_NICKNAME))}
          onKeyDown={(event) => {
            // Enter is the obvious way to submit a single-field form, and the
            // next action depends on how far along they are.
            if (event.key !== 'Enter' || !nameReady) return;
            if (!connected) openWalletModal();
            else void connect(trimmed);
          }}
          placeholder="Snake"
          maxLength={MAX_NICKNAME}
          autoFocus
          className="mt-1.5 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-emerald-500"
        />
        <span className="mt-1 block text-right text-[11px] text-slate-600">
          {trimmed.length}/{MAX_NICKNAME}
        </span>
      </label>

      <div className="mt-2">
        {!hasWallet ? (
          <a
            href="https://phantom.app/download"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-violet-600 text-sm font-medium text-white hover:bg-violet-500"
          >
            Install Phantom
          </a>
        ) : !connected ? (
          <Button className="w-full" disabled={!nameReady} onClick={openWalletModal}>
            {nameReady ? 'Connect wallet' : 'Enter a nickname first'}
          </Button>
        ) : (
          <Button
            className="w-full"
            disabled={!nameReady || connecting}
            loading={connecting}
            onClick={() => void connect(trimmed)}
          >
            {connecting ? 'Entering the arena…' : 'Enter the arena'}
          </Button>
        )}
      </div>

      {connectionError ? <p className="mt-2 text-xs text-amber-400">{connectionError}</p> : null}
      {error ? <p className="mt-2 text-xs text-rose-400">{error.message}</p> : null}

      <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
        No signature needed to look around. Your wallet only signs when you join a paid room, and
        the prize is paid straight back to it.
      </p>
    </section>
  );
}
