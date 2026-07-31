'use client';

import {
  depositIntentResponseSchema,
  walletBalanceResponseSchema,
  withdrawalIntentResponseSchema,
  withdrawalQuoteResponseSchema,
} from '@arena/protocol';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { z } from 'zod';

import { apiRequest } from '@/lib/api-client';
import { env } from '@/lib/env';
import { balanceQueryKey } from '@/hooks/use-balance';
import { useWalletStore } from '@/stores/wallet-store';

/**
 * Deposit and withdraw, driven from the browser.
 *
 * Both are **player-signed**: the wallet signs the on-chain instruction, so the
 * backend never holds a key that could move a player's funds. The server's role
 * is to record intent beforehand and verify the result afterwards.
 *
 * The instruction is built here rather than fetched pre-serialised from the
 * server. A server-supplied transaction blob is something the user cannot
 * inspect before signing, and it would put the backend in a position to ask for
 * a signature over anything at all.
 */

const ARENA_PROGRAM_ID = new PublicKey(env.arenaProgramId);

const SEEDS = {
  config: Buffer.from('config'),
  pool: Buffer.from('pool'),
  treasury: Buffer.from('treasury'),
  player: Buffer.from('player'),
};

function pda(seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, ARENA_PROGRAM_ID)[0];
}

/**
 * Anchor's instruction discriminator: `sha256("global:<name>")[0..8]`.
 *
 * Uses WebCrypto rather than bundling a hash library — it is built in, and the
 * async signature is why the instruction builders below are async. The same
 * derivation is asserted against @arena/solana's implementation in its tests,
 * so a renamed instruction cannot silently desync the two.
 */
async function discriminator(name: string): Promise<Buffer> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`global:${name}`));
  return Buffer.from(new Uint8Array(digest).slice(0, 8));
}

function encodeU64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

async function buildDepositInstruction(
  player: PublicKey,
  lamports: bigint,
): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: pda([SEEDS.config]), isSigner: false, isWritable: false },
      { pubkey: pda([SEEDS.player, player.toBuffer()]), isSigner: false, isWritable: true },
      { pubkey: pda([SEEDS.pool]), isSigner: false, isWritable: true },
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([await discriminator('deposit'), encodeU64(lamports)]),
  });
}

async function buildWithdrawInstruction(
  player: PublicKey,
  lamports: bigint,
): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: pda([SEEDS.config]), isSigner: false, isWritable: false },
      { pubkey: pda([SEEDS.player, player.toBuffer()]), isSigner: false, isWritable: true },
      { pubkey: pda([SEEDS.pool]), isSigner: false, isWritable: true },
      { pubkey: pda([SEEDS.treasury]), isSigner: false, isWritable: true },
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([await discriminator('withdraw'), encodeU64(lamports)]),
  });
}

const confirmResponseSchema = z.object({
  status: z.enum(['confirmed', 'pending', 'failed']),
  creditedLamports: z.string().nullable(),
  reason: z.string().nullable(),
});

const withdrawConfirmResponseSchema = z.object({
  status: z.enum(['confirmed', 'pending', 'failed']),
  signature: z.string().nullable(),
  net: z.string().nullable(),
  fee: z.string().nullable(),
  reason: z.string().nullable(),
});

export const custodyKeys = {
  balance: ['custody', 'balance'] as const,
  quote: (amount: string) => ['custody', 'quote', amount] as const,
};

/** The platform-side custody balance, as mirrored by the gateway. */
export function useCustodyBalance() {
  const { connected } = useWallet();

  return useQuery({
    queryKey: custodyKeys.balance,
    enabled: connected,
    queryFn: () => apiRequest('/v1/wallet/balance', { schema: walletBalanceResponseSchema }),
    staleTime: 10_000,
  });
}

export type FlowStage =
  'idle' | 'creating-intent' | 'awaiting-signature' | 'sending' | 'confirming' | 'done';

/**
 * Deposit flow.
 *
 * Order matters and is not arbitrary: the intent is recorded **before** the
 * user signs. If the browser dies between signing and confirming, the server
 * still has a PENDING row with the expected amount, and the reconciler can find
 * the transaction and credit it. Creating the record after signing would lose
 * that money silently.
 */
export function useDeposit() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const cluster = useWalletStore((state) => state.cluster);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      lamports,
      onStage,
    }: {
      lamports: bigint;
      onStage?: (stage: FlowStage) => void;
    }) => {
      if (!publicKey) throw new Error('Connect a wallet first');

      onStage?.('creating-intent');
      const intent = await apiRequest('/v1/wallet/deposits', {
        method: 'POST',
        body: { amount: lamports.toString() },
        schema: depositIntentResponseSchema,
      });

      onStage?.('awaiting-signature');
      const instruction = await buildDepositInstruction(publicKey, BigInt(intent.amount));

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const message = new TransactionMessage({
        payerKey: publicKey,
        recentBlockhash: blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), instruction],
      }).compileToV0Message();

      onStage?.('sending');
      const signature = await sendTransaction(new VersionedTransaction(message), connection);

      // Wait locally so the confirm call has something to find. If this times
      // out the money is not lost — the intent is recorded and the reconciler
      // picks it up.
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );

      onStage?.('confirming');
      const result = await apiRequest('/v1/wallet/deposits/confirm', {
        method: 'POST',
        body: { depositId: intent.depositId, signature },
        schema: confirmResponseSchema,
      });

      onStage?.('done');
      return { ...result, signature, depositId: intent.depositId };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: custodyKeys.balance });
      void queryClient.invalidateQueries({
        queryKey: balanceQueryKey(cluster, publicKey?.toBase58() ?? null),
      });
    },
  });
}

/** Quotes the fee split without committing to anything. */
export function useWithdrawalQuote(lamports: bigint | null) {
  const { connected } = useWallet();

  return useQuery({
    queryKey: custodyKeys.quote(lamports?.toString() ?? '0'),
    enabled: connected && lamports !== null && lamports > 0n,
    queryFn: () =>
      apiRequest('/v1/wallet/withdrawals/quote', {
        method: 'POST',
        body: { amount: (lamports ?? 0n).toString() },
        schema: withdrawalQuoteResponseSchema,
      }),
    staleTime: 30_000,
  });
}

/**
 * Withdrawal flow.
 *
 * The intent reserves the funds server-side before the user signs, so the same
 * lamports cannot back a second withdrawal or be wagered while this one is in
 * flight. A withdrawal over the review threshold comes back `requiresReview`
 * and is not signable yet.
 */
export function useWithdraw() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const cluster = useWalletStore((state) => state.cluster);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      lamports,
      onStage,
    }: {
      lamports: bigint;
      onStage?: (stage: FlowStage) => void;
    }) => {
      if (!publicKey) throw new Error('Connect a wallet first');

      onStage?.('creating-intent');
      const intent = await apiRequest('/v1/wallet/withdrawals', {
        method: 'POST',
        body: { amount: lamports.toString() },
        schema: withdrawalIntentResponseSchema,
      });

      if (intent.requiresReview) {
        onStage?.('done');
        return {
          status: 'pending' as const,
          signature: null,
          net: intent.net,
          fee: intent.fee,
          reason: 'This withdrawal is held for review and will be processed manually.',
          withdrawalId: intent.withdrawalId,
        };
      }

      onStage?.('awaiting-signature');
      const instruction = await buildWithdrawInstruction(publicKey, BigInt(intent.gross));

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const message = new TransactionMessage({
        payerKey: publicKey,
        recentBlockhash: blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), instruction],
      }).compileToV0Message();

      onStage?.('sending');
      const signature = await sendTransaction(new VersionedTransaction(message), connection);
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );

      onStage?.('confirming');
      const result = await apiRequest('/v1/wallet/withdrawals/confirm', {
        method: 'POST',
        body: { withdrawalId: intent.withdrawalId, signature },
        schema: withdrawConfirmResponseSchema,
      });

      onStage?.('done');
      return { ...result, withdrawalId: intent.withdrawalId };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: custodyKeys.balance });
      void queryClient.invalidateQueries({
        queryKey: balanceQueryKey(cluster, publicKey?.toBase58() ?? null),
      });
    },
  });
}
