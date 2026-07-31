import type { LeaderboardEntry } from '@arena/protocol';

/**
 * HUD derivations.
 *
 * Pure and separate from the components: formatting a clock, deciding when a
 * ping is "bad", and injecting the player into a leaderboard they are not on
 * are all easy to get subtly wrong and impossible to notice by looking at a
 * screenshot.
 */

/** `m:ss`, or `h:mm:ss` past an hour. Counts up from match start. */
export function formatMatchTime(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);

  const pad = (value: number) => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Thousands separators for score readability. */
export function formatScore(score: number): string {
  return Math.max(0, Math.floor(score)).toLocaleString('en-US');
}

export type Quality = 'good' | 'fair' | 'poor';

/**
 * Ping banding.
 *
 * Thresholds chosen against the 100 ms interpolation delay: below that the
 * connection is invisible to the player, and beyond roughly twice it their own
 * corrections start to show.
 */
export function pingQuality(rttMs: number): Quality {
  if (rttMs <= 80) return 'good';
  if (rttMs <= 180) return 'fair';
  return 'poor';
}

/**
 * FPS banding against the 30 Hz snapshot rate.
 *
 * Below 30 the client is rendering fewer frames than it receives snapshots, so
 * interpolation stops buying anything.
 */
export function fpsQuality(fps: number): Quality {
  if (fps >= 50) return 'good';
  if (fps >= 30) return 'fair';
  return 'poor';
}

export interface LeaderboardRow extends LeaderboardEntry {
  isSelf: boolean;
  /** True for a row appended because the player is off the visible board. */
  detached: boolean;
}

/**
 * Builds the rows to render.
 *
 * If the player is outside the top N, their own rank is appended as a detached
 * row. A leaderboard that simply omits you is the most common complaint about
 * this kind of HUD — you cannot tell whether you are 11th or 400th.
 */
export function buildLeaderboardRows(
  entries: readonly LeaderboardEntry[],
  selfPlayerId: string | null,
  limit = 10,
): LeaderboardRow[] {
  const ranked = [...entries].sort((a, b) => a.rank - b.rank);
  const visible = ranked.slice(0, limit);

  const rows: LeaderboardRow[] = visible.map((entry) => ({
    ...entry,
    isSelf: entry.playerId === selfPlayerId,
    detached: false,
  }));

  if (!selfPlayerId) return rows;
  if (rows.some((row) => row.isSelf)) return rows;

  const self = ranked.find((entry) => entry.playerId === selfPlayerId);
  if (!self) return rows;

  rows.push({ ...self, isSelf: true, detached: true });
  return rows;
}

/** The player's own rank, or null when they are not on the board at all. */
export function selfRank(
  entries: readonly LeaderboardEntry[],
  selfPlayerId: string | null,
): number | null {
  if (!selfPlayerId) return null;
  return entries.find((entry) => entry.playerId === selfPlayerId)?.rank ?? null;
}

/**
 * Counts kills from the death feed.
 *
 * Derived on the client from broadcast deaths rather than read off a counter,
 * because the leaderboard only carries the top N — a player outside it would
 * otherwise have no source for their own kill count.
 */
export function countKills(
  deaths: ReadonlyArray<{ killedBy: string | null }>,
  selfPlayerId: string | null,
): number {
  if (!selfPlayerId) return 0;
  return deaths.reduce((total, death) => (death.killedBy === selfPlayerId ? total + 1 : total), 0);
}

/** Cap on the kill feed, so a busy room does not grow it without bound. */
export const KILL_FEED_LIMIT = 5;

export interface KillFeedEntry {
  id: string;
  text: string;
  isSelf: boolean;
  atMs: number;
}

/** Newest first, capped, with self-involved entries highlighted. */
export function pushKillFeed(
  feed: readonly KillFeedEntry[],
  entry: KillFeedEntry,
  limit = KILL_FEED_LIMIT,
): KillFeedEntry[] {
  return [entry, ...feed].slice(0, limit);
}
