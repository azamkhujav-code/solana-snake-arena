import { emptyLobby, type LobbyState } from './state.js';

/**
 * Lobby persistence.
 *
 * Two implementations: Redis in production (shared across matchmaker replicas)
 * and in-memory for tests. The interface is deliberately narrow — load, and a
 * compare-and-set write — because that is all the state machine needs, and a
 * wider surface would tempt callers into non-atomic read-modify-write.
 */
export interface LobbyStore {
  load(tierId: string): Promise<LobbyState>;
  /**
   * Writes only if the stored version still matches `expectedVersion`.
   * Returns false when another writer got there first; the caller re-reads and
   * retries. This is what keeps two replicas from both admitting the last
   * player into a full lobby.
   */
  save(state: LobbyState, expectedVersion: number): Promise<boolean>;
  loadAll(tierIds: readonly string[]): Promise<LobbyState[]>;
  /** Which lobby a player is currently in, if any. */
  findPlayerLobby(playerId: string): Promise<string | null>;
  setPlayerLobby(playerId: string, tierId: string | null): Promise<void>;
}

/** Test double. Not safe across processes — that is the point of the interface. */
export class InMemoryLobbyStore implements LobbyStore {
  private readonly lobbies = new Map<string, LobbyState>();
  private readonly playerIndex = new Map<string, string>();
  /** Set by tests to simulate a lost CAS race. */
  failNextSave = false;

  async load(tierId: string): Promise<LobbyState> {
    const existing = this.lobbies.get(tierId);
    return existing ? structuredClone(existing) : emptyLobby(tierId);
  }

  async save(state: LobbyState, expectedVersion: number): Promise<boolean> {
    if (this.failNextSave) {
      this.failNextSave = false;
      return false;
    }

    const current = this.lobbies.get(state.tierId);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion) return false;

    this.lobbies.set(state.tierId, structuredClone(state));
    return true;
  }

  async loadAll(tierIds: readonly string[]): Promise<LobbyState[]> {
    return Promise.all(tierIds.map((id) => this.load(id)));
  }

  async findPlayerLobby(playerId: string): Promise<string | null> {
    return this.playerIndex.get(playerId) ?? null;
  }

  async setPlayerLobby(playerId: string, tierId: string | null): Promise<void> {
    if (tierId === null) this.playerIndex.delete(playerId);
    else this.playerIndex.set(playerId, tierId);
  }

  /** Test helper. */
  seed(state: LobbyState): void {
    this.lobbies.set(state.tierId, structuredClone(state));
  }
}
