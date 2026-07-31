import type { RoomTier } from './tiers.js';

/**
 * Lobby state machine.
 *
 * Deliberately pure: given a state, an event and a clock reading, it returns
 * the next state. Every rule about capacity, readiness, auto-start and
 * countdown cancellation lives here, so all of it is testable without Redis,
 * without timers, and without a network.
 *
 * The storage layer's only job is to load a state, apply this function, and
 * write it back atomically.
 */

export type LobbyStatus = 'waiting' | 'countdown' | 'launching' | 'closed';

export interface LobbyPlayer {
  playerId: string;
  nickname: string;
  wallet: string;
  joinedAt: number;
  ready: boolean;
}

export interface LobbyState {
  tierId: string;
  status: LobbyStatus;
  players: LobbyPlayer[];
  /** Epoch ms the countdown fires. Null unless status is `countdown`. */
  countdownEndsAt: number | null;
  /** Set when the lobby launches; identifies the game it became. */
  gameId: string | null;
  /**
   * True when a fixed-cadence cycle owns the lifecycle.
   *
   * In scheduled mode the lobby never auto-starts its own countdown — the
   * worker's `close-lobby` stage decides when play begins. Without this flag
   * the two mechanisms fight: a lobby reaching its minimum would launch on its
   * own timer minutes before the cycle expected to close it.
   */
  scheduled: boolean;
  /** Optimistic-concurrency guard for the storage layer. */
  version: number;
}

export type LobbyEvent =
  | { type: 'join'; player: Omit<LobbyPlayer, 'joinedAt' | 'ready'> }
  | { type: 'leave'; playerId: string }
  | { type: 'ready'; playerId: string; ready: boolean }
  | { type: 'tick' }
  | { type: 'launched'; gameId: string }
  /** Opens an empty lobby for a new cycle. */
  | { type: 'open'; gameId: string | null; scheduled: boolean }
  /** Stops accepting players. Driven by the cycle, not by a countdown. */
  | { type: 'close' }
  | { type: 'reset' };

export type LobbyRejection =
  'lobby-full' | 'already-joined' | 'not-joined' | 'lobby-launching' | 'lobby-closed';

export interface LobbyTransition {
  state: LobbyState;
  changed: boolean;
  /** Set when the event was refused; `state` is then unchanged. */
  rejected: LobbyRejection | null;
  /** Emitted when the lobby is ready to be turned into a real game. */
  shouldLaunch: boolean;
}

export function emptyLobby(tierId: string): LobbyState {
  return {
    tierId,
    status: 'waiting',
    players: [],
    countdownEndsAt: null,
    gameId: null,
    scheduled: false,
    version: 0,
  };
}

function unchanged(state: LobbyState, rejected: LobbyRejection | null = null): LobbyTransition {
  return { state, changed: false, rejected, shouldLaunch: false };
}

/**
 * Applies an event.
 *
 * `now` is injected rather than read from the clock so countdown behaviour can
 * be tested deterministically — a timer-driven test is a flaky test.
 */
export function reduceLobby(
  state: LobbyState,
  event: LobbyEvent,
  tier: RoomTier,
  now: number,
): LobbyTransition {
  switch (event.type) {
    case 'join': {
      if (state.status === 'launching') return unchanged(state, 'lobby-launching');
      if (state.status === 'closed') return unchanged(state, 'lobby-closed');
      if (state.players.some((p) => p.playerId === event.player.playerId)) {
        return unchanged(state, 'already-joined');
      }
      if (isAtCapacity(state.players.length, tier)) return unchanged(state, 'lobby-full');

      const players = [...state.players, { ...event.player, joinedAt: now, ready: false }];

      return settle({ ...state, players, version: state.version + 1 }, tier, now, true);
    }

    case 'leave': {
      if (!state.players.some((p) => p.playerId === event.playerId)) {
        return unchanged(state, 'not-joined');
      }
      // Leaving a launching lobby is too late — the entry fee is escrowed and
      // the game is being created. Refunds go through the on-chain cancel path.
      if (state.status === 'launching') return unchanged(state, 'lobby-launching');

      const players = state.players.filter((p) => p.playerId !== event.playerId);
      return settle({ ...state, players, version: state.version + 1 }, tier, now, true);
    }

    case 'ready': {
      const index = state.players.findIndex((p) => p.playerId === event.playerId);
      if (index === -1) return unchanged(state, 'not-joined');
      if (state.status === 'launching') return unchanged(state, 'lobby-launching');

      const existing = state.players[index];
      if (!existing || existing.ready === event.ready) return unchanged(state);

      const players = [...state.players];
      players[index] = { ...existing, ready: event.ready };

      return settle({ ...state, players, version: state.version + 1 }, tier, now, true);
    }

    case 'tick':
      return settle(state, tier, now, false);

    /**
     * Opens the lobby for the next game, **keeping anyone already queued**.
     *
     * This used to reset to an empty lobby, which quietly threw away the queue
     * every ten minutes. A player who joined a room that fell short of its
     * minimum was dropped at the next cycle without being told, while their
     * entry-fee reservation — keyed by tier, not by game — stayed put. They
     * were paying to sit in a queue they were no longer in.
     *
     * Carrying the roster over is also what a player expects: "I am queued for
     * the next match" should survive the match that never happened. Leaving is
     * explicit, and releases the stake.
     */
    case 'open': {
      const base = state.players.length > 0 ? state : emptyLobby(state.tierId);

      return {
        state: {
          ...base,
          status: 'waiting',
          countdownEndsAt: null,
          gameId: event.gameId,
          scheduled: event.scheduled,
          version: state.version + 1,
        },
        changed: true,
        rejected: null,
        shouldLaunch: false,
      };
    }

    case 'close':
      if (state.status === 'launching') return unchanged(state);
      return {
        state: {
          ...state,
          status: 'launching',
          countdownEndsAt: null,
          version: state.version + 1,
        },
        changed: true,
        rejected: null,
        shouldLaunch: false,
      };

    case 'launched':
      return {
        state: {
          ...state,
          status: 'launching',
          gameId: event.gameId,
          countdownEndsAt: null,
          version: state.version + 1,
        },
        changed: true,
        rejected: null,
        shouldLaunch: false,
      };

    case 'reset':
      return {
        state: { ...emptyLobby(state.tierId), version: state.version + 1 },
        changed: true,
        rejected: null,
        shouldLaunch: false,
      };

    default:
      return unchanged(state);
  }
}

/**
 * Recomputes status from the player set.
 *
 * All the auto-start rules live here so every event path applies them
 * identically — a `join` that fills the lobby and a `ready` that completes the
 * set must reach exactly the same conclusion.
 *
 * `mutated` says whether the caller already changed the player set; it is
 * OR-ed into the returned `changed` so a `tick` that does nothing reports no
 * change and the storage layer can skip the write.
 */
function settle(state: LobbyState, tier: RoomTier, now: number, mutated: boolean): LobbyTransition {
  // In scheduled mode the cycle owns every transition, so the auto-start rules
  // below are skipped entirely — the lobby simply accumulates players until
  // `close-lobby` fires.
  if (state.scheduled) {
    return { state, changed: mutated, rejected: null, shouldLaunch: false };
  }

  const count = state.players.length;

  // Not enough players: any running countdown is cancelled. Without this, a
  // lobby that briefly touched the minimum would go on to launch short-handed.
  if (count < tier.minPlayers) {
    const statusChanged = state.status !== 'waiting' || state.countdownEndsAt !== null;
    return {
      state: statusChanged ? { ...state, status: 'waiting', countdownEndsAt: null } : state,
      changed: mutated || statusChanged,
      rejected: null,
      shouldLaunch: false,
    };
  }

  const everyoneReady = state.players.every((player) => player.ready);
  const atCapacity = isAtCapacity(count, tier);

  // A full lobby, or one where everyone has readied, uses the short timer —
  // nobody benefits from waiting out the full countdown when no one else can
  // join and everyone present is waiting.
  const seconds = everyoneReady || atCapacity ? tier.readyCountdownSeconds : tier.countdownSeconds;
  const candidateDeadline = now + seconds * 1_000;

  if (state.status === 'waiting') {
    return {
      state: { ...state, status: 'countdown', countdownEndsAt: candidateDeadline },
      changed: true,
      rejected: null,
      shouldLaunch: false,
    };
  }

  if (state.status === 'countdown' && state.countdownEndsAt !== null) {
    if (now >= state.countdownEndsAt) {
      return {
        state: { ...state, status: 'launching', countdownEndsAt: null },
        changed: true,
        rejected: null,
        shouldLaunch: true,
      };
    }

    // The deadline only ever moves closer. Allowing it to move outwards would
    // let a player postpone a launch indefinitely by toggling ready off and on.
    if (candidateDeadline < state.countdownEndsAt) {
      return {
        state: { ...state, countdownEndsAt: candidateDeadline },
        changed: true,
        rejected: null,
        shouldLaunch: false,
      };
    }
  }

  return { state, changed: mutated, rejected: null, shouldLaunch: false };
}

/** Seconds remaining, floored at zero. Null when no countdown is running. */
export function countdownRemaining(state: LobbyState, now: number): number | null {
  if (state.status !== 'countdown' || state.countdownEndsAt === null) return null;
  return Math.max(0, Math.ceil((state.countdownEndsAt - now) / 1_000));
}

export function readyCount(state: LobbyState): number {
  return state.players.filter((player) => player.ready).length;
}

export function isJoinable(state: LobbyState, tier: RoomTier): boolean {
  return (
    (state.status === 'waiting' || state.status === 'countdown') &&
    !isAtCapacity(state.players.length, tier)
  );
}

/**
 * Whether the room can take another player.
 *
 * `maxPlayers` of `null` means no limit, and every tier is currently `null` —
 * nobody is turned away from a room they want to play. Kept as a function
 * rather than inlining `count >= max` at each site because the null case has to
 * be handled identically in all three, and a missed one would either reject a
 * player from an unlimited room or start the short countdown immediately.
 */
export function isAtCapacity(count: number, tier: RoomTier): boolean {
  return tier.maxPlayers !== null && count >= tier.maxPlayers;
}
