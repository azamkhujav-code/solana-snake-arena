/**
 * Every Redis key used by the platform, in one place.
 *
 * Keys that must live on the same Redis Cluster slot use a `{hash tag}` so that
 * multi-key operations (Lua scripts, transactions) stay legal once the single
 * node is replaced by a cluster.
 */
export const redisKeys = {
  /* ---- Auth ------------------------------------------------------------ */

  /** Nonce issued for a wallet to sign. Short TTL, single use. */
  authNonce: (wallet: string) => `auth:nonce:${wallet}`,
  /** Refresh-token family, for rotation and reuse detection. */
  refreshFamily: (familyId: string) => `auth:refresh:${familyId}`,
  /** Denylist of revoked access-token jti values. */
  revokedToken: (jti: string) => `auth:revoked:${jti}`,
  /**
   * Unix seconds before which every access token for a user is refused.
   *
   * Individual jti values cannot be enumerated — they are not stored — so a ban
   * needs a per-user tombstone to take effect before the token's natural
   * expiry. Set on ban and on "log out everywhere".
   */
  sessionCutoff: (userId: string) => `auth:cutoff:${userId}`,
  /** Failed sign-in attempts for a wallet, for progressive backoff. */
  authFailures: (wallet: string) => `auth:fail:${wallet}`,

  /* ---- Cluster topology ------------------------------------------------ */

  /** Set of realtime nodes currently accepting rooms. */
  nodeRegistry: () => 'cluster:nodes',
  /** Heartbeat + capacity for one realtime node. Expires if not refreshed. */
  nodeHeartbeat: (nodeId: string) => `cluster:node:${nodeId}`,
  /** Sorted set of nodes scored by load, for placement decisions. */
  nodeLoadIndex: (region: string) => `cluster:load:${region}`,

  /* ---- Rooms ----------------------------------------------------------- */

  /** Room metadata: owning node, player count, mode, state. */
  room: (roomId: string) => `room:{${roomId}}:meta`,
  /** Players currently in a room. */
  roomPlayers: (roomId: string) => `room:{${roomId}}:players`,
  /** Open rooms per region/mode, scored by free slots. */
  roomIndex: (region: string, mode: string) => `room:index:${region}:${mode}`,

  /* ---- Presence -------------------------------------------------------- */

  /** Which room/node a player is on. Enables reconnect and duplicate rejection. */
  playerSession: (playerId: string) => `presence:player:${playerId}`,
  /** Guards against one wallet opening many concurrent sessions. */
  walletSessions: (wallet: string) => `presence:wallet:${wallet}`,
  /**
   * Single-use join ticket, consumed with GETDEL on the socket handshake.
   *
   * Keyed by player rather than by ticket value, so issuing a new one replaces
   * the old: a player cannot bank tickets and open several sockets at once.
   */
  matchTicket: (playerId: string) => `ticket:${playerId}`,
  /**
   * The room a player is expected in, and may re-enter without a fresh ticket.
   *
   * Written when the ticket is minted rather than when it is consumed, which
   * matters more than it sounds: the socket reconnects on its own and a client
   * can open two connections at once, so writing it on the handshake left a
   * race where the second connection read this before the first had written it
   * and was refused with "ticket already used or expired" — mid-match, for no
   * reason the player could see.
   *
   * It does not weaken single use in any way that matters. The ticket must
   * still verify by HMAC and name the right node, so a forgery opens nothing;
   * this is keyed by player and holds one room, so it readmits exactly one
   * person to the one seat they already occupy.
   */
  reconnectRoom: (playerId: string) => `reconnect:${playerId}`,

  /* ---- Leaderboards ---------------------------------------------------- */

  /** Live in-room scores. */
  roomScores: (roomId: string) => `room:{${roomId}}:scores`,
  /** Rolling global leaderboard; `window` is e.g. daily:2026-07-30. */
  leaderboard: (window: string) => `leaderboard:${window}`,

  /* ---- Rate limiting / anti-cheat -------------------------------------- */

  rateLimit: (scope: string, identifier: string) => `ratelimit:${scope}:${identifier}`,
  suspicion: (playerId: string) => `anticheat:score:${playerId}`,

  /* ---- Coordination ---------------------------------------------------- */

  /** Distributed lock, e.g. for room creation or match settlement. */
  lock: (resource: string) => `lock:${resource}`,
  /** Idempotency guard for on-chain settlement submissions. */
  settlementIdempotency: (matchId: string) => `settle:idem:${matchId}`,
} as const;

/** Socket.IO Redis adapter channel prefix. */
export const SOCKET_ADAPTER_PREFIX = 'socket.io';

/** Cross-service pub/sub channels. */
export const redisChannels = {
  /** Room lifecycle: created, closed, migrated. */
  roomLifecycle: 'events:room-lifecycle',
  /** Match finished and is ready for on-chain settlement. */
  matchSettlement: 'events:match-settlement',
  /** Operator broadcasts (maintenance banners, forced drain). */
  adminBroadcast: 'events:admin-broadcast',
  /**
   * A match for a tier has started and is accepting connections.
   *
   * Per-tier rather than one global channel: a client waiting in the gold lobby
   * has no use for whale-room events, and fanning every start to every waiting
   * browser is the kind of broadcast that gets expensive quietly.
   */
  matchStarted: (tierId: string) => `events:match-started:${tierId}`,
} as const;
