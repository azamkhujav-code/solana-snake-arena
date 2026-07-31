import { describe, expect, it } from 'vitest';

import {
  BPS_DENOMINATOR,
  computePayouts,
  MAX_WINNERS_PER_TX,
  WINNER_SHARE_BPS,
  splitPot,
  tableFor,
  totalPayout,
  withinTransactionLimit,
} from './payout.js';
import { detectWinner, verifyResult, type MatchResultReport } from './verify.js';

const SOL = 1_000_000_000n;

const standing = (playerId: string, placement: number) => ({
  playerId,
  placement,
  score: 100 * (10 - placement),
  kills: 10 - placement,
  survivedMs: 60_000,
});

const report = (over: Partial<MatchResultReport> = {}): MatchResultReport => ({
  gameId: 'game-1',
  roomId: 'room-1',
  nodeId: 'realtime-1',
  standings: [standing('a', 1), standing('b', 2), standing('c', 3)],
  endedAtMs: 1_700_000_000_000,
  ...over,
});

const context = { gameId: 'game-1', entrants: ['a', 'b', 'c'] };

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

describe('verifyResult', () => {
  it('accepts a well-formed report', () => {
    const result = verifyResult(report(), context);
    expect(result.ok).toBe(true);
    expect(result.standings.map((s) => s.playerId)).toEqual(['a', 'b', 'c']);
  });

  it('sorts standings by placement', () => {
    const result = verifyResult(
      report({ standings: [standing('c', 3), standing('a', 1), standing('b', 2)] }),
      context,
    );
    expect(result.standings.map((s) => s.placement)).toEqual([1, 2, 3]);
  });

  it('rejects a player who never entered', () => {
    // Paying someone who never staked is the worst possible failure here.
    const result = verifyResult(
      report({ standings: [standing('a', 1), standing('b', 2), standing('intruder', 3)] }),
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('unknown-player');
  });

  it('rejects a report missing an entrant', () => {
    // A missing entrant would silently forfeit their stake into the remainder.
    const result = verifyResult(
      report({ standings: [standing('a', 1), standing('b', 2)] }),
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('missing-player');
  });

  it('rejects a duplicated player', () => {
    const result = verifyResult(
      report({ standings: [standing('a', 1), standing('a', 2), standing('b', 3)] }),
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('duplicate-player');
  });

  it('rejects placements with a gap', () => {
    // An ambiguous placement table means someone gets paid twice.
    const result = verifyResult(
      report({ standings: [standing('a', 1), standing('b', 2), standing('c', 5)] }),
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('invalid-placement');
  });

  it('rejects duplicate placements', () => {
    const result = verifyResult(
      report({ standings: [standing('a', 1), standing('b', 1), standing('c', 2)] }),
      context,
    );
    expect(result.failures).toContain('invalid-placement');
  });

  it('rejects negative or non-finite metrics', () => {
    const bad = { ...standing('c', 3), score: -50 };
    const result = verifyResult(
      report({ standings: [standing('a', 1), standing('b', 2), bad] }),
      context,
    );
    expect(result.failures).toContain('negative-metric');

    const nan = { ...standing('c', 3), kills: Number.NaN };
    expect(
      verifyResult(report({ standings: [standing('a', 1), standing('b', 2), nan] }), context)
        .failures,
    ).toContain('negative-metric');
  });

  it('rejects a report for a different game', () => {
    const result = verifyResult(report({ gameId: 'other' }), context);
    expect(result.failures).toContain('wrong-game');
  });

  it('rejects a report from a node that never hosted the game', () => {
    const result = verifyResult(report({ nodeId: 'impostor' }), {
      ...context,
      expectedNodeId: 'realtime-1',
    });
    expect(result.failures).toContain('wrong-node');
  });

  it('rejects an empty report', () => {
    const result = verifyResult(report({ standings: [] }), context);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['no-standings']);
  });

  it('collects every failure rather than stopping at the first', () => {
    // An operator investigating a rejected settlement should see the whole
    // picture, not peel problems off one at a time.
    const result = verifyResult(
      report({ gameId: 'other', standings: [standing('intruder', 4)] }),
      context,
    );
    expect(result.failures.length).toBeGreaterThan(1);
  });

  it('returns no standings when verification failed', () => {
    // Downstream must not be able to accidentally settle a rejected report.
    expect(verifyResult(report({ gameId: 'other' }), context).standings).toEqual([]);
  });
});

describe('detectWinner', () => {
  it('finds first place', () => {
    expect(detectWinner(verifyResult(report(), context))?.playerId).toBe('a');
  });

  it('is null when the result did not verify', () => {
    expect(detectWinner(verifyResult(report({ gameId: 'x' }), context))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

describe('payout table', () => {
  it('gives the whole pool to one winner', () => {
    // Last snake standing takes everything. This replaced a tiered table that
    // paid the top three to seven; a survivor who received 40% would have been
    // told one thing and paid another.
    expect(WINNER_SHARE_BPS).toBe(Number(BPS_DENOMINATOR));
  });

  it('pays exactly one player regardless of field size', () => {
    for (const players of [2, 4, 8, 20, 120]) {
      expect(tableFor(players)).toEqual([WINNER_SHARE_BPS]);
    }
  });

  it('stays within the on-chain per-transaction winner cap', () => {
    expect(tableFor(120).length).toBeLessThanOrEqual(MAX_WINNERS_PER_TX);
  });
});

describe('computePayouts', () => {
  const three = [standing('a', 1), standing('b', 2), standing('c', 3)];

  it('pays the whole pool to placement 1', () => {
    const payouts = computePayouts(three, 100n * SOL);

    expect(payouts.map((p) => p.playerId)).toEqual(['a']);
    expect(payouts[0]?.lamports).toBe(100n * SOL);
  });

  it('pays the last survivor, not the highest scorer', () => {
    // Placement comes from `Room.buildResult`, which ranks by elimination
    // order. Whoever is placement 1 survived longest, and the pot follows
    // survival — the two are frequently different players.
    const payouts = computePayouts(
      [standing('died-first', 3), standing('survivor', 1), standing('died-second', 2)],
      10n * SOL,
    );

    expect(payouts).toHaveLength(1);
    expect(payouts[0]?.playerId).toBe('survivor');
  });

  it('always sums to exactly the prize pool', () => {
    // This is the on-chain invariant. Anything else and distribute_winnings
    // rejects the whole payout.
    for (const pool of [1n, 7n, 999n, 12_345_678_901n, 100n * SOL, 3n * SOL + 1n]) {
      const payouts = computePayouts(three, pool);
      expect(totalPayout(payouts)).toBe(pool);
    }
  });

  it('leaves no remainder to lose', () => {
    // With a single payee the whole pool goes to one place, so odd lamports
    // cannot be stranded — the sum check the chain enforces is trivially met.
    for (const pool of [1n, 7n, 999n, 10n]) {
      const payouts = computePayouts(three, pool);
      expect(payouts[0]?.lamports).toBe(pool);
      expect(totalPayout(payouts)).toBe(pool);
    }
  });

  it('pays only the winner in a two-player match', () => {
    const payouts = computePayouts([standing('a', 1), standing('b', 2)], 50n * SOL);

    expect(payouts).toHaveLength(1);
    expect(payouts[0]?.lamports).toBe(50n * SOL);
  });

  it('pays one player out of a large field', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => standing(`p${i}`, i + 1));
    const payouts = computePayouts(twenty, 100n * SOL);

    expect(payouts).toHaveLength(1);
    expect(payouts[0]?.playerId).toBe('p0');
    expect(totalPayout(payouts)).toBe(100n * SOL);
  });

  it('drops shares that round to zero', () => {
    // A zero payout is rejected on-chain; those lamports are already folded
    // into first place via the remainder.
    const twenty = Array.from({ length: 20 }, (_, i) => standing(`p${i}`, i + 1));
    const payouts = computePayouts(twenty, 3n);

    expect(payouts.every((p) => p.lamports > 0n)).toBe(true);
    expect(totalPayout(payouts)).toBe(3n);
  });

  it('returns nothing for an empty pool or empty standings', () => {
    expect(computePayouts(three, 0n)).toEqual([]);
    expect(computePayouts([], 100n * SOL)).toEqual([]);
  });

  it('sorts by placement regardless of input order', () => {
    const shuffled = [standing('c', 3), standing('a', 1), standing('b', 2)];
    expect(computePayouts(shuffled, 100n * SOL)[0]?.playerId).toBe('a');
  });

  it('stays within the transaction winner limit', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => standing(`p${i}`, i + 1));
    expect(withinTransactionLimit(computePayouts(twenty, 100n * SOL))).toBe(true);
  });

  it('stays exact at pot sizes past Number.MAX_SAFE_INTEGER', () => {
    const huge = 10_000_000n * SOL;
    expect(totalPayout(computePayouts(three, huge))).toBe(huge);
  });
});

describe('splitPot', () => {
  it('takes the rake before the prize', () => {
    const { prizePool, rake } = splitPot(100n * SOL, 500); // 5%
    expect(rake).toBe(5n * SOL);
    expect(prizePool).toBe(95n * SOL);
  });

  it('always reconstructs the pot exactly', () => {
    for (const pot of [1n, 3n, 999n, 7n * SOL + 13n]) {
      const { prizePool, rake } = splitPot(pot, 500);
      expect(prizePool + rake).toBe(pot);
    }
  });

  it('is a no-op at zero rake', () => {
    const { prizePool, rake } = splitPot(100n * SOL, 0);
    expect(rake).toBe(0n);
    expect(prizePool).toBe(100n * SOL);
  });

  it('rounds the rake down, favouring the players', () => {
    // 5% of 9 lamports is 0.45; the house gets 0, not 1.
    expect(splitPot(9n, 500).rake).toBe(0n);
  });
});
