'use client';

import { Button } from '@arena/ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useWalletConnect } from '@/hooks/use-wallet-connect';
import { useWalletSession } from '@/hooks/use-wallet-session';
import { shortenAddress } from '@/lib/cluster';

/**
 * The signed-in account control.
 *
 * Shows who you are and how to leave — copy address, change wallet, sign out.
 * Getting *to* a session is the onboarding panel's job; see the note on the
 * early return below for why that split matters.
 */
export function ConnectWalletButton() {
  const { publicKey, connected, disconnect } = useWallet();
  const { status, signOut } = useAuth();
  const { restoring } = useWalletSession();
  // Opens the modal *and* completes the connection — picking a wallet alone
  // only triggers a silent reconnect, which never prompts. See the hook.
  const { openWalletModal } = useWalletConnect();
  const [menuOpen, setMenuOpen] = useState(false);

  if (restoring) {
    return (
      <Button variant="secondary" size="md" loading disabled>
        Connecting…
      </Button>
    );
  }

  /**
   * Nothing here until there is a session.
   *
   * The onboarding panel owns every pre-session step — connect, sign in,
   * deposit — and explains each one. Repeating those calls to action in the
   * header put two "Install Phantom" links, and then two "Connect wallet"
   * buttons, on the same screen. The E2E suite caught both, and it was right to:
   * a page offering the same first step twice cannot tell you which one is the
   * real one.
   *
   * The header's job is the account — who you are and how to leave — and that
   * only exists once you are signed in.
   */
  if (!connected || !publicKey || status !== 'authenticated') {
    return null;
  }

  return (
    <div className="relative">
      <Button variant="secondary" size="md" onClick={() => setMenuOpen((open) => !open)}>
        {shortenAddress(publicKey.toBase58())}
      </Button>

      {menuOpen ? (
        <div className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-lg border border-slate-800 bg-slate-900 shadow-xl">
          <button
            type="button"
            className="w-full px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
            onClick={() => {
              void navigator.clipboard.writeText(publicKey.toBase58());
              setMenuOpen(false);
            }}
          >
            Copy address
          </button>
          <button
            type="button"
            className="w-full px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
            onClick={() => {
              openWalletModal();
              setMenuOpen(false);
            }}
          >
            Change wallet
          </button>
          <button
            type="button"
            className="w-full px-3 py-2 text-left text-sm text-rose-400 hover:bg-slate-800"
            onClick={() => {
              signOut();
              void disconnect();
              setMenuOpen(false);
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
