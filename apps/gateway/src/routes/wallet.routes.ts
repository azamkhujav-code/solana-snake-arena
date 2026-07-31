import {
  depositConfirmRequestSchema,
  depositIntentRequestSchema,
  depositIntentResponseSchema,
  walletBalanceResponseSchema,
  walletTransactionsQuerySchema,
  walletTransactionsResponseSchema,
  withdrawalConfirmRequestSchema,
  withdrawalIntentRequestSchema,
  withdrawalIntentResponseSchema,
  withdrawalQuoteRequestSchema,
  withdrawalQuoteResponseSchema,
} from '@arena/protocol';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { badRequest, notFound } from '../lib/errors.js';
import { confirmDeposit, createDepositIntent } from '../services/deposit.service.js';
import { getOrCreateCustodyAccount, spendable } from '../services/ledger.js';
import {
  confirmWithdrawal,
  createWithdrawalIntent,
  quoteWithdrawal,
} from '../services/withdrawal.service.js';

/** Lamport values leave the API as strings; JSON has no bigint. */
const str = (value: bigint): string => value.toString();

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  const deps = () => ({
    prisma: app.prisma,
    solana: app.solana,
    acquireLock: app.acquireLock,
  });

  /** Resolves the caller's primary verified wallet. */
  async function primaryWallet(userId: string) {
    const wallet = await app.prisma.wallet.findFirst({
      where: { userId, verifiedAt: { not: null } },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, address: true },
    });
    if (!wallet) throw notFound('Verified wallet');
    return wallet;
  }

  // ---- Balance ----------------------------------------------------------

  api.get(
    '/wallet/balance',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['wallet'],
        summary: 'Custody balance',
        description: [
          '`balance` is everything held for the caller; `reserved` is the part',
          'locked behind a pending withdrawal or an escrowed entry fee. Spend',
          'against `spendable` — the other two will let you promise money that is',
          'already committed.',
          '',
          '`onChainBalance` is the whole pool vault, shared by every player, so it',
          'is not comparable to this caller’s balance. It is null when the RPC is',
          'unreachable: an outage should not blank the UI.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        response: { 200: walletBalanceResponseSchema },
      },
    },
    async (request) => {
      const custody = await getOrCreateCustodyAccount(app.prisma, request.user.sub);

      // Best-effort chain read. An RPC outage must not block the UI from
      // showing the mirrored balance, so a failure degrades to null.
      let onChainBalance: bigint | null = null;
      try {
        const balances = await app.solana.getVaultBalances();
        onChainBalance = balances.pool;
      } catch (error) {
        request.log.warn({ err: error }, 'could not read on-chain pool balance');
      }

      return {
        balance: str(custody.balanceLamports),
        reserved: str(custody.reservedLamports),
        spendable: str(spendable(custody)),
        onChainBalance: onChainBalance === null ? null : str(onChainBalance),
        // The pool holds every player's funds, so a per-user comparison is not
        // meaningful here. Drift is detected by the reconciler across the whole
        // ledger; this field stays false until that job reports otherwise.
        drifted: false,
      };
    },
  );

  // ---- Deposits ---------------------------------------------------------

  api.post(
    '/wallet/deposits',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['deposits'],
        summary: 'Open a deposit intent',
        description: [
          'Step 1 of 2. Reserves a deposit record and returns the pool address to',
          'send to. **No funds move here** — the client builds and signs the',
          'transfer, then calls `/wallet/deposits/confirm` with the signature.',
          '',
          'The intent expires. A transfer sent after expiry is still recoverable by',
          'the reconciler, but confirmation through this endpoint will reject it.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        body: depositIntentRequestSchema,
        response: { 200: depositIntentResponseSchema },
      },
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    },
    async (request) => {
      const wallet = await primaryWallet(request.user.sub);
      const amount = BigInt(request.body.amount);

      const intent = await createDepositIntent(deps(), {
        userId: request.user.sub,
        walletId: wallet.id,
        amount,
      });

      return {
        depositId: intent.depositId,
        amount: str(intent.amount),
        poolAddress: intent.poolAddress,
        programId: intent.programId,
        expiresAt: intent.expiresAt.toISOString(),
      };
    },
  );

  api.post(
    '/wallet/deposits/confirm',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['deposits'],
        summary: 'Confirm a deposit with its signature',
        description: [
          'Step 2 of 2. Fetches the transaction from the chain, checks it really',
          'paid the pool the intended amount, and credits custody.',
          '',
          'Safe to call repeatedly: crediting is keyed on the signature by a unique',
          'constraint, so a retry after a dropped response cannot double-credit.',
          '',
          '`pending` means the transaction is not confirmed yet — poll, do not',
          'resend. `failed` carries a `reason` and is terminal for that signature.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        body: depositConfirmRequestSchema,
        response: {
          200: z.object({
            status: z.enum(['confirmed', 'pending', 'failed']),
            creditedLamports: z.string().nullable(),
            reason: z.string().nullable(),
          }),
        },
      },
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (request) => {
      const outcome = await confirmDeposit(deps(), {
        userId: request.user.sub,
        depositId: request.body.depositId,
        signature: request.body.signature,
      });

      return {
        status: outcome.status,
        creditedLamports: outcome.status === 'confirmed' ? str(outcome.creditedLamports) : null,
        reason: outcome.status === 'confirmed' ? null : outcome.reason,
      };
    },
  );

  // ---- Withdrawals ------------------------------------------------------

  api.post(
    '/wallet/withdrawals/quote',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['withdrawals'],
        summary: 'Price a withdrawal before committing to it',
        description:
          'Read-only: reserves nothing and moves nothing. Exists so the fee is shown before the player commits, rather than appearing as a surprise deduction afterwards.',
        security: [{ bearerAuth: [] }],
        body: withdrawalQuoteRequestSchema,
        response: { 200: withdrawalQuoteResponseSchema },
      },
    },
    async (request) => {
      const quote = await quoteWithdrawal(
        { ...deps(), withdrawalFeeBps: app.withdrawalFeeBps },
        { userId: request.user.sub, amount: BigInt(request.body.amount) },
      );

      return {
        gross: str(quote.gross),
        fee: str(quote.fee),
        net: str(quote.net),
        feeBps: quote.feeBps,
        spendableBalance: str(quote.spendableBalance),
      };
    },
  );

  api.post(
    '/wallet/withdrawals',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['withdrawals'],
        summary: 'Open a withdrawal intent',
        description: [
          'Reserves the amount against the caller’s custody balance so it cannot',
          'be spent twice while the payout is in flight. Unlike a deposit, the',
          'reservation happens **now** — the money is committed before the chain',
          'sees anything.',
          '',
          'When `requiresReview` is true the payout is held for manual approval',
          'and no signature will follow; the reservation stands until it clears.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        body: withdrawalIntentRequestSchema,
        response: { 200: withdrawalIntentResponseSchema },
      },
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request) => {
      const wallet = await primaryWallet(request.user.sub);
      const amount = BigInt(request.body.amount);
      if (amount <= 0n) throw badRequest('Amount must be positive');

      const intent = await createWithdrawalIntent(
        { ...deps(), withdrawalFeeBps: app.withdrawalFeeBps },
        { userId: request.user.sub, walletId: wallet.id, amount },
      );

      return {
        withdrawalId: intent.withdrawalId,
        gross: str(intent.gross),
        fee: str(intent.fee),
        net: str(intent.net),
        programId: intent.programId,
        expiresAt: intent.expiresAt.toISOString(),
        requiresReview: intent.requiresReview,
      };
    },
  );

  api.post(
    '/wallet/withdrawals/confirm',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['withdrawals'],
        summary: 'Settle a withdrawal',
        description: [
          'Converts the reservation into a posted debit once the payout confirms',
          'on chain, or releases it back to spendable on failure.',
          '',
          'Idempotent on the withdrawal id. A `pending` response means keep',
          'polling — resending will not make a second payout, but it will not',
          'speed one up either.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        body: withdrawalConfirmRequestSchema,
        response: {
          200: z.object({
            status: z.enum(['confirmed', 'pending', 'failed']),
            signature: z.string().nullable(),
            net: z.string().nullable(),
            fee: z.string().nullable(),
            reason: z.string().nullable(),
          }),
        },
      },
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (request) => {
      const outcome = await confirmWithdrawal(
        { ...deps(), withdrawalFeeBps: app.withdrawalFeeBps },
        {
          userId: request.user.sub,
          withdrawalId: request.body.withdrawalId,
          signature: request.body.signature,
        },
      );

      return {
        status: outcome.status,
        signature: outcome.status === 'confirmed' ? outcome.signature : null,
        net: outcome.status === 'confirmed' ? str(outcome.net) : null,
        fee: outcome.status === 'confirmed' ? str(outcome.fee) : null,
        reason: outcome.status === 'confirmed' ? null : outcome.reason,
      };
    },
  );

  // ---- Ledger history ---------------------------------------------------

  api.get(
    '/wallet/transactions',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['wallet'],
        summary: 'Ledger history',
        description:
          'Every posted movement affecting the caller, newest first, keyset paginated. `balanceAfter` is the running balance at the moment that entry posted, so a statement can be rendered without re-deriving it client-side.',
        security: [{ bearerAuth: [] }],
        querystring: walletTransactionsQuerySchema,
        response: { 200: walletTransactionsResponseSchema },
      },
    },
    async (request) => {
      const { limit, cursor, type } = request.query;

      // Keyset pagination on (createdAt, id). OFFSET degrades badly once the
      // ledger is in the hundreds of millions of rows.
      const rows = await app.prisma.transaction.findMany({
        where: {
          userId: request.user.sub,
          ...(type ? { type } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const page = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

      return {
        transactions: page.map((row) => ({
          id: row.id,
          type: row.type,
          direction: row.direction,
          status: row.status,
          amount: str(row.amountLamports),
          balanceAfter: str(row.balanceAfterLamports),
          description: row.description,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor,
      };
    },
  );
}
