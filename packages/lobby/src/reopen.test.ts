import { describe, expect, it } from 'vitest';

import { reduceLobby, type LobbyState } from './state.js';
import { requireTier } from './tiers.js';

/**
 * What happens to a queue when its match does not start.
 *
 * The ten-minute cycle opens a lobby, lets players accumulate, and closes it to
 * launch. When too few players showed up, the launch aborts — and the lobby had
 * *already* been closed, so it stayed shut until the next cycle reopened it.
 * That left roughly five minutes per cycle where the board advertised "In
 * progress" for a match that never ran, and nobody could join to make it run.
 *
 * The deadlock is the point: a room cannot reach its minimum while it is
 * refusing players, and it refuses players because it did not reach its
 * minimum.
 *
 * Reopening fixes that, but only if it does not silently empty the queue —
 * hence the second half of these tests. A player who joined a room that fell
 * short should still be queued for the next attempt, because their entry-fee
 * reservation is keyed by tier and outlives the game they joined for. Dropping
 * them from the lobby while keeping their money reserved is the worst of both.
 */

const TIER = 'gold';
const tier = requireTier(TIER);
const T0 = 1_700_000_000_000;

const player = (id: string) => ({
  playerId: id,
  nickname: id,
  wallet: `wallet-${id}`,
  ready: false,
});

function open(state: LobbyState, gameId: string): LobbyState {
  return reduceLobby(state, { type: 'open', gameId, scheduled: true }, tier, T0).state;
}

function join(state: LobbyState, id: string): LobbyState {
  return reduceLobby(state, { type: 'join', player: player(id) }, tier, T0).state;
}

function empty(): LobbyState {
  return reduceLobby(
    { tierId: TIER, status: 'closed', players: [], countdownEndsAt: null, gameId: null, scheduled: true, version: 0 },
    { type: 'open', gameId: 'game-0', scheduled: true },
    tier,
    T0,
  ).state;
}

describe('reopening a lobby between cycles', () => {
  it('carries queued players into the next game', () => {
    // The regression. A player who waited through a cycle that fell short must
    // still be queued, not silently dropped while their stake stays reserved.
    let state = empty();
    state = join(state, 'alice');
    expect(state.players).toHaveLength(1);

    state = open(state, 'game-1');

    expect(state.players.map((p) => p.playerId)).toEqual(['alice']);
    expect(state.gameId).toBe('game-1');
  });

  it('reopens to a joinable state', () => {
    let state = empty();
    state = join(state, 'alice');
    state = reduceLobby(state, { type: 'close' }, tier, T0).state;
    expect(state.status).not.toBe('waiting');

    state = open(state, 'game-1');

    expect(state.status).toBe('waiting');
    expect(state.countdownEndsAt).toBeNull();
  });

  it('starts empty when nobody was queued', () => {
    // No roster to preserve, so this is the ordinary fresh-cycle case.
    const state = open(empty(), 'game-2');

    expect(state.players).toHaveLength(0);
    expect(state.gameId).toBe('game-2');
  });

  it('lets a carried-over player be joined by someone new', () => {
    // The whole point: the room can now reach its minimum across cycles rather
    // than resetting to zero every ten minutes.
    let state = empty();
    state = join(state, 'alice');
    state = open(state, 'game-1');
    state = join(state, 'bob');

    expect(state.players).toHaveLength(2);
    expect(state.players.length).toBeGreaterThanOrEqual(tier.minPlayers);
  });

  it('still lets a carried-over player leave', () => {
    // Leaving must stay explicit — that is what releases the entry fee.
    let state = empty();
    state = join(state, 'alice');
    state = open(state, 'game-1');
    state = reduceLobby(state, { type: 'leave', playerId: 'alice' }, tier, T0).state;

    expect(state.players).toHaveLength(0);
  });
});
