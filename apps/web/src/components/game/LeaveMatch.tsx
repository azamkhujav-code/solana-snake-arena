'use client';

import { ROOM_TIERS } from '@arena/protocol';
import { useCallback, useState } from 'react';

import { formatSolShort } from '@/lib/lobby-state';
import { useGameStore } from '@/stores/game-store';

/**
 * Quits the current match.
 *
 * There was no way out while alive. The death screen offered "Leave", but a
 * player who simply wanted to stop had to use the browser's back button — which
 * navigates away without closing the socket, so the server keeps their snake in
 * the arena until the connection times out.
 *
 * Leaving a staked match is a real decision, not a UI action: disconnecting is
 * an elimination, so the entry fee is gone and the pot goes to whoever outlives
 * everyone else. That is confirmed rather than assumed. A free match has nothing
 * to lose and leaves immediately — a confirmation that never carries a cost only
 * teaches people to click through the one that does.
 */
export function LeaveMatch({ onQuit }: { onQuit: () => void }) {
  const roomId = useGameStore((state) => state.roomId);
  const alive = useGameStore((state) => state.alive);
  const [confirming, setConfirming] = useState(false);

  // The realtime room is keyed by tier, so this is what says whether the match
  // is staked. An unranked quick-play room (`node:mode`) matches nothing here
  // and is correctly treated as free.
  const tier = ROOM_TIERS.find((entry) => entry.id === roomId);
  const entryFee = tier?.entryFeeLamports ?? 0n;

  // Only a living player forfeits anything. Once eliminated the fee is already
  // spent, so leaving costs nothing and should not be nagged about.
  const forfeits = entryFee > 0n && alive;

  const quit = useCallback(() => {
    // Delegated so both exits — this button and the death screen's — run the
    // same teardown. This one used to only `reset()`, which left the match
    // mutation holding a ticket and the socket open behind it.
    onQuit();
  }, [onQuit]);

  if (confirming) {
    return (
      <div className="pointer-events-auto w-64 rounded-xl border border-slate-700 bg-slate-900/95 p-3 backdrop-blur-md">
        <p className="text-sm font-medium text-slate-100">Leave the match?</p>
        <p className="mt-1 text-xs text-slate-400">
          Leaving counts as being eliminated. Your {formatSolShort(entryFee)} ◎ entry fee stays in
          the pot for whoever survives.
        </p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={quit}
            className="flex-1 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500"
          >
            Leave anyway
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            Keep playing
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => (forfeits ? setConfirming(true) : quit())}
      className="pointer-events-auto rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1 text-xs text-slate-300 backdrop-blur-md hover:border-rose-700 hover:text-rose-300"
    >
      Leave
    </button>
  );
}
