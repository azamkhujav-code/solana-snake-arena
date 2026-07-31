import { describe, expect, it } from 'vitest';

import {
  countdownRemaining,
  emptyLobby,
  isJoinable,
  readyCount,
  reduceLobby,
  type LobbyEvent,
  type LobbyState,
} from './state.js';
import { ROOM_TIERS } from './tiers.js';

const tier = {
  id: 'test',
  name: 'Test',
  entryFeeLamports: 0n,
  minPlayers: 3,
  maxPlayers: 5,
  countdownSeconds: 30,
  readyCountdownSeconds: 5,
  description: '',
};

const T0 = 1_000_000;

const join = (id: string): LobbyEvent => ({
  type: 'join',
  player: { playerId: id, nickname: id, wallet: `wallet-${id}` },
});

/** Applies a sequence of events, threading state through. */
function run(start: LobbyState, events: Array<[LobbyEvent, number?]>): LobbyState {
  return events.reduce(
    (state, [event, at]) => reduceLobby(state, event, tier, at ?? T0).state,
    start,
  );
}

describe('join', () => {
  it('adds a player and leaves the lobby waiting below the minimum', () => {
    const result = reduceLobby(emptyLobby('test'), join('a'), tier, T0);

    expect(result.state.players).toHaveLength(1);
    expect(result.state.status).toBe('waiting');
    expect(result.state.countdownEndsAt).toBeNull();
    expect(result.rejected).toBeNull();
  });

  it('starts the countdown the moment the minimum is reached', () => {
    const state = run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]);

    expect(state.status).toBe('countdown');
    expect(state.countdownEndsAt).toBe(T0 + 30_000);
  });

  it('rejects a duplicate join', () => {
    const once = reduceLobby(emptyLobby('test'), join('a'), tier, T0);
    const twice = reduceLobby(once.state, join('a'), tier, T0);

    expect(twice.rejected).toBe('already-joined');
    expect(twice.state.players).toHaveLength(1);
  });

  it('rejects a join past capacity', () => {
    const full = run(
      emptyLobby('test'),
      ['a', 'b', 'c', 'd', 'e'].map((id) => [join(id)] as [LobbyEvent]),
    );
    expect(full.players).toHaveLength(5);

    const overflow = reduceLobby(full, join('f'), tier, T0);
    expect(overflow.rejected).toBe('lobby-full');
    expect(overflow.state.players).toHaveLength(5);
  });

  it('shortens the countdown when the lobby fills', () => {
    // Nobody else can join, so waiting out the long timer helps no one.
    const full = run(
      emptyLobby('test'),
      ['a', 'b', 'c', 'd', 'e'].map((id) => [join(id)] as [LobbyEvent]),
    );
    expect(full.countdownEndsAt).toBe(T0 + 5_000);
  });

  it('rejects a join once the lobby is launching', () => {
    const launching = reduceLobby(
      run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]),
      { type: 'launched', gameId: 'game-1' },
      tier,
      T0,
    ).state;

    expect(reduceLobby(launching, join('d'), tier, T0).rejected).toBe('lobby-launching');
  });
});

describe('leave', () => {
  it('removes the player', () => {
    const state = run(emptyLobby('test'), [[join('a')], [join('b')]]);
    const after = reduceLobby(state, { type: 'leave', playerId: 'a' }, tier, T0);

    expect(after.state.players.map((p) => p.playerId)).toEqual(['b']);
  });

  it('cancels the countdown when the lobby drops below the minimum', () => {
    // Without this, a lobby that briefly touched the minimum would launch
    // short-handed.
    const counting = run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]);
    expect(counting.status).toBe('countdown');

    const after = reduceLobby(counting, { type: 'leave', playerId: 'c' }, tier, T0);
    expect(after.state.status).toBe('waiting');
    expect(after.state.countdownEndsAt).toBeNull();
  });

  it('keeps the countdown running when still above the minimum', () => {
    const counting = run(
      emptyLobby('test'),
      ['a', 'b', 'c', 'd'].map((id) => [join(id)] as [LobbyEvent]),
    );
    const after = reduceLobby(counting, { type: 'leave', playerId: 'd' }, tier, T0);

    expect(after.state.status).toBe('countdown');
    expect(after.state.countdownEndsAt).toBe(T0 + 30_000);
  });

  it('rejects leaving a lobby the player is not in', () => {
    expect(
      reduceLobby(emptyLobby('test'), { type: 'leave', playerId: 'ghost' }, tier, T0).rejected,
    ).toBe('not-joined');
  });

  it('rejects leaving once launching, since the entry fee is escrowed', () => {
    const launching = reduceLobby(
      run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]),
      { type: 'launched', gameId: 'g' },
      tier,
      T0,
    ).state;

    expect(reduceLobby(launching, { type: 'leave', playerId: 'a' }, tier, T0).rejected).toBe(
      'lobby-launching',
    );
  });
});

describe('ready state', () => {
  it('tracks readiness per player', () => {
    const state = run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]);
    const after = reduceLobby(state, { type: 'ready', playerId: 'a', ready: true }, tier, T0);

    expect(readyCount(after.state)).toBe(1);
  });

  it('shortens the countdown once everyone is ready', () => {
    let state = run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]);
    expect(state.countdownEndsAt).toBe(T0 + 30_000);

    for (const id of ['a', 'b', 'c']) {
      state = reduceLobby(state, { type: 'ready', playerId: id, ready: true }, tier, T0).state;
    }

    expect(state.countdownEndsAt).toBe(T0 + 5_000);
  });

  it('does not push the deadline back out when a player un-readies', () => {
    // Otherwise a single player could postpone the launch forever by toggling.
    let state = run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]);
    for (const id of ['a', 'b', 'c']) {
      state = reduceLobby(state, { type: 'ready', playerId: id, ready: true }, tier, T0).state;
    }
    expect(state.countdownEndsAt).toBe(T0 + 5_000);

    const after = reduceLobby(state, { type: 'ready', playerId: 'a', ready: false }, tier, T0);
    expect(after.state.countdownEndsAt).toBe(T0 + 5_000);
  });

  it('ignores a no-op ready toggle', () => {
    const state = run(emptyLobby('test'), [[join('a')]]);
    const after = reduceLobby(state, { type: 'ready', playerId: 'a', ready: false }, tier, T0);

    expect(after.changed).toBe(false);
  });

  it('rejects readying a player who never joined', () => {
    expect(
      reduceLobby(emptyLobby('test'), { type: 'ready', playerId: 'x', ready: true }, tier, T0)
        .rejected,
    ).toBe('not-joined');
  });
});

describe('countdown and auto start', () => {
  it('does not launch before the deadline', () => {
    const state = run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]);
    const tick = reduceLobby(state, { type: 'tick' }, tier, T0 + 29_999);

    expect(tick.shouldLaunch).toBe(false);
    expect(tick.state.status).toBe('countdown');
  });

  it('launches exactly at the deadline', () => {
    const state = run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]);
    const tick = reduceLobby(state, { type: 'tick' }, tier, T0 + 30_000);

    expect(tick.shouldLaunch).toBe(true);
    expect(tick.state.status).toBe('launching');
    expect(tick.state.countdownEndsAt).toBeNull();
  });

  it('reports no change for a tick that does nothing', () => {
    // The storage layer skips the write when nothing changed, so this matters.
    const state = run(emptyLobby('test'), [[join('a')]]);
    expect(reduceLobby(state, { type: 'tick' }, tier, T0 + 1_000).changed).toBe(false);
  });

  it('starts a countdown on tick if the minimum was already met', () => {
    // Reachable when players were restored from storage without an event.
    const state: LobbyState = {
      ...emptyLobby('test'),
      players: ['a', 'b', 'c'].map((id) => ({
        playerId: id,
        nickname: id,
        wallet: id,
        joinedAt: T0,
        ready: false,
      })),
    };

    const tick = reduceLobby(state, { type: 'tick' }, tier, T0);
    expect(tick.state.status).toBe('countdown');
  });

  it('computes remaining seconds, floored at zero', () => {
    const state = run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]);

    expect(countdownRemaining(state, T0)).toBe(30);
    expect(countdownRemaining(state, T0 + 29_500)).toBe(1);
    expect(countdownRemaining(state, T0 + 60_000)).toBe(0);
    expect(countdownRemaining(emptyLobby('test'), T0)).toBeNull();
  });
});

describe('lifecycle', () => {
  it('records the game id on launch', () => {
    const state = run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]);
    const launched = reduceLobby(state, { type: 'launched', gameId: 'game-9' }, tier, T0);

    expect(launched.state.gameId).toBe('game-9');
    expect(launched.state.status).toBe('launching');
  });

  it('resets to an empty waiting lobby, keeping the version monotonic', () => {
    const state = run(emptyLobby('test'), [[join('a')], [join('b')], [join('c')]]);
    const reset = reduceLobby(state, { type: 'reset' }, tier, T0);

    expect(reset.state.players).toHaveLength(0);
    expect(reset.state.status).toBe('waiting');
    // A version that went backwards would let a stale writer win the CAS.
    expect(reset.state.version).toBeGreaterThan(state.version);
  });

  it('bumps the version on every mutating event', () => {
    const one = reduceLobby(emptyLobby('test'), join('a'), tier, T0);
    const two = reduceLobby(one.state, join('b'), tier, T0);

    expect(two.state.version).toBeGreaterThan(one.state.version);
  });
});

describe('isJoinable', () => {
  it('is true while waiting or counting down with space', () => {
    expect(isJoinable(emptyLobby('test'), tier)).toBe(true);
  });

  it('is false at capacity', () => {
    const full = run(
      emptyLobby('test'),
      ['a', 'b', 'c', 'd', 'e'].map((id) => [join(id)] as [LobbyEvent]),
    );
    expect(isJoinable(full, tier)).toBe(false);
  });
});

describe('room tiers', () => {
  it('defines exactly seven rooms', () => {
    expect(ROOM_TIERS).toHaveLength(7);
  });

  it('gives every room a distinct entry fee', () => {
    const fees = ROOM_TIERS.map((room) => room.entryFeeLamports.toString());
    expect(new Set(fees).size).toBe(7);
  });

  it('orders fees from free upwards', () => {
    const fees = ROOM_TIERS.map((room) => room.entryFeeLamports);
    expect(fees[0]).toBe(0n);
    for (let i = 1; i < fees.length; i += 1) {
      expect(fees[i]! > fees[i - 1]!).toBe(true);
    }
  });

  it('needs two players in every paid room and turns nobody away', () => {
    for (const room of ROOM_TIERS) {
      // Two is the whole rule where money is staked: a wagered match needs an
      // opponent and nothing more. The free room starts solo — see below.
      const expected = room.entryFeeLamports === 0n ? 1 : 2;
      expect(room.minPlayers).toBe(expected);
      expect(room.maxPlayers).toBeNull();
      expect(room.readyCountdownSeconds).toBeLessThan(room.countdownSeconds);
    }
  });

  it('starts the free room with a single player', () => {
    // Nothing is staked, and a first-time player should not have to wait for a
    // stranger before the game will move. Exactly one tier gets this.
    const solo = ROOM_TIERS.filter((room) => room.minPlayers < 2);
    expect(solo.map((room) => room.id)).toEqual(['practice']);
    expect(solo[0]!.entryFeeLamports).toBe(0n);
  });

  it('leaves any seat limit above the auto-start minimum', () => {
    // Currently vacuous — every tier is unlimited — and deliberately kept so.
    // Reintroducing a cap below `minPlayers` would build a room that can never
    // start, and this is the assertion that would catch it.
    for (const room of ROOM_TIERS) {
      if (room.maxPlayers !== null) {
        expect(room.maxPlayers).toBeGreaterThan(room.minPlayers);
      }
    }
  });
});

describe('scheduled mode', () => {
  const openScheduled = (gameId: string | null = 'game-1') =>
    reduceLobby(emptyLobby('test'), { type: 'open', gameId, scheduled: true }, tier, T0).state;

  it('opens an empty lobby bound to a game', () => {
    const state = openScheduled();

    expect(state.players).toHaveLength(0);
    expect(state.status).toBe('waiting');
    expect(state.gameId).toBe('game-1');
    expect(state.scheduled).toBe(true);
  });

  it('never auto-starts a countdown, even past the minimum', () => {
    // The 10-minute cycle owns the timing. If the lobby also ran its own
    // countdown the two would fight and the match would start early.
    let state = openScheduled();
    for (const id of ['a', 'b', 'c', 'd']) {
      state = reduceLobby(state, join(id), tier, T0).state;
    }

    expect(state.players).toHaveLength(4);
    expect(state.status).toBe('waiting');
    expect(state.countdownEndsAt).toBeNull();
  });

  it('never launches on tick', () => {
    let state = openScheduled();
    for (const id of ['a', 'b', 'c']) {
      state = reduceLobby(state, join(id), tier, T0).state;
    }

    const tick = reduceLobby(state, { type: 'tick' }, tier, T0 + 10 * 60_000);
    expect(tick.shouldLaunch).toBe(false);
    expect(tick.state.status).toBe('waiting');
  });

  it('still enforces capacity', () => {
    let state = openScheduled();
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      state = reduceLobby(state, join(id), tier, T0).state;
    }

    expect(reduceLobby(state, join('f'), tier, T0).rejected).toBe('lobby-full');
  });

  it('still tracks ready state for display', () => {
    let state = openScheduled();
    state = reduceLobby(state, join('a'), tier, T0).state;
    state = reduceLobby(state, { type: 'ready', playerId: 'a', ready: true }, tier, T0).state;

    expect(readyCount(state)).toBe(1);
  });

  it('closes on the cycle event and stops accepting players', () => {
    let state = openScheduled();
    for (const id of ['a', 'b', 'c']) {
      state = reduceLobby(state, join(id), tier, T0).state;
    }

    const closed = reduceLobby(state, { type: 'close' }, tier, T0).state;
    expect(closed.status).toBe('launching');
    // The roster survives the close so the caller can escrow and seat them.
    expect(closed.players).toHaveLength(3);

    expect(reduceLobby(closed, join('d'), tier, T0).rejected).toBe('lobby-launching');
  });

  it('treats a repeated close as a no-op', () => {
    // The stage is at-least-once, so closing twice must not churn the version.
    const closed = reduceLobby(openScheduled(), { type: 'close' }, tier, T0).state;
    const again = reduceLobby(closed, { type: 'close' }, tier, T0);

    expect(again.changed).toBe(false);
    expect(again.state.version).toBe(closed.version);
  });

  it('reset returns the lobby to unscheduled waiting', () => {
    const closed = reduceLobby(openScheduled(), { type: 'close' }, tier, T0).state;
    const reset = reduceLobby(closed, { type: 'reset' }, tier, T0).state;

    expect(reset.scheduled).toBe(false);
    expect(reset.gameId).toBeNull();
    expect(reset.status).toBe('waiting');
  });
});
