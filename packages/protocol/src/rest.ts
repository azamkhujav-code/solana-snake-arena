import { z } from 'zod';

import {
  gameModeSchema,
  matchIdSchema,
  nicknameSchema,
  playerIdSchema,
  regionSchema,
  roomIdSchema,
  walletAddressSchema,
} from './schemas.js';

/**
 * HTTP contracts between the browser and the gateway/matchmaker.
 *
 * These schemas are the single source of truth: Fastify validates requests with
 * them and TanStack Query infers response types from them, so a contract change
 * breaks compilation on both sides.
 */

/* ---- Auth (wallet signature) ------------------------------------------ */

export const nonceRequestSchema = z.object({
  wallet: walletAddressSchema,
});

export const nonceResponseSchema = z.object({
  nonce: z.string().min(16),
  /** Exact string the wallet must sign. */
  message: z.string().min(1),
  expiresAt: z.number().int(),
});

export const verifySignatureRequestSchema = z.object({
  wallet: walletAddressSchema,
  /** base58-encoded ed25519 signature over `message`. */
  signature: z.string().min(64),
  nonce: z.string().min(16),
});

export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().positive(),
});

export const sessionResponseSchema = z.object({
  player: z.object({
    id: playerIdSchema,
    wallet: walletAddressSchema,
    nickname: nicknameSchema.nullable(),
    /**
     * Returned so the client can decide whether to show operator navigation
     * without a second round trip. It is a hint for rendering only — the
     * gateway re-reads the role from the token on every request, so editing
     * this in devtools buys nothing.
     */
    role: z.enum(['PLAYER', 'MODERATOR', 'ADMIN']),
    createdAt: z.iso.datetime(),
  }),
  tokens: authTokensSchema,
});

/**
 * Starts a session from a connected wallet, with no signature.
 *
 * The nickname is optional so a returning player keeps the one they chose.
 */
export const connectRequestSchema = z.object({
  wallet: walletAddressSchema,
  nickname: nicknameSchema.optional(),
});

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(16),
});

/* ---- Matchmaking ------------------------------------------------------- */

export const findMatchRequestSchema = z.object({
  mode: gameModeSchema.default('casual'),
  region: regionSchema.optional(),
  /** Lamports staked; only meaningful for `wager` mode. */
  wagerLamports: z.coerce.bigint().nonnegative().optional(),
  /**
   * The room tier this placement is for.
   *
   * Required to reach a staked match. Without it the room is derived from the
   * node and mode alone, which puts everyone who asked for a casual game in one
   * room — including players who each paid into a *different* tier's pot. They
   * would then fight for a prize none of them was playing for.
   *
   * Optional because unranked quick-play has no tier and is a legitimate use.
   */
  tierId: z.string().min(1).max(32).optional(),
});

export const matchTicketSchema = z.object({
  roomId: roomIdSchema,
  /** WebSocket URL of the realtime node owning this room. */
  realtimeUrl: z.url(),
  /** Single-use, short-lived credential presented on the socket handshake. */
  ticket: z.string().min(16),
  expiresAt: z.number().int(),
  region: regionSchema,
  mode: gameModeSchema,
});
export type MatchTicket = z.infer<typeof matchTicketSchema>;

/* ---- Profile ----------------------------------------------------------- */

export const updateProfileRequestSchema = z.object({
  nickname: nicknameSchema.optional(),
  skinId: z.string().max(64).optional(),
});

export const playerStatsSchema = z.object({
  playerId: playerIdSchema,
  nickname: nicknameSchema.nullable(),
  gamesPlayed: z.number().int().nonnegative(),
  kills: z.number().int().nonnegative(),
  deaths: z.number().int().nonnegative(),
  bestScore: z.number().int().nonnegative(),
  totalPlaytimeSeconds: z.number().int().nonnegative(),
});

/* ---- Leaderboard ------------------------------------------------------- */

export const leaderboardQuerySchema = z.object({
  window: z.enum(['daily', 'weekly', 'all-time']).default('daily'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

/**
 * One row of the **persisted global** leaderboard.
 *
 * Distinct from `leaderboardEntrySchema` in `schemas.ts`, which is the live
 * in-match board pushed over the socket. Same word, different lifetime: that
 * one is a snapshot of a running room, this one is a ranking window that
 * survives the match.
 *
 * `score` is a **string**: leaderboard scores accumulate across a window and a
 * lifetime total can exceed `Number.MAX_SAFE_INTEGER`, so the same rule as
 * lamports applies — JSON has no bigint, and a number would round silently.
 *
 * No `wallet` field. A public ranking that publishes every player's address
 * turns the leaderboard into a targeting list for anyone watching the chain.
 */
export const leaderboardRowSchema = z.object({
  rank: z.number().int().positive(),
  userId: playerIdSchema,
  nickname: nicknameSchema.nullable(),
  score: z.string(),
  gamesPlayed: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  kills: z.number().int().nonnegative(),
});

export const leaderboardResponseSchema = z.object({
  window: z.string(),
  /** Which bucket these rankings belong to, e.g. `2026-07-30` or `2026-W31`. */
  periodKey: z.string(),
  entries: z.array(leaderboardRowSchema),
  total: z.number().int().nonnegative(),
});

/* ---- Match / settlement ------------------------------------------------ */

export const matchResultSchema = z.object({
  matchId: matchIdSchema,
  roomId: roomIdSchema,
  mode: gameModeSchema,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  placements: z.array(
    z.object({
      playerId: playerIdSchema,
      wallet: walletAddressSchema,
      placement: z.number().int().positive(),
      score: z.number().int().nonnegative(),
      kills: z.number().int().nonnegative(),
    }),
  ),
  /** Set once the payout transaction is confirmed on Solana. */
  settlementSignature: z.string().nullable(),
});

/* ---- Envelope ---------------------------------------------------------- */

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  uptimeSeconds: z.number(),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])),
});

/* ---- Wallet: deposits and withdrawals ---------------------------------- */

/**
 * Amounts cross the wire as decimal strings, not numbers.
 *
 * Lamport values exceed `Number.MAX_SAFE_INTEGER` above ~9M SOL, and JSON has
 * no bigint. A string survives the round trip exactly; a number silently
 * corrupts at the top of the range.
 */
export const lamportsSchema = z
  .string()
  .regex(/^\d{1,20}$/, 'Amount must be a non-negative integer string of lamports')
  .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n, 'Amount exceeds u64');

export const depositIntentRequestSchema = z.object({
  amount: lamportsSchema,
});

export const depositIntentResponseSchema = z.object({
  depositId: z.uuid(),
  /** Echoed back so the client signs the exact figure the server recorded. */
  amount: lamportsSchema,
  /** Custody vault the lamports must land in. */
  poolAddress: walletAddressSchema,
  programId: walletAddressSchema,
  /** After this, the intent is abandoned and a new one must be created. */
  expiresAt: z.iso.datetime(),
});

export const depositConfirmRequestSchema = z.object({
  depositId: z.uuid(),
  /** Solana transaction signature the client just sent. */
  signature: z.string().min(64).max(96),
});

export const depositStatusSchema = z.enum(['PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED']);

export const depositSchema = z.object({
  id: z.uuid(),
  status: depositStatusSchema,
  amount: lamportsSchema,
  signature: z.string().nullable(),
  confirmations: z.number().int().nonnegative(),
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  confirmedAt: z.iso.datetime().nullable(),
});

export const withdrawalQuoteRequestSchema = z.object({
  amount: lamportsSchema,
});

/** What the player will actually receive, computed the same way as on-chain. */
export const withdrawalQuoteResponseSchema = z.object({
  gross: lamportsSchema,
  fee: lamportsSchema,
  net: lamportsSchema,
  feeBps: z.number().int().nonnegative(),
  spendableBalance: lamportsSchema,
});

export const withdrawalIntentRequestSchema = z.object({
  amount: lamportsSchema,
});

export const withdrawalIntentResponseSchema = z.object({
  withdrawalId: z.uuid(),
  gross: lamportsSchema,
  fee: lamportsSchema,
  net: lamportsSchema,
  programId: walletAddressSchema,
  expiresAt: z.iso.datetime(),
  /** True when the amount tripped a review threshold and is not yet signable. */
  requiresReview: z.boolean(),
});

export const withdrawalConfirmRequestSchema = z.object({
  withdrawalId: z.uuid(),
  signature: z.string().min(64).max(96),
});

export const withdrawalStatusSchema = z.enum([
  'REQUESTED',
  'PENDING_REVIEW',
  'APPROVED',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'REJECTED',
]);

export const withdrawalSchema = z.object({
  id: z.uuid(),
  status: withdrawalStatusSchema,
  amount: lamportsSchema,
  fee: lamportsSchema,
  signature: z.string().nullable(),
  failureReason: z.string().nullable(),
  requestedAt: z.iso.datetime(),
  confirmedAt: z.iso.datetime().nullable(),
});

export const walletBalanceResponseSchema = z.object({
  /** Mirror of the on-chain custody balance. */
  balance: lamportsSchema,
  /** Committed to in-flight rooms or withdrawals. */
  reserved: lamportsSchema,
  /** balance - reserved. What the player may actually spend. */
  spendable: lamportsSchema,
  /** Chain-derived balance, when a read succeeded. Null if RPC was unavailable. */
  onChainBalance: lamportsSchema.nullable(),
  /** True when the mirror and the chain disagree — the ledger needs attention. */
  drifted: z.boolean(),
});

export const walletTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
  type: z
    .enum(['DEPOSIT', 'WITHDRAWAL', 'ENTRY_FEE', 'PAYOUT', 'RAKE', 'REWARD', 'REFUND'])
    .optional(),
});

export const walletTransactionSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  direction: z.enum(['CREDIT', 'DEBIT']),
  status: z.enum(['PENDING', 'POSTED', 'REVERSED']),
  amount: lamportsSchema,
  balanceAfter: lamportsSchema,
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const walletTransactionsResponseSchema = z.object({
  transactions: z.array(walletTransactionSchema),
  nextCursor: z.string().nullable(),
});

/* ---- Matchmaking lobbies ------------------------------------------------ */

export const lobbyStatusSchema = z.enum(['waiting', 'countdown', 'launching', 'closed']);

export const lobbySummarySchema = z.object({
  tierId: z.string(),
  name: z.string(),
  description: z.string(),
  entryFeeLamports: lamportsSchema,
  status: lobbyStatusSchema,
  playerCount: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
  minPlayers: z.number().int().positive(),
  /** Seat limit, or null when the room takes any number of players. */
  maxPlayers: z.number().int().positive().nullable(),
  /** Seconds left on the countdown, or null when none is running. */
  countdownSeconds: z.number().int().nonnegative().nullable(),
  joinable: z.boolean(),
  gameId: z.uuid().nullable(),
});

export const lobbyListResponseSchema = z.object({
  lobbies: z.array(lobbySummarySchema),
  /** Tier the caller is currently queued in, if any. */
  currentTierId: z.string().nullable(),
  /**
   * A match that has launched and is holding a seat for the caller.
   *
   * The client used to detect its match starting by watching for the lobby to
   * enter `launching`. That state lasts a single moment — the lobby launches
   * and immediately reopens for the next round — so a poll every two seconds
   * routinely stepped straight over it, and the player sat on the room board
   * while the ticket reserved for them expired sixty seconds later.
   *
   * This is the same event expressed as a state that persists for as long as
   * the seat is held, which is what makes it observable by polling at all.
   */
  pendingMatch: z
    .object({
      tierId: z.string(),
      gameId: z.string(),
    })
    .nullable()
    .default(null),
});

export const lobbyJoinRequestSchema = z.object({
  tierId: z.string().min(1).max(32),
  nickname: nicknameSchema,
});

export const lobbyRejectionSchema = z.enum([
  'lobby-full',
  'already-joined',
  'not-joined',
  'lobby-launching',
  'lobby-closed',
]);

export const lobbyActionResponseSchema = z.object({
  ok: z.boolean(),
  rejected: lobbyRejectionSchema.nullable(),
  lobby: lobbySummarySchema.nullable(),
  /** Present once the lobby launched and this player has a seat. */
  ticket: matchTicketSchema.nullable(),
});

export const lobbyReadyRequestSchema = z.object({
  tierId: z.string().min(1).max(32),
  ready: z.boolean(),
});

/* ---- Match wallets ------------------------------------------------------ */

/**
 * The wallet holding one match's prize pot.
 *
 * Every match gets its own address, derived from its own id, so a pot is never
 * commingled between matches and a player can point at the exact account their
 * entry fee went into.
 *
 * The three amounts are deliberately separate, because collapsing them into one
 * "pot" number would misreport the state for most of a lobby's life:
 *
 *  - `committedLamports` is reserved against queued players' balances but has
 *    not moved. It is what the pot *will* be if everyone currently queued still
 *    starts — an estimate, and it falls when someone leaves.
 *  - `balanceLamports` is what the wallet holds right now. Zero until the match
 *    starts, because entry fees are consumed at launch rather than at join, and
 *    back to zero once the winner is paid.
 *  - `prizeLamports` is what the winner actually receives: the balance less the
 *    house rake.
 */
export const matchWalletSchema = z.object({
  tierId: z.string(),
  /** Null between matches, when no game exists for this tier yet. */
  gameId: z.uuid().nullable(),
  /** The per-match vault address. Null for free rooms, which hold no funds. */
  address: z.string().nullable(),
  /** Held by the match wallet right now. */
  balanceLamports: lamportsSchema,
  /** Reserved by queued players, not yet moved into the wallet. */
  committedLamports: lamportsSchema,
  /** `balanceLamports` less the rake — what the last surviving snake wins. */
  prizeLamports: lamportsSchema,
  /** House cut in basis points. 1000 = 10%. */
  rakeBps: z.number().int().nonnegative(),
  /**
   * Whether the vault is live on chain.
   *
   * False means the address is derived but not yet initialised, so the pot is
   * tracked in the platform ledger only. Surfaced rather than hidden: a player
   * looking the address up on an explorer would otherwise find an empty account
   * and reasonably conclude the money was gone.
   */
  onChain: z.boolean(),
});

export const matchWalletListResponseSchema = z.object({
  wallets: z.array(matchWalletSchema),
});

/* ---- Match history ------------------------------------------------------ */

export const matchHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  mode: gameModeSchema.optional(),
});

export const matchHistoryEntrySchema = z.object({
  id: z.uuid(),
  gameId: z.uuid(),
  roomId: z.uuid(),
  mode: z.string(),
  region: z.string(),
  placement: z.number().int().positive().nullable(),
  score: z.number().int().nonnegative(),
  kills: z.number().int().nonnegative(),
  survivedMs: z.number().int().nonnegative(),
  entryLamports: lamportsSchema,
  payoutLamports: lamportsSchema,
  /** payout - entry. Signed, so a loss is negative. */
  netLamports: z.string(),
  playedAt: z.iso.datetime(),
});

export const matchHistoryResponseSchema = z.object({
  matches: z.array(matchHistoryEntrySchema),
  nextCursor: z.string().nullable(),
  totals: z.object({
    played: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    kills: z.number().int().nonnegative(),
    netLamports: z.string(),
  }),
});
