'use client';

import { Button, Panel } from '@arena/ui';
import type { PlayerDied } from '@arena/protocol';

export interface DeathOverlayProps {
  death: PlayerDied | null;
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
 * Elimination is final: there is no respawn. The button used to be there, and
 * it made the match unwinnable — a player knocked out of a staked room could
 * simply come back, so "last snake standing" never resolved and the pot had no
 * one to pay. Leaving is the only way out, which is what makes the survivor a
 * winner rather than merely the person who was alive most recently.
 *
 * The canvas keeps rendering underneath so the player watches the match settle
 * rather than staring at a modal over a frozen frame.
 */
export function DeathOverlay({ death, onLeave }: DeathOverlayProps) {
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

        <Button className="w-full" onClick={onLeave}>
          Leave match
        </Button>

        <p className="mt-3 text-center text-xs text-slate-500">
          You are out of this match. Spectating until you leave.
        </p>
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
