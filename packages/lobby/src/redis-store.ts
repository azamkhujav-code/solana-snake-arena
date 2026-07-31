import type { RedisClient } from '@arena/redis';

import { emptyLobby, type LobbyState } from './state.js';
import type { LobbyStore } from './store.js';

const LOBBY_KEY = (tierId: string) => `lobby:{${tierId}}:state`;
const PLAYER_KEY = (playerId: string) => `lobby:player:${playerId}`;

/** A player's lobby membership expires if they vanish without leaving. */
const PLAYER_TTL_SECONDS = 30 * 60;

/**
 * Compare-and-set write.
 *
 * Lua because the read and the write must be one atomic step. A GET followed by
 * a SET from application code loses races between matchmaker replicas — and the
 * race that matters is two players being admitted into the last slot of a full
 * lobby.
 */
const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local expected = tonumber(ARGV[2])

if current == false then
  if expected ~= 0 then return 0 end
else
  local decoded = cjson.decode(current)
  if tonumber(decoded.version) ~= expected then return 0 end
end

redis.call('SET', KEYS[1], ARGV[1])
return 1
`;

export class RedisLobbyStore implements LobbyStore {
  constructor(private readonly redis: RedisClient) {}

  async load(tierId: string): Promise<LobbyState> {
    const raw = await this.redis.get(LOBBY_KEY(tierId));
    if (!raw) return emptyLobby(tierId);

    try {
      return JSON.parse(raw) as LobbyState;
    } catch {
      // Corrupt payload: a lobby is transient state, so resetting is safer
      // than crashing the matchmaker on every request for this tier.
      return emptyLobby(tierId);
    }
  }

  async save(state: LobbyState, expectedVersion: number): Promise<boolean> {
    const result = await this.redis.eval(
      CAS_SCRIPT,
      1,
      LOBBY_KEY(state.tierId),
      JSON.stringify(state),
      String(expectedVersion),
    );
    return result === 1;
  }

  async loadAll(tierIds: readonly string[]): Promise<LobbyState[]> {
    if (tierIds.length === 0) return [];

    // Hash tags put every lobby key on its own slot, so MGET is illegal under
    // Redis Cluster. Individual GETs pipeline fine and stay cluster-safe.
    return Promise.all(tierIds.map((id) => this.load(id)));
  }

  async findPlayerLobby(playerId: string): Promise<string | null> {
    return this.redis.get(PLAYER_KEY(playerId));
  }

  async setPlayerLobby(playerId: string, tierId: string | null): Promise<void> {
    if (tierId === null) {
      await this.redis.del(PLAYER_KEY(playerId));
      return;
    }
    await this.redis.set(PLAYER_KEY(playerId), tierId, 'EX', PLAYER_TTL_SECONDS);
  }
}
