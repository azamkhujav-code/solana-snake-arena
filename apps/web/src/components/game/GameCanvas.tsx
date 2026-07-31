'use client';

import type { LeaderboardEntry, PlayerDied } from '@arena/protocol';
import { useEffect, useRef, useState } from 'react';

import { GameEngine, type EngineHud } from '@/game/engine';
import { connectToRoom, type ArenaSocket } from '@/game/net/socket-client';
import { selfRank } from '@/lib/hud-state';
import { useGameStore } from '@/stores/game-store';
import { useSettingsStore } from '@/stores/settings-store';

export interface GameCanvasProps {
  /** Ticket from the matchmaker. Null renders the canvas idle. */
  ticket: Parameters<typeof connectToRoom>[0] | null;
  playerId: string | null;
  onDeath?: (event: PlayerDied) => void;
  onEngineReady?: (engine: GameEngine) => void;
}

/**
 * Mounts the PixiJS engine onto a canvas.
 *
 * The engine lives in a ref, never in state — putting it in state would
 * re-render the whole tree whenever it changed and defeat the point of keeping
 * the render loop out of React.
 */
export function GameCanvas({ ticket, playerId, onDeath, onEngineReady }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const socketRef = useRef<ArenaSocket | null>(null);
  /** Latest nicknames, so the kill feed can name players outside React state. */
  const nicknamesRef = useRef(new Map<string, string>());

  const quality = useSettingsStore((state) => state.quality);
  const setStatus = useGameStore((state) => state.setStatus);
  const setRoom = useGameStore((state) => state.setRoom);
  const setHud = useGameStore((state) => state.setHud);
  const setLeaderboard = useGameStore((state) => state.setLeaderboard);
  const setNetworkStats = useGameStore((state) => state.setNetworkStats);
  const recordDeath = useGameStore((state) => state.recordDeath);
  const resetForMatch = useGameStore((state) => state.resetForMatch);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ticket || !playerId) return;

    let cancelled = false;
    const engine = new GameEngine();
    engineRef.current = engine;

    const socket = connectToRoom(ticket);
    socketRef.current = socket;

    resetForMatch();
    setRoom(ticket.roomId, playerId);

    const handleHud = (hud: EngineHud): void => {
      nicknamesRef.current = hud.nicknames;

      setHud({
        score: hud.score,
        mass: hud.mass,
        alive: hud.alive,
        spectating: hud.spectating,
        elapsedMs: hud.elapsedMs,
        worldRadius: hud.worldRadius,
        selfPosition: hud.selfPosition,
        otherPositions: hud.otherPositions,
        fps: hud.fps,
      });
      setNetworkStats({ rttMs: hud.rttMs, packetLoss: 0 });
    };

    const handleLeaderboard = (entries: LeaderboardEntry[]): void => {
      setLeaderboard(entries);
      // Rank comes from the board rather than being computed locally — the
      // client only sees entities inside its own view.
      setHud({ rank: selfRank(entries, playerId) });
    };

    const handleDeath = (event: PlayerDied): void => {
      recordDeath(event, playerId, nicknamesRef.current);
      // Only the player's own death opens the overlay; the rest are feed items.
      if (event.playerId === playerId) onDeath?.(event);
    };

    socket.on('connect', () => setStatus('connected'));
    socket.on('disconnect', () => setStatus('reconnecting'));
    socket.on('connect_error', (err) => {
      setError(err.message);
      setStatus('disconnected');
    });

    void engine
      .init({
        canvas,
        socket,
        playerId,
        quality,
        onHud: handleHud,
        onLeaderboard: handleLeaderboard,
        onDeath: handleDeath,
      })
      .then(() => {
        if (cancelled) {
          engine.destroy();
          return;
        }
        socket.connect();
        onEngineReady?.(engine);
      })
      .catch((initError: unknown) => {
        setError(initError instanceof Error ? initError.message : 'Failed to start the renderer');
      });

    const handleResize = (): void => engine.resize(window.innerWidth, window.innerHeight);
    window.addEventListener('resize', handleResize);

    // Pausing in a hidden tab stops burning battery on a game nobody is
    // watching. The server keeps simulating; the snapshot buffer catches up.
    const handleVisibility = (): void => {
      if (document.hidden) engine.stop();
      else engine.start();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibility);

      // Order matters: tear the engine down before the socket, or a late
      // snapshot arrives after the renderer is gone.
      engine.destroy();
      socket.removeAllListeners();
      socket.disconnect();

      engineRef.current = null;
      socketRef.current = null;
      setStatus('idle');
    };
  }, [
    ticket,
    playerId,
    quality,
    onDeath,
    onEngineReady,
    recordDeath,
    resetForMatch,
    setHud,
    setLeaderboard,
    setNetworkStats,
    setRoom,
    setStatus,
  ]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="fixed inset-0 h-full w-full touch-none select-none"
        aria-label="Game arena"
      />
      {error ? (
        <div className="pointer-events-none fixed inset-0 grid place-items-center">
          <p className="rounded-lg border border-rose-900 bg-rose-950/90 px-4 py-2 text-sm text-rose-200">
            {error}
          </p>
        </div>
      ) : null}
    </>
  );
}
