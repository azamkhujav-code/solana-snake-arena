'use client';

import { Button, Panel } from '@arena/ui';
import type { PlayerDied } from '@arena/protocol';

export interface DeathOverlayProps {
  death: PlayerDied | null;
  onRespawn: () => void;
  onLeave: () => void;
}

const CAUSE_TEXT: Record<string, string> = {
  collision: 'You ran into another snake',
  wall: 'You hit the boundary',
  disconnect: 'You were disconnected',
  kicked: 'You were removed from the room',
};

/**
 * Death screen, shown over the live game.
 *
 * The canvas keeps rendering underneath — the player stays in spectator mode
 * watching the room rather than staring at a modal over a frozen frame, which
 * is what makes "respawn" feel like rejoining rather than restarting.
 */
export function DeathOverlay({ death, onRespawn, onLeave }: DeathOverlayProps) {
  if (!death) return null;

  return (
    <div className="fixed inset-0 grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm">
      <Panel title="Eliminated" className="pointer-events-auto w-full max-w-sm">
        <p className="mb-1 text-sm text-slate-300">
          {CAUSE_TEXT[death.reason] ?? 'You died'}
          {death.killedBy ? '.' : '.'}
        </p>

        <dl className="my-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-slate-400">Score</dt>
            <dd className="text-xl font-semibold tabular-nums">{death.finalScore}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Survived</dt>
            <dd className="text-xl font-semibold tabular-nums">
              {Math.floor(death.survivedMs / 1_000)}s
            </dd>
          </div>
        </dl>

        <div className="flex gap-2">
          <Button className="flex-1" onClick={onRespawn}>
            Respawn
          </Button>
          <Button variant="secondary" onClick={onLeave}>
            Leave
          </Button>
        </div>

        <p className="mt-3 text-center text-xs text-slate-500">Spectating until you respawn.</p>
      </Panel>
    </div>
  );
}

/** Touch hint, shown once on mobile so the controls are discoverable. */
export function MobileControlsHint({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-8 flex justify-center sm:hidden">
      <p className="rounded-full border border-slate-800 bg-slate-900/80 px-4 py-2 text-xs text-slate-300 backdrop-blur">
        Drag to steer · second finger to boost
      </p>
    </div>
  );
}
