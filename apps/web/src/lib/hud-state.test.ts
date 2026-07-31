import type { LeaderboardEntry } from '@arena/protocol';
import { describe, expect, it } from 'vitest';

import {
  buildLeaderboardRows,
  countKills,
  formatMatchTime,
  formatScore,
  fpsQuality,
  pingQuality,
  pushKillFeed,
  selfRank,
} from './hud-state';

const entry = (rank: number, playerId: string, score = 100, kills = 0): LeaderboardEntry => ({
  playerId,
  nickname: playerId,
  score,
  kills,
  rank,
});

describe('formatMatchTime', () => {
  it('formats under a minute', () => {
    expect(formatMatchTime(0)).toBe('0:00');
    expect(formatMatchTime(7_000)).toBe('0:07');
  });

  it('pads seconds', () => {
    expect(formatMatchTime(65_000)).toBe('1:05');
  });

  it('rolls into hours only when needed', () => {
    expect(formatMatchTime(59 * 60_000 + 59_000)).toBe('59:59');
    expect(formatMatchTime(3_600_000)).toBe('1:00:00');
    expect(formatMatchTime(3_661_000)).toBe('1:01:01');
  });

  it('floors partial seconds rather than rounding up', () => {
    // Rounding up would show 0:01 before a second has passed.
    expect(formatMatchTime(999)).toBe('0:00');
  });

  it('clamps a negative elapsed to zero', () => {
    expect(formatMatchTime(-5_000)).toBe('0:00');
  });
});

describe('formatScore', () => {
  it('groups thousands', () => {
    expect(formatScore(1_234_567)).toBe('1,234,567');
  });

  it('floors and clamps', () => {
    expect(formatScore(99.9)).toBe('99');
    expect(formatScore(-10)).toBe('0');
  });
});

describe('quality banding', () => {
  it('bands ping against the interpolation delay', () => {
    expect(pingQuality(20)).toBe('good');
    expect(pingQuality(120)).toBe('fair');
    expect(pingQuality(400)).toBe('poor');
  });

  it('bands fps against the snapshot rate', () => {
    expect(fpsQuality(60)).toBe('good');
    expect(fpsQuality(35)).toBe('fair');
    // Below 30 the client renders fewer frames than it receives snapshots.
    expect(fpsQuality(18)).toBe('poor');
  });

  it('treats the boundaries as inclusive of the better band', () => {
    expect(pingQuality(80)).toBe('good');
    expect(fpsQuality(50)).toBe('good');
    expect(fpsQuality(30)).toBe('fair');
  });
});

describe('buildLeaderboardRows', () => {
  const board = [entry(1, 'a'), entry(2, 'b'), entry(3, 'me'), entry(4, 'd')];

  it('sorts by rank and truncates', () => {
    const rows = buildLeaderboardRows(board, null, 2);
    expect(rows.map((row) => row.playerId)).toEqual(['a', 'b']);
  });

  it('marks the player own row', () => {
    const rows = buildLeaderboardRows(board, 'me');
    expect(rows.find((row) => row.playerId === 'me')?.isSelf).toBe(true);
  });

  it('appends the player when they are off the visible board', () => {
    // A leaderboard that just omits you leaves you unable to tell whether you
    // are 11th or 400th.
    const rows = buildLeaderboardRows(board, 'd', 2);

    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ playerId: 'd', isSelf: true, detached: true });
  });

  it('does not append when the player is already visible', () => {
    const rows = buildLeaderboardRows(board, 'a', 2);
    expect(rows.filter((row) => row.isSelf)).toHaveLength(1);
    expect(rows.every((row) => !row.detached)).toBe(true);
  });

  it('appends nothing when the player is not ranked at all', () => {
    const rows = buildLeaderboardRows(board, 'ghost', 2);
    expect(rows).toHaveLength(2);
  });

  it('handles an empty board', () => {
    expect(buildLeaderboardRows([], 'me')).toEqual([]);
  });

  it('does not mutate the input', () => {
    const input = [entry(3, 'c'), entry(1, 'a')];
    buildLeaderboardRows(input, null);
    expect(input.map((e) => e.playerId)).toEqual(['c', 'a']);
  });
});

describe('selfRank', () => {
  it('finds the rank', () => {
    expect(selfRank([entry(1, 'a'), entry(7, 'me')], 'me')).toBe(7);
  });

  it('is null when unranked or signed out', () => {
    expect(selfRank([entry(1, 'a')], 'me')).toBeNull();
    expect(selfRank([entry(1, 'a')], null)).toBeNull();
  });
});

describe('countKills', () => {
  it('counts only deaths this player caused', () => {
    const deaths = [
      { killedBy: 'me' },
      { killedBy: 'other' },
      { killedBy: 'me' },
      { killedBy: null },
    ];
    expect(countKills(deaths, 'me')).toBe(2);
  });

  it('ignores wall deaths, which have no killer', () => {
    expect(countKills([{ killedBy: null }, { killedBy: null }], 'me')).toBe(0);
  });

  it('is zero when signed out', () => {
    expect(countKills([{ killedBy: 'me' }], null)).toBe(0);
  });
});

describe('pushKillFeed', () => {
  const make = (id: string) => ({ id, text: id, isSelf: false, atMs: 0 });

  it('puts the newest entry first', () => {
    const feed = pushKillFeed([make('a')], make('b'));
    expect(feed.map((f) => f.id)).toEqual(['b', 'a']);
  });

  it('caps the feed by evicting the oldest entry', () => {
    // The feed is newest-first, so `oldest` sits at the end and is what gets
    // dropped — naming these by position rather than by number, because
    // ordinal ids invite exactly the wrong mental model here.
    const feed = pushKillFeed(
      [make('newest'), make('n2'), make('n3'), make('n4'), make('oldest')],
      make('incoming'),
    );

    expect(feed).toHaveLength(5);
    expect(feed[0]?.id).toBe('incoming');
    expect(feed.map((f) => f.id)).not.toContain('oldest');
    expect(feed.map((f) => f.id)).toContain('newest');
  });

  it('does not mutate the input', () => {
    const original = [make('a')];
    pushKillFeed(original, make('b'));
    expect(original).toHaveLength(1);
  });
});
