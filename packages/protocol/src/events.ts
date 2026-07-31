import type {
  InputBatch,
  JoinRoomRequest,
  LeaderboardEntry,
  PlayerDied,
  ProtocolError,
  RoomJoined,
  Snapshot,
} from './schemas.js';

/**
 * Socket.IO event names.
 *
 * Names are terse because they are sent on every packet in the default JSON
 * engine; the binary channel (see binary.ts) bypasses them entirely for the
 * hot path.
 */
export const ClientEvent = {
  Join: 'j',
  Input: 'i',
  Chat: 'c',
  Ping: 'p',
  Respawn: 'r',
  Leave: 'l',
} as const;

export const ServerEvent = {
  Joined: 'J',
  Snapshot: 'S',
  Leaderboard: 'L',
  Died: 'D',
  Chat: 'C',
  Pong: 'P',
  Error: 'E',
  /** Server is draining; client should re-matchmake to a new node. */
  Migrate: 'M',
} as const;

/** Payloads the client may emit. Consumed by Socket.IO's generic typing. */
export interface ClientToServerEvents {
  [ClientEvent.Join]: (
    payload: JoinRoomRequest,
    ack: (result: RoomJoined | ProtocolError) => void,
  ) => void;
  [ClientEvent.Input]: (payload: InputBatch) => void;
  [ClientEvent.Chat]: (payload: { body: string }) => void;
  [ClientEvent.Ping]: (clientTime: number, ack: (serverTime: number) => void) => void;
  [ClientEvent.Respawn]: (ack: (result: RoomJoined | ProtocolError) => void) => void;
  [ClientEvent.Leave]: () => void;
}

/** Payloads the server may emit. */
export interface ServerToClientEvents {
  [ServerEvent.Joined]: (payload: RoomJoined) => void;
  /** Sent as an ArrayBuffer on the hot path; typed loosely on purpose. */
  [ServerEvent.Snapshot]: (payload: Snapshot | ArrayBuffer) => void;
  [ServerEvent.Leaderboard]: (payload: LeaderboardEntry[]) => void;
  [ServerEvent.Died]: (payload: PlayerDied) => void;
  [ServerEvent.Chat]: (payload: { playerId: string; nickname: string; body: string }) => void;
  [ServerEvent.Pong]: (serverTime: number) => void;
  [ServerEvent.Error]: (payload: ProtocolError) => void;
  [ServerEvent.Migrate]: (payload: { reason: string; reconnectAfterMs: number }) => void;
}

/** Events passed between realtime nodes via the Redis adapter. */
export interface InterServerEvents {
  roomClosed: (roomId: string) => void;
  drain: (nodeId: string) => void;
}

/** Per-connection state attached after the auth handshake. */
export interface SocketData {
  playerId: string;
  wallet: string;
  roomId: string | null;
  nickname: string;
  joinedAt: number;
  /** Rolling counter used by the per-socket input rate limiter. */
  inputBudget: number;
}
