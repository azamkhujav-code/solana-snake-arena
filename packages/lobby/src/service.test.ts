import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LobbyService } from './service.js';
import { InMemoryLobbyStore } from './store.js';
import { requireTier } from './tiers.js';

const TIER = 'bronze'; // paid: two players, 45s countdown, 5s once everyone has paid
const tier = requireTier(TIER);

let clock = 1_000_000;
const now = () => clock;

function makeService(launch = vi.fn().mockResolvedValue('game-1')) {
  const store = new InMemoryLobbyStore();
  const service = new LobbyService({ store, now, launch });
  return { store, service, launch };
}

const player = (id: string) => ({ playerId: id, nickname: id, wallet: `w-${id}` });

async function fill(service: LobbyService, count: number, from = 0) {
  for (let i = from; i < from + count; i += 1) {
    await service.join(TIER, player(`p${i}`));
  }
}

/**
 * Joins players and marks each one paid.
 *
 * `ready` is what a confirmed entry fee sets, and a staked room launches only
 * with players carrying it — so a test about launching has to pay, or it is
 * really testing the case where nobody did.
 */
async function fillAndPay(service: LobbyService, count: number, from = 0) {
  await fill(service, count, from);
  for (let i = from; i < from + count; i += 1) {
    await service.setReady(TIER, `p${i}`, true);
  }
}

beforeEach(() => {
  clock = 1_000_000;
});

describe('join and leave', () => {
  it('admits a player and reports the lobby', async () => {
    const { service } = makeService();
    const result = await service.join(TIER, player('p1'));

    expect(result.ok).toBe(true);
    expect(result.lobby?.playerCount).toBe(1);
    expect(result.lobby?.status).toBe('waiting');
  });

  it('tracks which lobby a player is in', async () => {
    const { service } = makeService();
    await service.join(TIER, player('p1'));

    expect(await service.whereIs('p1')).toBe(TIER);
  });

  it('moves a player between lobbies rather than seating them twice', async () => {
    // Being in two lobbies at once could escrow the entry fee twice.
    const { service } = makeService();
    await service.join('bronze', player('p1'));
    await service.join('gold', player('p1'));

    expect(await service.whereIs('p1')).toBe('gold');
    expect((await service.get('bronze'))?.playerCount).toBe(0);
    expect((await service.get('gold'))?.playerCount).toBe(1);
  });

  it('rejects a duplicate join into the same lobby', async () => {
    const { service } = makeService();
    await service.join(TIER, player('p1'));
    const again = await service.join(TIER, player('p1'));

    expect(again.ok).toBe(false);
    expect(again.rejected).toBe('already-joined');
  });

  it('clears membership on leave', async () => {
    const { service } = makeService();
    await service.join(TIER, player('p1'));
    const left = await service.leave(TIER, 'p1');

    expect(left.ok).toBe(true);
    expect(await service.whereIs('p1')).toBeNull();
  });

  it('turns nobody away, however many join', async () => {
    // Rooms have no seat limit. Two hundred is far past every cap this used to
    // enforce — the old ceilings ran from 16 on the whale tier to 60 on
    // practice — so a limit surviving anywhere would show up here as a
    // rejection.
    //
    // Asserted here rather than over HTTP because this is where capacity lives.
    // A live script would spend its time fighting the auth rate limiter and the
    // ten-minute cycle clock, and would still be exercising this same state
    // machine underneath.
    const { service } = makeService();
    const crowd = 200;

    for (let i = 0; i < crowd; i += 1) {
      const result = await service.join('whale', player(`w${i}`));
      expect(result.rejected).toBeNull();
    }

    expect((await service.get('whale'))?.playerCount).toBe(crowd);
    expect((await service.get('whale'))?.joinable).toBe(true);
  });
});

describe('auto start', () => {
  it('starts a countdown when the minimum is reached', async () => {
    const { service } = makeService();
    await fill(service, tier.minPlayers);

    const lobby = await service.get(TIER);
    expect(lobby?.status).toBe('countdown');
    expect(lobby?.countdownSeconds).toBe(tier.countdownSeconds);
  });

  it('cancels the countdown if the lobby drops below the minimum', async () => {
    const { service } = makeService();
    await fill(service, tier.minPlayers);
    await service.leave(TIER, 'p0');

    const lobby = await service.get(TIER);
    expect(lobby?.status).toBe('waiting');
    expect(lobby?.countdownSeconds).toBeNull();
  });

  it('does not launch before the countdown expires', async () => {
    const { service, launch } = makeService();
    await fill(service, tier.minPlayers);

    clock += (tier.countdownSeconds - 1) * 1_000;
    const result = await service.tick(TIER);

    expect(result.launched).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches when the countdown expires', async () => {
    const { service, launch } = makeService();
    await fillAndPay(service, tier.minPlayers);

    clock += tier.countdownSeconds * 1_000;
    const result = await service.tick(TIER);

    expect(result.launched).toBe(true);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]?.[0].players).toHaveLength(tier.minPlayers);
  });

  it('reopens the lobby after launching, so the next batch can queue', async () => {
    const { service } = makeService();
    await fillAndPay(service, tier.minPlayers);

    clock += tier.countdownSeconds * 1_000;
    await service.tick(TIER);

    const lobby = await service.get(TIER);
    expect(lobby?.status).toBe('waiting');
    expect(lobby?.playerCount).toBe(0);
    // Players are in the game now, not the lobby.
    expect(await service.whereIs('p0')).toBeNull();
  });

  it('ticks every tier and reports which launched', async () => {
    const { service } = makeService();
    await fillAndPay(service, tier.minPlayers);

    clock += tier.countdownSeconds * 1_000;
    const result = await service.tickAll();

    expect(result.launched).toEqual([TIER]);
  });
});

describe('ready state', () => {
  it('shortens the countdown once everyone is ready', async () => {
    const { service } = makeService();
    await fill(service, tier.minPlayers);
    expect((await service.get(TIER))?.countdownSeconds).toBe(tier.countdownSeconds);

    for (let i = 0; i < tier.minPlayers; i += 1) {
      await service.setReady(TIER, `p${i}`, true);
    }

    const lobby = await service.get(TIER);
    expect(lobby?.countdownSeconds).toBe(tier.readyCountdownSeconds);
    expect(lobby?.readyCount).toBe(tier.minPlayers);
  });

  it('launches on the shortened countdown', async () => {
    const { service, launch } = makeService();
    await fill(service, tier.minPlayers);
    for (let i = 0; i < tier.minPlayers; i += 1) {
      await service.setReady(TIER, `p${i}`, true);
    }

    clock += tier.readyCountdownSeconds * 1_000;
    await service.tick(TIER);

    expect(launch).toHaveBeenCalledOnce();
  });

  it('rejects readying from a player who has not joined', async () => {
    const { service } = makeService();
    const result = await service.setReady(TIER, 'stranger', true);

    expect(result.ok).toBe(false);
    expect(result.rejected).toBe('not-joined');
  });
});

/**
 * A staked match starts only with players whose money is in the vault.
 *
 * `ready` is set from a confirmed entry fee, so in a paid room it means "paid".
 * Starting without it dealt an unpaid player into a pot they had not
 * contributed to — funded entirely by whoever did pay.
 */
describe('paid rooms wait for the money', () => {
  it('does not launch when nobody has paid', async () => {
    const { service, launch } = makeService();
    await fill(service, tier.minPlayers);

    clock += tier.countdownSeconds * 1_000;
    const result = await service.tick(TIER);

    expect(result.launched).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns to waiting so the room can fill again', async () => {
    // Nobody was charged, so there is nothing to refund — the countdown simply
    // starts over when the room next reaches its minimum.
    const { service } = makeService();
    await fill(service, tier.minPlayers);

    clock += tier.countdownSeconds * 1_000;
    await service.tick(TIER);

    const lobby = await service.get(TIER);
    expect(lobby?.status).toBe('waiting');
    expect(lobby?.playerCount).toBe(tier.minPlayers);
  });

  it('does not launch when only some have paid', async () => {
    const { service, launch } = makeService();
    await fill(service, tier.minPlayers);
    await service.setReady(TIER, 'p0', true);

    clock += tier.countdownSeconds * 1_000;
    await service.tick(TIER);

    expect(launch).not.toHaveBeenCalled();
  });

  it('leaves an unpaid player behind when enough others have paid', async () => {
    const { service, launch } = makeService();
    await fillAndPay(service, tier.minPlayers);
    await service.join(TIER, player('freeloader'));

    clock += tier.countdownSeconds * 1_000;
    await service.tick(TIER);

    const entered = launch.mock.calls[0]?.[0].players.map((p: { playerId: string }) => p.playerId);
    expect(entered).toHaveLength(tier.minPlayers);
    expect(entered).not.toContain('freeloader');
  });

  it('still launches a free room with nobody ready', async () => {
    // Practice collects nothing, so there is no payment to wait for.
    const { service, launch } = makeService();
    const free = requireTier('practice');
    await service.join('practice', player('solo'));

    clock += free.countdownSeconds * 1_000;
    await service.tick('practice');

    expect(launch).toHaveBeenCalledOnce();
  });
});

describe('launch failure handling', () => {
  it('resets the lobby instead of leaving it stuck in launching', async () => {
    // A lobby stuck in `launching` is worse than a lost batch: nobody can join,
    // nobody can leave, and the tier is dead until an operator notices.
    const launch = vi.fn().mockRejectedValue(new Error('no realtime capacity'));
    const onError = vi.fn();
    const store = new InMemoryLobbyStore();
    const service = new LobbyService({ store, now, launch, onError });

    // Paid, so the countdown actually reaches a launch — the failure being
    // tested is the launch itself, not the room declining to start.
    for (let i = 0; i < tier.minPlayers; i += 1) {
      await service.join(TIER, player(`p${i}`));
      await service.setReady(TIER, `p${i}`, true);
    }
    clock += tier.countdownSeconds * 1_000;
    await service.tick(TIER);

    const lobby = await service.get(TIER);
    expect(lobby?.status).toBe('waiting');
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('concurrency', () => {
  it('retries when another writer wins the compare-and-set', async () => {
    const { service, store } = makeService();
    await service.join(TIER, player('p1'));

    store.failNextSave = true;
    const result = await service.join(TIER, player('p2'));

    // The first attempt loses the CAS and the event is replayed, so the join
    // still succeeds rather than being silently dropped.
    expect(result.ok).toBe(true);
    expect((await service.get(TIER))?.playerCount).toBe(2);
  });
});

describe('listing', () => {
  it('returns all seven rooms with their entry fees', async () => {
    const { service } = makeService();
    const lobbies = await service.list();

    expect(lobbies).toHaveLength(7);
    expect(lobbies[0]?.entryFeeLamports).toBe('0');
    expect(new Set(lobbies.map((l) => l.entryFeeLamports)).size).toBe(7);
  });

  it('reports live occupancy per room', async () => {
    const { service } = makeService();
    await service.join('gold', player('p1'));

    const lobbies = await service.list();
    const gold = lobbies.find((l) => l.tierId === 'gold');

    expect(gold?.playerCount).toBe(1);
    expect(gold?.joinable).toBe(true);
  });
});
