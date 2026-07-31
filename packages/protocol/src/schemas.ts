import { z } from 'zod';

/* ---- Primitives -------------------------------------------------------- */

export const playerIdSchema = z.uuid();
export const roomIdSchema = z.string().min(8).max(64);
export const matchIdSchema = z.uuid();

/** Base58, 32-44 chars. Format only; ownership is proven by signature. */
export const walletAddressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Invalid Solana address');

export const nicknameSchema = z
  .string()
  .trim()
  .min(2)
  .max(16)
  .regex(/^[\p{L}\p{N}_\- ]+$/u, 'Nickname contains unsupported characters');

export const vector2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const gameModeSchema = z.enum(['casual', 'ranked', 'wager']);
export type GameMode = z.infer<typeof gameModeSchema>;

export const regionSchema = z.enum(['us-east', 'us-west', 'eu-west', 'ap-southeast']);
export type Region = z.infer<typeof regionSchema>;

/* ---- Client -> Server -------------------------------------------------- */

/**
 * One sampled input. `seq` lets the server ack the last processed input so the
 * client can reconcile its prediction; `dt` bounds how much simulated time a
 * single input may advance, which is the main speed-hack guard.
 */
export const inputCommandSchema = z.object({
  seq: z.number().int().nonnegative(),
  /** Desired heading in radians. */
  angle: z.number().min(-Math.PI).max(Math.PI),
  boost: z.boolean(),
  /** Client-side delta in ms; server clamps this. */
  dt: z.number().min(0).max(250),
});
export type InputCommand = z.infer<typeof inputCommandSchema>;

export const inputBatchSchema = z.object({
  commands: z.array(inputCommandSchema).min(1).max(10),
  /** Client clock at send time, for RTT estimation. */
  clientTime: z.number().int().nonnegative(),
});
export type InputBatch = z.infer<typeof inputBatchSchema>;

export const joinRoomRequestSchema = z.object({
  roomId: roomIdSchema,
  /** Short-lived ticket minted by the matchmaker. */
  ticket: z.string().min(16),
  nickname: nicknameSchema,
  skinId: z.string().max(64).optional(),
  protocolVersion: z.string(),
});
export type JoinRoomRequest = z.infer<typeof joinRoomRequestSchema>;

export const chatMessageSchema = z.object({
  body: z.string().trim().min(1).max(140),
});

/* ---- Server -> Client -------------------------------------------------- */

export const snakeStateSchema = z.object({
  id: playerIdSchema,
  nickname: nicknameSchema,
  /** Spine points, head first. Truncated to what the viewer can see. */
  points: z.array(vector2Schema),
  angle: z.number(),
  mass: z.number().nonnegative(),
  radius: z.number().positive(),
  boosting: z.boolean(),
  skinId: z.string().optional(),
  isBot: z.boolean().default(false),
});
export type SnakeState = z.infer<typeof snakeStateSchema>;

export const foodStateSchema = z.object({
  id: z.number().int().nonnegative(),
  position: vector2Schema,
  mass: z.number().positive(),
  hue: z.number().int().min(0).max(360),
});
export type FoodState = z.infer<typeof foodStateSchema>;

/**
 * A delta snapshot. Only entities that entered, changed within, or left the
 * viewer's area of interest are included.
 */
export const snapshotSchema = z.object({
  tick: z.number().int().nonnegative(),
  serverTime: z.number().int().nonnegative(),
  /** Last input seq the server applied, for client reconciliation. */
  ackSeq: z.number().int().nonnegative(),
  snakes: z.array(snakeStateSchema),
  food: z.array(foodStateSchema),
  /** Ids that left the AOI or were destroyed. */
  removedSnakes: z.array(playerIdSchema),
  removedFood: z.array(z.number().int()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const leaderboardEntrySchema = z.object({
  playerId: playerIdSchema,
  nickname: nicknameSchema,
  score: z.number().int().nonnegative(),
  kills: z.number().int().nonnegative(),
  rank: z.number().int().positive(),
});
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

export const deathReasonSchema = z.enum(['collision', 'wall', 'disconnect', 'kicked']);

export const playerDiedSchema = z.object({
  playerId: playerIdSchema,
  killedBy: playerIdSchema.nullable(),
  reason: deathReasonSchema,
  finalScore: z.number().int().nonnegative(),
  survivedMs: z.number().int().nonnegative(),
  matchId: matchIdSchema.nullable(),
});
export type PlayerDied = z.infer<typeof playerDiedSchema>;

/**
 * Final standings, sent to everyone still connected when a match resolves.
 *
 * `entrants` rather than a prize figure: the pot lives on chain and the room
 * has no view of it, but a staked match now starts only once every entrant has
 * paid — so the client can multiply its own tier's entry fee by this and get
 * the real number rather than being told an estimate the server also guessed.
 */
export const matchEndedSchema = z.object({
  gameId: z.string().nullable(),
  winnerId: playerIdSchema.nullable(),
  winnerNickname: nicknameSchema.nullable(),
  entrants: z.number().int().nonnegative(),
  standings: z.array(
    z.object({
      playerId: playerIdSchema,
      placement: z.number().int().positive(),
      score: z.number().int().nonnegative(),
      kills: z.number().int().nonnegative(),
    }),
  ),
});
export type MatchEnded = z.infer<typeof matchEndedSchema>;

export const roomJoinedSchema = z.object({
  playerId: playerIdSchema,
  roomId: roomIdSchema,
  tickRate: z.number().int().positive(),
  snapshotRate: z.number().int().positive(),
  worldRadius: z.number().positive(),
  serverTime: z.number().int().nonnegative(),
});
export type RoomJoined = z.infer<typeof roomJoinedSchema>;

export const errorCodeSchema = z.enum([
  'PROTOCOL_MISMATCH',
  'INVALID_TICKET',
  'ROOM_FULL',
  'ROOM_NOT_FOUND',
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'DUPLICATE_SESSION',
  'SERVER_DRAINING',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const protocolErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type ProtocolError = z.infer<typeof protocolErrorSchema>;
