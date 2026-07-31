import {
  countdownRemaining,
  isJoinable,
  readyCount,
  reduceLobby,
  type LobbyEvent,
  type LobbyRejection,
  type LobbyState,
} from './state.js';
import type { LobbyStore } from './store.js';
import { requireTier, ROOM_TIERS, TIER_IDS, type RoomTier } from './tiers.js';

export interface LobbySummary {
  tierId: string;
  name: string;
  description: string;
  entryFeeLamports: string;
  status: LobbyState['status'];
  playerCount: number;
  readyCount: number;
  minPlayers: number;
  maxPlayers: number | null;
  countdownSeconds: number | null;
  joinable: boolean;
  gameId: string | null;
}

export interface JoinResult {
  ok: boolean;
  rejected: LobbyRejection | null;
  lobby: LobbySummary | null;
}

export interface LaunchRequest {
  tierId: string;
  players: LobbyState['players'];
  tier: RoomTier;
  /**
   * The game this lobby was opened for, if one was prepared.
   *
   * The cycle creates a game row and its on-chain vault before opening the
   * lobby, and `open` binds that id here. Passing it on is what connects the
   * match players actually play to the escrow their fees went into — without
   * it the launcher minted its own id, and everything downstream (the pot, the
   * payout, settlement) was looking for a game that did not exist.
   */
  gameId: string | null;
}

export interface LobbyServiceDeps {
  store: LobbyStore;
  now?: () => number;
  /**
   * Turns a full lobby into a real game: allocates a realtime node, creates the
   * on-chain room for paid tiers, and persists the match record. Returns the
   * game id.
   */
  launch: (request: LaunchRequest) => Promise<string>;
  onError?: (error: unknown, context: Record<string, unknown>) => void;
}

/** How many times a lost compare-and-set is retried before giving up. */
const MAX_CAS_ATTEMPTS = 5;

export class LobbyService {
  private readonly store: LobbyStore;
  private readonly now: () => number;
  private readonly launch: LobbyServiceDeps['launch'];
  private readonly onError: LobbyServiceDeps['onError'];

  constructor(deps: LobbyServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.launch = deps.launch;
    this.onError = deps.onError;
  }

  /**
   * Applies an event under optimistic concurrency.
   *
   * Re-reads and re-applies on a lost CAS rather than merging: the state
   * machine is cheap and pure, so replaying against fresh state is both simpler
   * and more correct than trying to reconcile two versions.
   */
  private async apply(
    tierId: string,
    event: LobbyEvent,
  ): Promise<{ state: LobbyState; rejected: LobbyRejection | null; launched: boolean }> {
    const tier = requireTier(tierId);

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.store.load(tierId);
      const result = reduceLobby(current, event, tier, this.now());

      if (result.rejected) {
        return { state: current, rejected: result.rejected, launched: false };
      }
      if (!result.changed) {
        return { state: current, rejected: null, launched: false };
      }

      const saved = await this.store.save(result.state, current.version);
      if (!saved) continue; // someone else wrote; replay against their state

      if (result.shouldLaunch) {
        const launched = await this.performLaunch(tier, result.state);
        return { state: launched, rejected: null, launched: true };
      }

      return { state: result.state, rejected: null, launched: false };
    }

    throw new Error(`Lobby ${tierId} is too contended; gave up after ${MAX_CAS_ATTEMPTS} attempts`);
  }

  /**
   * Creates the game and clears the lobby for the next batch.
   *
   * A launch failure resets the lobby to `waiting` rather than leaving it stuck
   * in `launching`. Stuck is the worse outcome: nobody can join, nobody can
   * leave, and the tier is dead until someone notices.
   */
  private async performLaunch(tier: RoomTier, state: LobbyState): Promise<LobbyState> {
    try {
      const gameId = await this.launch({
        tierId: tier.id,
        players: state.players,
        tier,
        gameId: state.gameId,
      });

      const marked = reduceLobby(state, { type: 'launched', gameId }, tier, this.now());
      await this.store.save(marked.state, state.version);

      for (const player of state.players) {
        await this.store.setPlayerLobby(player.playerId, null);
      }

      // Open immediately for the next batch; players are already in the game.
      const reset = reduceLobby(marked.state, { type: 'reset' }, tier, this.now());
      await this.store.save(reset.state, marked.state.version);

      return marked.state;
    } catch (error) {
      this.onError?.(error, { tierId: tier.id, players: state.players.length });

      const reset = reduceLobby(state, { type: 'reset' }, tier, this.now());
      await this.store.save(reset.state, state.version);
      return reset.state;
    }
  }

  async join(
    tierId: string,
    player: { playerId: string; nickname: string; wallet: string },
  ): Promise<JoinResult> {
    // A player in two lobbies could have their entry fee escrowed twice.
    const existing = await this.store.findPlayerLobby(player.playerId);
    if (existing && existing !== tierId) {
      await this.leave(existing, player.playerId);
    }

    const result = await this.apply(tierId, { type: 'join', player });

    if (!result.rejected) {
      await this.store.setPlayerLobby(player.playerId, tierId);
    }

    return {
      ok: result.rejected === null,
      rejected: result.rejected,
      lobby: this.summarize(result.state),
    };
  }

  async leave(tierId: string, playerId: string): Promise<JoinResult> {
    const result = await this.apply(tierId, { type: 'leave', playerId });

    if (!result.rejected) {
      await this.store.setPlayerLobby(playerId, null);
    }

    return {
      ok: result.rejected === null,
      rejected: result.rejected,
      lobby: this.summarize(result.state),
    };
  }

  async setReady(tierId: string, playerId: string, ready: boolean): Promise<JoinResult> {
    const result = await this.apply(tierId, { type: 'ready', playerId, ready });
    return {
      ok: result.rejected === null,
      rejected: result.rejected,
      lobby: this.summarize(result.state),
    };
  }

  /** Drives countdown expiry. Called on an interval by the ticker. */
  async tick(tierId: string): Promise<{ launched: boolean }> {
    const result = await this.apply(tierId, { type: 'tick' });
    return { launched: result.launched };
  }

  async tickAll(): Promise<{ launched: string[] }> {
    const launched: string[] = [];

    for (const tierId of TIER_IDS) {
      try {
        const result = await this.tick(tierId);
        if (result.launched) launched.push(tierId);
      } catch (error) {
        this.onError?.(error, { tierId, phase: 'tick' });
      }
    }

    return { launched };
  }

  async list(): Promise<LobbySummary[]> {
    const states = await this.store.loadAll(TIER_IDS);
    return states
      .map((state) => this.summarize(state))
      .filter((s): s is LobbySummary => s !== null);
  }

  async get(tierId: string): Promise<LobbySummary | null> {
    return this.summarize(await this.store.load(tierId));
  }

  /**
   * Opens an empty lobby for a new cycle.
   *
   * `scheduled` hands lifecycle control to the caller: the lobby will not start
   * its own countdown, and only an explicit `close` moves it on.
   */
  async open(
    tierId: string,
    options: { gameId: string | null; scheduled?: boolean } = { gameId: null },
  ): Promise<LobbySummary | null> {
    const result = await this.apply(tierId, {
      type: 'open',
      gameId: options.gameId,
      scheduled: options.scheduled ?? true,
    });
    return this.summarize(result.state);
  }

  /** Stops accepting players. Returns the final roster for the caller to act on. */
  async close(tierId: string): Promise<LobbySummary | null> {
    const result = await this.apply(tierId, { type: 'close' });
    return this.summarize(result.state);
  }

  /** Clears the lobby and returns it to unscheduled waiting. */
  async reset(tierId: string): Promise<LobbySummary | null> {
    const result = await this.apply(tierId, { type: 'reset' });

    for (const player of result.state.players) {
      await this.store.setPlayerLobby(player.playerId, null);
    }
    return this.summarize(result.state);
  }

  async whereIs(playerId: string): Promise<string | null> {
    return this.store.findPlayerLobby(playerId);
  }

  private summarize(state: LobbyState): LobbySummary | null {
    const tier = ROOM_TIERS.find((entry) => entry.id === state.tierId);
    if (!tier) return null;

    return {
      tierId: tier.id,
      name: tier.name,
      description: tier.description,
      entryFeeLamports: tier.entryFeeLamports.toString(),
      status: state.status,
      playerCount: state.players.length,
      readyCount: readyCount(state),
      minPlayers: tier.minPlayers,
      maxPlayers: tier.maxPlayers,
      countdownSeconds: countdownRemaining(state, this.now()),
      joinable: isJoinable(state, tier),
      gameId: state.gameId,
    };
  }
}
