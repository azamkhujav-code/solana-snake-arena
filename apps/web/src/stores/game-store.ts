import type { LeaderboardEntry, MatchTicket, PlayerDied } from '@arena/protocol';
import { create } from 'zustand';

import { pushKillFeed, type KillFeedEntry } from '@/lib/hud-state';

export type ConnectionStatus =
  'idle' | 'matchmaking' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface GameState {
  status: ConnectionStatus;
  roomId: string | null;
  playerId: string | null;
  /**
   * The handshake credential for the match being joined.
   *
   * Held here rather than in the mutation that minted it because the mint and
   * the use happen on different pages: the lobby requests it the moment its
   * room starts, and `/play` consumes it after the navigation. A mutation's
   * result does not survive that.
   *
   * Single-use and valid for thirty seconds, so it is cleared once spent.
   */
  ticket: MatchTicket | null;
  /**
   * The tier this match was entered from.
   *
   * Kept because the prize is the tier's entry fee times the number who paid,
   * and after launch the queue is cleared — so by the time the match ends there
   * is nothing else left on the client that remembers which room it was.
   */
  tierId: string | null;

  /* HUD values. Updated a few times per second, never per frame. */
  score: number;
  mass: number;
  rank: number | null;
  kills: number;
  alive: boolean;
  spectating: boolean;
  /** Milliseconds since the match started, from the server clock. */
  elapsedMs: number;
  leaderboard: LeaderboardEntry[];
  killFeed: KillFeedEntry[];

  /* Minimap. */
  selfPosition: { x: number; y: number } | null;
  otherPositions: Array<{ x: number; y: number }>;
  worldRadius: number;

  /* Diagnostics. */
  fps: number;
  rttMs: number;
  packetLoss: number;

  setStatus: (status: ConnectionStatus) => void;
  setRoom: (roomId: string | null, playerId: string | null) => void;
  setTicket: (ticket: MatchTicket | null, tierId?: string | null) => void;
  /**
   * Clears gameplay state but keeps the ticket.
   *
   * For starting a match. `reset` wipes everything including the ticket, which
   * is right when leaving and wrong when arriving: the canvas called it on
   * mount to clear the previous match's score, and in doing so threw away the
   * credential it had just been handed. The page then saw no ticket, minted a
   * second one, and invalidated the first — tickets are single-use, so the
   * connection was racing a credential that had already been replaced.
   */
  resetForMatch: () => void;
  setHud: (payload: Partial<Omit<GameState, 'setHud'>>) => void;
  setLeaderboard: (entries: LeaderboardEntry[]) => void;
  recordDeath: (
    event: PlayerDied,
    selfPlayerId: string | null,
    nicknames: Map<string, string>,
  ) => void;
  setNetworkStats: (payload: { rttMs: number; packetLoss: number }) => void;
  reset: () => void;
}

const INITIAL = {
  status: 'idle' as ConnectionStatus,
  roomId: null,
  playerId: null,
  ticket: null as MatchTicket | null,
  tierId: null as string | null,
  score: 0,
  mass: 0,
  rank: null,
  kills: 0,
  alive: false,
  spectating: false,
  elapsedMs: 0,
  leaderboard: [] as LeaderboardEntry[],
  killFeed: [] as KillFeedEntry[],
  selfPosition: null,
  otherPositions: [] as Array<{ x: number; y: number }>,
  worldRadius: 8_000,
  fps: 0,
  rttMs: 0,
  packetLoss: 0,
};

/**
 * UI-facing game state only.
 *
 * Entity positions for *rendering* deliberately do not live here — the renderer
 * reads them straight from the network buffer at 60 fps, and pushing those
 * through Zustand would re-render React every frame and cost more than the
 * rendering itself. The coarse positions below are for the minimap, which
 * updates a few times a second.
 */
export const useGameStore = create<GameState>()((set) => ({
  ...INITIAL,

  setStatus: (status) => set({ status }),
  setRoom: (roomId, playerId) => set({ roomId, playerId }),
  setTicket: (ticket, tierId = null) =>
    set({ ticket, tierId, status: ticket ? 'connecting' : 'idle' }),
  setHud: (payload) => set(payload),
  setLeaderboard: (leaderboard) => set({ leaderboard }),

  /**
   * Records a broadcast death.
   *
   * Kills are counted here rather than read from the leaderboard because the
   * leaderboard only carries the top ten — a player outside it would have no
   * source for their own count.
   */
  recordDeath: (event, selfPlayerId, nicknames) =>
    set((state) => {
      const victim = nicknames.get(event.playerId) ?? 'Someone';
      const killer = event.killedBy ? (nicknames.get(event.killedBy) ?? 'Someone') : null;
      const involvesSelf = event.playerId === selfPlayerId || event.killedBy === selfPlayerId;

      const text = killer
        ? `${killer} eliminated ${victim}`
        : `${victim} ${event.reason === 'wall' ? 'hit the wall' : 'died'}`;

      return {
        kills: event.killedBy === selfPlayerId ? state.kills + 1 : state.kills,
        killFeed: pushKillFeed(state.killFeed, {
          id: `${event.playerId}:${event.survivedMs}`,
          text,
          isSelf: involvesSelf,
          atMs: Date.now(),
        }),
      };
    }),

  setNetworkStats: ({ rttMs, packetLoss }) => set({ rttMs, packetLoss }),

  // Kills and the feed reset with the match, not with a respawn — they are
  // per-session stats, and clearing them on every death would erase the run.
  reset: () => set({ ...INITIAL }),
  resetForMatch: () => set((state) => ({ ...INITIAL, ticket: state.ticket, tierId: state.tierId })),
}));
