import type { z } from 'zod';

import type { lobbySummarySchema } from '@arena/protocol';

export type LobbySummary = z.infer<typeof lobbySummarySchema>;

/**
 * Derives what the join button should say and whether it is usable.
 *
 * Pure, and separate from the component, because this is where all the
 * branching lives — signed out, too poor, full, already queued, mid-launch —
 * and getting any of them wrong produces a button that either lies or does
 * nothing. A component test would exercise this through the DOM; a function
 * test exercises it directly.
 */

export type JoinAction = 'join' | 'leave' | 'sign-in' | 'none';

export interface JoinContext {
  authenticated: boolean;
  /** Spendable custody balance in lamports. Null while it is loading. */
  spendableLamports: bigint | null;
  /** Tier the player is currently queued in, if any. */
  currentTierId: string | null;
  /** A join/leave request is in flight for this tier. */
  pending: boolean;
}

export interface JoinState {
  action: JoinAction;
  label: string;
  disabled: boolean;
  /** Short explanation shown under the button when disabled. */
  reason: string | null;
  /** Highlights the card the player is currently queued in. */
  active: boolean;
}

export function deriveJoinState(lobby: LobbySummary, context: JoinContext): JoinState {
  const active = context.currentTierId === lobby.tierId;

  if (context.pending) {
    return {
      action: active ? 'leave' : 'join',
      label: active ? 'Leaving…' : 'Joining…',
      disabled: true,
      reason: null,
      active,
    };
  }

  // Leaving stays available even once the lobby is full or counting down —
  // the only thing that locks it is the launch itself.
  if (active) {
    if (lobby.status === 'launching') {
      return { action: 'none', label: 'Starting…', disabled: true, reason: null, active };
    }
    return { action: 'leave', label: 'Leave', disabled: false, reason: null, active };
  }

  if (!context.authenticated) {
    return {
      action: 'sign-in',
      label: 'Sign in to play',
      disabled: false,
      reason: null,
      active,
    };
  }

  if (lobby.status === 'launching') {
    return {
      action: 'none',
      label: 'In progress',
      disabled: true,
      reason: 'This room just started. The next one opens shortly.',
      active,
    };
  }

  if (lobby.status === 'closed') {
    return { action: 'none', label: 'Closed', disabled: true, reason: null, active };
  }

  const entryFee = BigInt(lobby.entryFeeLamports);

  // Balance is only a blocker once it is known to be short. Disabling while it
  // is still loading makes every card flash disabled on first paint.
  if (entryFee > 0n && context.spendableLamports !== null && context.spendableLamports < entryFee) {
    return {
      action: 'none',
      label: 'Insufficient balance',
      disabled: true,
      reason: `Deposit at least ${formatSolShort(entryFee - context.spendableLamports)} more SOL.`,
      active,
    };
  }

  if (context.currentTierId !== null) {
    // Joining elsewhere moves the player; the server leaves the old lobby for
    // them. Saying so up front avoids a surprise.
    return {
      action: 'join',
      label: 'Switch to this room',
      disabled: false,
      reason: `Leaves ${context.currentTierId}.`,
      active,
    };
  }

  return {
    action: 'join',
    label: entryFee > 0n ? 'Join' : 'Play free',
    disabled: false,
    reason: null,
    active,
  };
}

/**
 * Gross prize pool: entry fee × players currently queued.
 *
 * Derived rather than sent by the server because it is exactly computable from
 * fields already in the payload — a `poolLamports` field would be one more
 * thing to keep in sync for no new information.
 *
 * Gross, not net: the house rake is applied on-chain at settlement, so showing
 * a net figure here would promise a number this screen cannot know.
 */
export function grossPool(lobby: LobbySummary): bigint {
  return BigInt(lobby.entryFeeLamports) * BigInt(lobby.playerCount);
}

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Compact SOL rendering for dense card layouts. Integer maths only. */
export function formatSolShort(lamports: bigint, maxDecimals = 3): string {
  if (lamports === 0n) return '0';

  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = lamports % LAMPORTS_PER_SOL;

  if (fraction === 0n) return whole.toString();

  const digits = fraction.toString().padStart(9, '0').slice(0, maxDecimals).replace(/0+$/, '');
  if (digits === '') {
    // Non-zero but rounds to nothing at this precision. "<0.001" is honest;
    // "0" would read as free.
    return whole === 0n ? `<0.${'0'.repeat(maxDecimals - 1)}1` : whole.toString();
  }

  return `${whole}.${digits}`;
}

/**
 * Progress toward the match starting, 0..1.
 *
 * Measured against `minPlayers` now that rooms have no seat limit. It used to
 * measure fullness against `maxPlayers`, which no longer exists — and with an
 * unlimited room the only meaningful progress is "how close is this to
 * starting", which is what a player waiting in a lobby actually wants to know.
 *
 * Saturates at 1 rather than continuing to grow, so a room of thirty does not
 * render a bar thirty times too long.
 */
export function fillRatio(lobby: LobbySummary): number {
  if (lobby.minPlayers <= 0) return 1;
  return Math.min(1, lobby.playerCount / lobby.minPlayers);
}

/** Human status line for the card. */
export function statusLabel(lobby: LobbySummary, secondsLeft: number | null): string {
  switch (lobby.status) {
    case 'countdown':
      return secondsLeft !== null && secondsLeft > 0 ? `Starts in ${secondsLeft}s` : 'Starting…';
    case 'launching':
      return 'Match in progress';
    case 'closed':
      return 'Closed';
    default:
      return lobby.playerCount >= lobby.minPlayers
        ? 'Waiting for the next round'
        : `Needs ${lobby.minPlayers - lobby.playerCount} more`;
  }
}

/**
 * Counts a server-provided countdown down locally between polls.
 *
 * The list is polled every couple of seconds, but a timer that only moves when
 * a poll lands looks broken. This interpolates using elapsed wall time and
 * never goes below zero.
 */
export function localCountdown(
  serverSeconds: number | null,
  receivedAtMs: number,
  nowMs: number,
): number | null {
  if (serverSeconds === null) return null;
  const elapsed = Math.max(0, (nowMs - receivedAtMs) / 1_000);
  return Math.max(0, Math.round(serverSeconds - elapsed));
}
