import { z } from 'zod';

import { lamportsSchema } from './rest.js';

/**
 * Admin dashboard contracts.
 *
 * Kept in their own module rather than mixed into `rest.ts` because the
 * audience is different: these describe an internal operator tool, and nothing
 * here should ever be reachable by a player token. Separating them makes it
 * obvious at review time when a player-facing route accidentally imports an
 * admin shape.
 *
 * Amounts are **signed** decimal strings here, unlike the player API. An
 * operator needs to see a negative balance — the EXTERNAL pool account is
 * legitimately negative, and a drift figure is meaningless without its sign.
 */
export const signedLamportsSchema = z
  .string()
  .regex(/^-?\d{1,20}$/, 'Must be an integer string of lamports, optionally negative');

/* ---- Shared ------------------------------------------------------------ */

/**
 * Keyset pagination, as everywhere else in the API.
 *
 * `cursor` is an opaque row id. Admin tables are the one place where a human
 * genuinely wants to jump around, but offset paging over the ledger is exactly
 * the query that falls over, so the answer is filters rather than page numbers.
 */
export const adminPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const adminRangeQuerySchema = z.object({
  /** Inclusive lower bound. Defaults to 24h ago at the route level. */
  from: z.iso.datetime().optional(),
  /** Exclusive upper bound. Defaults to now. */
  to: z.iso.datetime().optional(),
});

/* ---- Statistics -------------------------------------------------------- */

/**
 * The overview numbers.
 *
 * Every figure is scoped to an explicit window rather than "all time" — a
 * lifetime total on a dashboard tells an operator nothing about whether the
 * platform is healthy *now*, which is the only question the page exists to
 * answer.
 */
export const adminStatsSchema = z.object({
  windowHours: z.number().int().positive(),
  players: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    newInWindow: z.number().int().nonnegative(),
    banned: z.number().int().nonnegative(),
  }),
  games: z.object({
    inWindow: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    awaitingSettlement: z.number().int().nonnegative(),
    failedSettlement: z.number().int().nonnegative(),
  }),
  money: z.object({
    depositedInWindow: lamportsSchema,
    withdrawnInWindow: lamportsSchema,
    wageredInWindow: lamportsSchema,
    rakeInWindow: lamportsSchema,
    /** Deposits minus withdrawals over the window. Signed: outflow is normal. */
    netFlowInWindow: signedLamportsSchema,
  }),
  custody: z.object({
    /** Everything the platform holds on behalf of players. */
    playerBalances: lamportsSchema,
    treasury: lamportsSchema,
    rake: lamportsSchema,
    rewards: lamportsSchema,
    escrowed: lamportsSchema,
  }),
  /** Non-null only when something needs a human. */
  alerts: z.array(
    z.object({
      severity: z.enum(['warn', 'critical']),
      code: z.string(),
      message: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
});

export const adminTimeSeriesSchema = z.object({
  metric: z.string(),
  bucket: z.enum(['hour', 'day']),
  points: z.array(z.object({ t: z.iso.datetime(), value: z.string() })),
});

/* ---- Treasury and pool accounts ---------------------------------------- */

export const poolAccountSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['USER_CUSTODY', 'GAME_ESCROW', 'TREASURY', 'RAKE', 'REWARDS', 'EXTERNAL']),
  name: z.string(),
  ownerUserId: z.uuid().nullable(),
  gameId: z.uuid().nullable(),
  balanceLamports: signedLamportsSchema,
  reservedLamports: lamportsSchema,
  /** balance - reserved. Negative would mean over-reservation, which is a bug. */
  spendableLamports: signedLamportsSchema,
  onchainAddress: z.string().nullable(),
  version: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});

export const adminPoolAccountsResponseSchema = z.object({
  accounts: z.array(poolAccountSchema),
  nextCursor: z.string().nullable(),
  /** Totals across *all* matching accounts, not just this page. */
  totals: z.object({
    balanceLamports: signedLamportsSchema,
    reservedLamports: lamportsSchema,
    count: z.number().int().nonnegative(),
  }),
});

/**
 * The reconciliation view — the reason a treasury page is worth building.
 *
 * Three numbers that must agree: what the chain holds, what the ledger says
 * the platform owes, and what the pool balances add up to. Any disagreement is
 * either a bug or a theft, and both need to be visible within minutes.
 */
export const adminTreasurySchema = z.object({
  onchain: z.object({
    /** Null when the RPC is unreachable — an outage must not read as zero. */
    treasuryLamports: lamportsSchema.nullable(),
    poolLamports: lamportsSchema.nullable(),
    fetchedAt: z.iso.datetime().nullable(),
    error: z.string().nullable(),
  }),
  offchain: z.object({
    playerCustodyLamports: lamportsSchema,
    escrowLamports: lamportsSchema,
    treasuryLamports: lamportsSchema,
    rakeLamports: lamportsSchema,
    rewardsLamports: lamportsSchema,
    /** Sum of every pool balance including EXTERNAL, which nets to zero. */
    poolTotalLamports: signedLamportsSchema,
    /** Net of every posted ledger entry. Must equal poolTotal. */
    ledgerTotalLamports: signedLamportsSchema,
  }),
  invariants: z.object({
    /** poolTotal - ledgerTotal. Non-zero means the ledger and balances diverged. */
    ledgerDriftLamports: signedLamportsSchema,
    ledgerBalanced: z.boolean(),
    /** onchain pool - what the platform owes players. Negative is insolvency. */
    custodyCoverageLamports: signedLamportsSchema.nullable(),
    custodySolvent: z.boolean().nullable(),
    /** Entry groups whose legs do not sum to zero. Should always be empty. */
    imbalancedEntryGroups: z.array(
      z.object({ entryGroupId: z.uuid(), driftLamports: signedLamportsSchema }),
    ),
  }),
});

/* ---- Transactions (the ledger) ----------------------------------------- */

export const adminTransactionSchema = z.object({
  id: z.uuid(),
  entryGroupId: z.uuid(),
  type: z.string(),
  direction: z.enum(['CREDIT', 'DEBIT']),
  status: z.enum(['PENDING', 'POSTED', 'REVERSED']),
  amountLamports: lamportsSchema,
  /** Signed by direction, so a column of these sums to the net movement. */
  signedAmountLamports: signedLamportsSchema,
  balanceAfterLamports: signedLamportsSchema,
  userId: z.uuid().nullable(),
  username: z.string().nullable(),
  poolAccountId: z.uuid(),
  poolAccountName: z.string(),
  gameId: z.uuid().nullable(),
  depositId: z.uuid().nullable(),
  withdrawalId: z.uuid().nullable(),
  rewardId: z.uuid().nullable(),
  idempotencyKey: z.string(),
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const adminTransactionsResponseSchema = z.object({
  transactions: z.array(adminTransactionSchema),
  nextCursor: z.string().nullable(),
});

/** All legs of one logical transfer, which must sum to zero. */
export const adminEntryGroupSchema = z.object({
  entryGroupId: z.uuid(),
  legs: z.array(adminTransactionSchema),
  driftLamports: signedLamportsSchema,
  balanced: z.boolean(),
});

export const adminTransactionsQuerySchema = adminPageQuerySchema
  .extend(adminRangeQuerySchema.shape)
  .extend({
    type: z
      .enum([
        'DEPOSIT',
        'WITHDRAWAL',
        'ENTRY_FEE',
        'PAYOUT',
        'RAKE',
        'REWARD',
        'REFUND',
        'TRANSFER',
        'ADJUSTMENT',
      ])
      .optional(),
    status: z.enum(['PENDING', 'POSTED', 'REVERSED']).optional(),
    userId: z.uuid().optional(),
    poolAccountId: z.uuid().optional(),
    gameId: z.uuid().optional(),
    /** Minimum absolute amount — the usual way to find the movement that matters. */
    minLamports: lamportsSchema.optional(),
  });

/* ---- Players ----------------------------------------------------------- */

export const adminPlayerSchema = z.object({
  id: z.uuid(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  role: z.enum(['PLAYER', 'MODERATOR', 'ADMIN']),
  status: z.enum(['ACTIVE', 'SHADOWBANNED', 'BANNED', 'CLOSED']),
  gamesPlayed: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  kills: z.number().int().nonnegative(),
  bestScore: z.number().int().nonnegative(),
  lifetimeWagered: lamportsSchema,
  lifetimeWon: lamportsSchema,
  /** Won minus wagered. Signed: most players are net negative. */
  netLamports: signedLamportsSchema,
  balanceLamports: lamportsSchema,
  reservedLamports: lamportsSchema,
  primaryWallet: z.string().nullable(),
  walletCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
});

export const adminPlayersResponseSchema = z.object({
  players: z.array(adminPlayerSchema),
  nextCursor: z.string().nullable(),
});

export const adminPlayersQuerySchema = adminPageQuerySchema.extend({
  /** Matches username or wallet address. */
  q: z.string().min(1).max(64).optional(),
  status: z.enum(['ACTIVE', 'SHADOWBANNED', 'BANNED', 'CLOSED']).optional(),
  role: z.enum(['PLAYER', 'MODERATOR', 'ADMIN']).optional(),
  sort: z.enum(['recent', 'balance', 'wagered', 'games']).default('recent'),
});

/**
 * Moderation.
 *
 * `reason` is required and not merely logged — it is written to the audit trail
 * and is what makes a ban reviewable months later. An unexplained ban is
 * indistinguishable from an abusive one.
 */
export const adminPlayerStatusRequestSchema = z.object({
  status: z.enum(['ACTIVE', 'SHADOWBANNED', 'BANNED']),
  reason: z.string().min(8).max(512),
});

export const adminPlayerRoleRequestSchema = z.object({
  role: z.enum(['PLAYER', 'MODERATOR', 'ADMIN']),
  reason: z.string().min(8).max(512),
});

/**
 * A manual balance correction.
 *
 * Deliberately awkward to call: a signed amount, a mandatory reason, and an
 * idempotency key the caller has to invent. Adjusting a player's money by hand
 * should feel like filing paperwork, because that is what it is.
 */
export const adminAdjustBalanceRequestSchema = z.object({
  amountLamports: signedLamportsSchema.refine((v) => BigInt(v) !== 0n, 'Amount must be non-zero'),
  reason: z.string().min(8).max(512),
  idempotencyKey: z.string().min(8).max(128),
});

export const adminAdjustBalanceResponseSchema = z.object({
  entryGroupId: z.uuid(),
  balanceLamports: lamportsSchema,
  appliedLamports: signedLamportsSchema,
  /** True when the idempotency key had already been used — nothing moved. */
  alreadyApplied: z.boolean(),
});

/* ---- Games ------------------------------------------------------------- */

export const adminGameSchema = z.object({
  id: z.uuid(),
  roomId: z.uuid(),
  roomCode: z.string(),
  mode: z.string(),
  region: z.string(),
  status: z.string(),
  settlementStatus: z.string(),
  settlementSignature: z.string().nullable(),
  playerCount: z.number().int().nonnegative(),
  potLamports: lamportsSchema,
  payoutLamports: lamportsSchema,
  rakeLamports: lamportsSchema,
  /** What the game's escrow still holds. Non-zero on a finished game means the
   *  pot was neither paid out nor refunded — the lamports are stranded. */
  unaccountedLamports: signedLamportsSchema,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});

export const adminGamesResponseSchema = z.object({
  games: z.array(adminGameSchema),
  nextCursor: z.string().nullable(),
});

export const adminGamesQuerySchema = adminPageQuerySchema
  .extend(adminRangeQuerySchema.shape)
  .extend({
    status: z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED']).optional(),
    // Mirrors the `SettlementStatus` enum exactly. NOT_REQUIRED is the
    // free-to-play case — nothing to settle, which is different from settled.
    settlementStatus: z
      .enum(['NOT_REQUIRED', 'PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED'])
      .optional(),
    roomId: z.uuid().optional(),
    /** Only games whose money does not add up. The triage filter. */
    unaccountedOnly: z.coerce.boolean().default(false),
  });

export const adminGameDetailSchema = adminGameSchema.extend({
  players: z.array(
    z.object({
      userId: z.uuid(),
      username: z.string().nullable(),
      placement: z.number().int().nullable(),
      score: z.number().int(),
      kills: z.number().int(),
      survivedMs: z.number().int(),
      entryLamports: lamportsSchema,
      payoutLamports: lamportsSchema,
      state: z.string(),
    }),
  ),
  ledger: z.array(adminTransactionSchema),
});

/**
 * Abandoning a match and giving the entry fees back.
 *
 * The reason is mandatory and goes to the audit trail. Unlike a settlement
 * retry this moves money, so it is the one game-level write that has to be
 * explicable months later.
 */
export const adminGameCancelRequestSchema = z.object({
  reason: z.string().min(8).max(512),
});

export const adminGameCancelResponseSchema = z.object({
  game: adminGameSchema,
  /**
   * What this call posted. Empty on a repeat — the refund is idempotent per
   * player, so a second click reports the game as cancelled and pays nothing.
   */
  refunds: z.array(z.object({ userId: z.uuid(), lamports: lamportsSchema })),
  refundedLamports: lamportsSchema,
  /** True when this request is what moved the game to CANCELLED. */
  cancelled: z.boolean(),
});

/* ---- Rooms ------------------------------------------------------------- */

export const adminRoomSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string().nullable(),
  mode: z.string(),
  region: z.string(),
  status: z.string(),
  visibility: z.string(),
  maxPlayers: z.number().int().positive().nullable(),
  entryFeeLamports: lamportsSchema,
  rakeBps: z.number().int().nonnegative(),
  gamesPlayed: z.number().int().nonnegative(),
  /** Lifetime pot across every game in this room. */
  volumeLamports: lamportsSchema,
  createdAt: z.iso.datetime(),
});

export const adminRoomsResponseSchema = z.object({ rooms: z.array(adminRoomSchema) });

export const adminRoomUpdateResponseSchema = z.object({
  id: z.uuid(),
  status: z.string(),
});

/**
 * Room configuration changes.
 *
 * `entryFeeLamports` and `rakeBps` are intentionally absent. Changing the price
 * of a room that has players queued in it changes the deal they agreed to; the
 * safe operation is to close the room and open a new one, which leaves an
 * honest history behind.
 */
export const adminRoomUpdateRequestSchema = z.object({
  status: z.enum(['ACTIVE', 'DRAINING', 'CLOSED']).optional(),
  name: z.string().min(1).max(64).nullish(),
  /** Null clears the seat limit. 65,535 is where the on-chain u16 runs out. */
  maxPlayers: z.number().int().min(2).max(65_535).nullable().optional(),
  reason: z.string().min(8).max(512),
});

/* ---- Audit log --------------------------------------------------------- */

export const adminAuditEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  severity: z.enum(['INFO', 'WARN', 'CRITICAL']),
  /** The admin who acted. Null for system-generated entries. */
  actorId: z.uuid().nullable(),
  /** The player acted upon. */
  userId: z.uuid().nullable(),
  username: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.iso.datetime(),
});

export const adminAuditResponseSchema = z.object({
  entries: z.array(adminAuditEntrySchema),
  nextCursor: z.string().nullable(),
});

export const adminAuditQuerySchema = adminPageQuerySchema
  .extend(adminRangeQuerySchema.shape)
  .extend({
    action: z.string().min(1).max(64).optional(),
    severity: z.enum(['INFO', 'WARN', 'CRITICAL']).optional(),
    actorId: z.uuid().optional(),
    userId: z.uuid().optional(),
  });

export type AdminStats = z.infer<typeof adminStatsSchema>;
export type AdminTreasury = z.infer<typeof adminTreasurySchema>;
export type AdminPlayer = z.infer<typeof adminPlayerSchema>;
export type AdminGame = z.infer<typeof adminGameSchema>;
export type AdminRoom = z.infer<typeof adminRoomSchema>;
export type AdminTransaction = z.infer<typeof adminTransactionSchema>;
export type AdminPoolAccount = z.infer<typeof poolAccountSchema>;
export type AdminAuditEntry = z.infer<typeof adminAuditEntrySchema>;
