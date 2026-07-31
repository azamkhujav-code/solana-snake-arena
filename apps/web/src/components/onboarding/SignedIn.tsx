'use client';

import { useWallet } from '@solana/wallet-adapter-react';
import type { ReactNode } from 'react';

import { useSessionStore } from '@/stores/session-store';

/**
 * Renders its children only for a player who can actually play.
 *
 * That means two things, not one: a session *and* a connected wallet.
 *
 * A session alone is not enough, and checking only for it was a real bug. The
 * refresh token lives in an httpOnly cookie, so a reload silently restores the
 * session — but nothing restores the wallet connection, which the browser
 * extension owns. The player landed on the room board looking ready to play,
 * with no wallet attached and therefore no way to pay an entry fee. Every room
 * would have failed at the point of signing, which is the worst place to
 * discover it.
 *
 * Requiring both also matches what the rooms are for now. Entry fees are paid
 * per match straight from the wallet, so a board you cannot buy into is not a
 * board worth showing.
 *
 * Nothing is rendered in their place: the entry panel above already says what
 * is missing, and a second message repeating it is noise.
 */
export function SignedIn({ children }: { children: ReactNode }) {
  const authenticated = useSessionStore((state) => state.status === 'authenticated');
  const { connected, publicKey } = useWallet();

  if (!authenticated || !connected || !publicKey) return null;
  return <>{children}</>;
}
