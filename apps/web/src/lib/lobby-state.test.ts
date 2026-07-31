import { describe, expect, it } from 'vitest';

import {
  deriveJoinState,
  fillRatio,
  formatSolShort,
  grossPool,
  localCountdown,
  statusLabel,
  type JoinContext,
  type LobbySummary,
} from './lobby-state';

const lobby = (over: Partial<LobbySummary> = {}): LobbySummary => ({
  tierId: 'bronze',
  name: 'Bronze Arena',
  description: '',
  entryFeeLamports: '10000000', // 0.01 SOL
  status: 'waiting',
  playerCount: 2,
  readyCount: 0,
  minPlayers: 2,
  maxPlayers: null,
  countdownSeconds: null,
  joinable: true,
  gameId: null,
  ...over,
});

const ctx = (over: Partial<JoinContext> = {}): JoinContext => ({
  authenticated: true,
  spendableLamports: 1_000_000_000n,
  currentTierId: null,
  pending: false,
  ...over,
});

describe('deriveJoinState', () => {
  it('offers a plain join when everything is fine', () => {
    const state = deriveJoinState(lobby(), ctx());
    expect(state).toMatchObject({ action: 'join', label: 'Join', disabled: false, active: false });
  });

  it('labels a free room differently', () => {
    const state = deriveJoinState(lobby({ entryFeeLamports: '0' }), ctx());
    expect(state.label).toBe('Play free');
  });

  it('prompts sign-in when signed out, without disabling the button', () => {
    // Disabling it would leave the player with no way to act on the card.
    const state = deriveJoinState(lobby(), ctx({ authenticated: false }));
    expect(state).toMatchObject({ action: 'sign-in', disabled: false });
  });

  it('blocks on insufficient balance and says how much is missing', () => {
    const state = deriveJoinState(lobby(), ctx({ spendableLamports: 4_000_000n }));

    expect(state.disabled).toBe(true);
    expect(state.label).toBe('Insufficient balance');
    expect(state.reason).toContain('0.006');
  });

  it('does not block while the balance is still loading', () => {
    // Otherwise every card flashes disabled on first paint.
    const state = deriveJoinState(lobby(), ctx({ spendableLamports: null }));
    expect(state.disabled).toBe(false);
  });

  it('ignores balance entirely for a free room', () => {
    const state = deriveJoinState(lobby({ entryFeeLamports: '0' }), ctx({ spendableLamports: 0n }));
    expect(state.disabled).toBe(false);
  });

  it('never blocks on a crowd, because rooms have no seat limit', () => {
    // The "Full" state no longer exists. A player who wants into a busy room is
    // exactly the player the room wants.
    const state = deriveJoinState(lobby({ playerCount: 500 }), ctx());
    expect(state).toMatchObject({ label: 'Join', disabled: false });
  });

  it('blocks a room that already started', () => {
    const state = deriveJoinState(lobby({ status: 'launching' }), ctx());
    expect(state).toMatchObject({ label: 'In progress', disabled: true });
  });

  it('offers leave for the room the player is queued in', () => {
    const state = deriveJoinState(lobby(), ctx({ currentTierId: 'bronze' }));
    expect(state).toMatchObject({ action: 'leave', label: 'Leave', disabled: false, active: true });
  });

  it('still allows leaving a full lobby', () => {
    // Being unable to leave a room you are already in is a trap.
    const state = deriveJoinState(
      lobby({ playerCount: 60, maxPlayers: 60 }),
      ctx({ currentTierId: 'bronze' }),
    );
    expect(state.action).toBe('leave');
    expect(state.disabled).toBe(false);
  });

  it('locks leaving once the match is launching', () => {
    // The entry fee is escrowed by then; refunds go through the cancel path.
    const state = deriveJoinState(lobby({ status: 'launching' }), ctx({ currentTierId: 'bronze' }));
    expect(state).toMatchObject({ action: 'none', label: 'Starting…', disabled: true });
  });

  it('warns that joining elsewhere leaves the current room', () => {
    const state = deriveJoinState(lobby(), ctx({ currentTierId: 'gold' }));

    expect(state.action).toBe('join');
    expect(state.label).toBe('Switch to this room');
    expect(state.reason).toContain('gold');
  });

  it('shows a pending label while a request is in flight', () => {
    expect(deriveJoinState(lobby(), ctx({ pending: true })).label).toBe('Joining…');
    expect(deriveJoinState(lobby(), ctx({ pending: true, currentTierId: 'bronze' })).label).toBe(
      'Leaving…',
    );
  });
});

describe('grossPool', () => {
  it('multiplies the entry fee by the head count', () => {
    expect(grossPool(lobby({ playerCount: 7 }))).toBe(70_000_000n);
  });

  it('is zero for a free room', () => {
    expect(grossPool(lobby({ entryFeeLamports: '0', playerCount: 30 }))).toBe(0n);
  });

  it('stays exact at large values', () => {
    // A float would lose precision well before this.
    const pool = grossPool(lobby({ entryFeeLamports: '5000000000', playerCount: 16 }));
    expect(pool).toBe(80_000_000_000n);
  });
});

describe('formatSolShort', () => {
  it('renders whole amounts without a decimal point', () => {
    expect(formatSolShort(1_000_000_000n)).toBe('1');
    expect(formatSolShort(0n)).toBe('0');
  });

  it('preserves leading zeros in the fraction', () => {
    expect(formatSolShort(10_000_000n)).toBe('0.01');
    expect(formatSolShort(500_000_000n)).toBe('0.5');
  });

  it('trims trailing zeros', () => {
    expect(formatSolShort(1_500_000_000n)).toBe('1.5');
  });

  it('shows a floor marker rather than rounding dust to zero', () => {
    // Rendering "0" for a non-zero fee would read as free.
    expect(formatSolShort(1n)).toBe('<0.001');
  });

  it('does not mark a large amount as dust when the fraction rounds away', () => {
    expect(formatSolShort(5_000_000_100n)).toBe('5');
  });
});

describe('fillRatio', () => {
  it('measures progress toward the start, not fullness', () => {
    // With no seat limit there is no such thing as fullness. What a player
    // waiting in a lobby wants to know is how close it is to starting.
    expect(fillRatio(lobby({ playerCount: 1, minPlayers: 2 }))).toBe(0.5);
  });

  it('is full once the start threshold is met', () => {
    expect(fillRatio(lobby({ playerCount: 2, minPlayers: 2 }))).toBe(1);
  });

  it('clamps at one rather than growing with the crowd', () => {
    // Otherwise a room of five hundred renders a bar two hundred times too long.
    expect(fillRatio(lobby({ playerCount: 500, minPlayers: 2 }))).toBe(1);
  });

  it('survives a zero threshold', () => {
    expect(fillRatio(lobby({ minPlayers: 0 }))).toBe(1);
  });
});

describe('statusLabel', () => {
  it('counts down while counting down', () => {
    expect(statusLabel(lobby({ status: 'countdown' }), 12)).toBe('Starts in 12s');
  });

  it('switches to starting at zero', () => {
    expect(statusLabel(lobby({ status: 'countdown' }), 0)).toBe('Starting…');
  });

  it('says how many more players are needed', () => {
    expect(statusLabel(lobby({ playerCount: 1, minPlayers: 4 }), null)).toBe('Needs 3 more');
  });

  it('waits for the next round once the minimum is met', () => {
    expect(statusLabel(lobby({ playerCount: 5, minPlayers: 4 }), null)).toBe(
      'Waiting for the next round',
    );
  });
});

describe('localCountdown', () => {
  it('ticks down between polls', () => {
    // A timer that only moves when a poll lands looks broken.
    expect(localCountdown(30, 1_000, 4_000)).toBe(27);
  });

  it('never goes below zero', () => {
    expect(localCountdown(5, 1_000, 60_000)).toBe(0);
  });

  it('passes null through', () => {
    expect(localCountdown(null, 0, 1_000)).toBeNull();
  });

  it('tolerates a clock that went backwards', () => {
    expect(localCountdown(30, 5_000, 1_000)).toBe(30);
  });
});
