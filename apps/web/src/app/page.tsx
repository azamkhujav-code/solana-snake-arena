import Link from 'next/link';

import { RoomSelect } from '@/components/lobby/RoomSelect';
import { EnterArena } from '@/components/onboarding/EnterArena';
import { SignedIn } from '@/components/onboarding/SignedIn';
import { ConnectWalletButton } from '@/components/wallet/ConnectWalletButton';
import { NetworkBadge, SwitchToDevnetPrompt } from '@/components/wallet/NetworkBadge';
import { TransactionHistory, WalletBalance } from '@/components/wallet/WalletPanel';

/**
 * The lobby.
 *
 * Ordered as the player progresses: name and wallet, then the rooms, then the
 * money. Everything below the entry panel needs a session, so it stays hidden
 * until there is one rather than rendering seven cards that all say "sign in".
 */
export default function LobbyPage() {
  return (
    // Wider than the rest of the app: the room board is a three-column grid and
    // squeezing seven cards into a prose-width column wastes the layout.
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">Slither Arena</h1>
        <div className="flex items-center gap-3">
          <NetworkBadge />
          <ConnectWalletButton />
        </div>
      </header>

      <SwitchToDevnetPrompt />

      <EnterArena />

      {/* Everything below needs a session: the board reads the player's queue
          state and the panels read their balance. */}
      <SignedIn>
        <RoomSelect />

        {/* No custody panel: there is no platform balance to deposit into or
            withdraw from. Fees are paid per match and prizes land back in the
            wallet, so the wallet's own balance and the match history are the
            only numbers that mean anything. */}
        <div className="grid gap-6 lg:grid-cols-2">
          <WalletBalance />
          <TransactionHistory />
        </div>
      </SignedIn>

      <nav className="flex gap-4 text-sm text-slate-400">
        <Link href="/leaderboard" className="hover:text-slate-200">
          Leaderboard
        </Link>
        <Link href="/profile" className="hover:text-slate-200">
          Profile
        </Link>
      </nav>
    </main>
  );
}
