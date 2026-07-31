'use client';

import type { PlayerDied } from '@arena/protocol';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { DeathOverlay, MobileControlsHint } from '@/components/game/DeathOverlay';
import { Hud } from '@/components/game/Hud';
import { Minimap } from '@/components/game/Minimap';
import type { GameEngine } from '@/game/engine';
import { useLeaveLobby, useLobbies } from '@/hooks/use-lobbies';
import { useMatchmaking } from '@/hooks/use-matchmaking';
import { useGameStore } from '@/stores/game-store';
import { useSessionStore } from '@/stores/session-store';
import { useSettingsStore } from '@/stores/settings-store';

// PixiJS touches `window` and WebGL at import time, so the canvas must never be
// server-rendered.
const GameCanvas = dynamic(
  () => import('@/components/game/GameCanvas').then((mod) => mod.GameCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="fixed inset-0 grid place-items-center text-sm text-slate-400">
        Loading arena…
      </div>
    ),
  },
);

/** Never enters a paid match by accident when there is no queued room. */
const FREE_TIER = 'practice';

export default function PlayPage() {
  const showMinimap = useSettingsStore((state) => state.showMinimap);
  const playerId = useSessionStore((state) => state.playerId);
  const stagedTicket = useGameStore((state) => state.ticket);
  const resetGame = useGameStore((state) => state.reset);
  const router = useRouter();
  const lobbies = useLobbies();
  const matchmaking = useMatchmaking();
  const leaveLobby = useLeaveLobby();

  const engineRef = useRef<GameEngine | null>(null);
  const [death, setDeath] = useState<PlayerDied | null>(null);

  const handleDeath = useCallback((event: PlayerDied) => setDeath(event), []);
  const handleEngineReady = useCallback((engine: GameEngine) => {
    engineRef.current = engine;
  }, []);

  /**
   * Leaves the match for good.
   *
   * `resetGame()` alone did not work, and the reason was the line below it:
   * `ticket` falls back to `matchmaking.data`, which is React Query state that
   * the store's reset cannot touch. Clearing the staged ticket just uncovered
   * the mutation's copy, the canvas never unmounted, and the socket stayed
   * open — so pressing Leave did nothing visible and the snake stayed in play.
   *
   * Order matters: tell the server first, while the socket is still up. Once
   * the canvas unmounts there is nothing left to send the message on.
   */
  const leave = useCallback(() => {
    engineRef.current?.leave();

    // Drop out of the tier queue as well, or the lobby keeps a seat — and the
    // next cycle launches a match for a player who is no longer here.
    const queuedTier = lobbies.data?.currentTierId;
    if (queuedTier) leaveLobby.mutate(queuedTier);

    matchmaking.reset();
    resetGame();
    setDeath(null);
    router.push('/');
    // `matchmaking` and `leaveLobby` are stable mutation objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetGame, router, lobbies.data?.currentTierId]);

  const ticket = stagedTicket ?? matchmaking.data ?? null;

  /**
   * Starts the match on arrival.
   *
   * Opening a room *is* the intent to play, so there was nothing for the old
   * "Find a match" button to ask. It sat on top of the arena demanding a second
   * click to do the only thing this page does — and it was easy to read as the
   * game being broken, because a page that has already navigated you into a
   * match should not then ask whether you want one.
   *
   * Runs once, guarded by a ref: a ticket is single-use and lives thirty
   * seconds, so a second request would mint one and invalidate the first. React
   * 18's development double-mount makes that a real risk, not a theoretical one.
   *
   * The tier comes from whichever room the player is queued in. Falling back to
   * the free room is deliberate — arriving here without a queue should never
   * silently enter a paid match.
   */
  const started = useRef(false);

  useEffect(() => {
    if (ticket || started.current || !playerId) return;
    started.current = true;

    matchmaking.mutate({ mode: 'casual', tierId: lobbies.data?.currentTierId ?? FREE_TIER });
    // `matchmaking` is a stable mutation object; listing it would re-run this on
    // every state change it makes, which is exactly what the ref guards against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket, playerId, lobbies.data?.currentTierId]);

  return (
    <main className="relative h-dvh w-screen overflow-hidden">
      <GameCanvas
        ticket={ticket}
        playerId={playerId}
        onDeath={handleDeath}
        onEngineReady={handleEngineReady}
      />

      <Hud onLeave={leave} />
      {showMinimap ? <Minimap /> : null}

      <DeathOverlay death={death} onLeave={leave} />
      <MobileControlsHint visible={!death && ticket !== null} />

      {!ticket ? (
        <div className="pointer-events-auto fixed inset-0 grid place-items-center bg-slate-950/70 p-4 text-center">
          {matchmaking.isError ? (
            <div className="max-w-sm">
              <p className="text-sm text-rose-300">
                Could not join the arena: {matchmaking.error?.message ?? 'unknown error'}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Usually means no realtime capacity right now.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    matchmaking.mutate({
                      mode: 'casual',
                      tierId: lobbies.data?.currentTierId ?? FREE_TIER,
                    })
                  }
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={leave}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300"
                >
                  Back to rooms
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-300">Entering the arena…</p>
          )}
        </div>
      ) : null}
    </main>
  );
}
