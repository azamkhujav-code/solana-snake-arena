'use client';

import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ConfirmedSignatureInfo } from '@solana/web3.js';

import { useWalletStore } from '@/stores/wallet-store';

export interface HistoryEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
  success: boolean;
  /** Net lamport change for the connected wallet. Negative when spending. */
  delta: bigint;
  fee: bigint;
  /** Program ids touched, for labelling the row. */
  programIds: string[];
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Signature to pass as `before` for the next page, or null at the end. */
  nextCursor: string | null;
}

const PAGE_SIZE = 20;

/**
 * Paginated transaction history for the connected wallet.
 *
 * Two calls per page by necessity: `getSignaturesForAddress` returns only
 * signatures and status, so the parsed transactions are fetched in one batch to
 * derive the actual lamport movement. Doing that per-row instead would be N+1
 * against a rate-limited RPC.
 *
 * The delta comes from pre/post balances rather than from parsed instructions,
 * because this program moves lamports inside CPIs that never appear as
 * top-level System Program transfers.
 */
export function useTransactionHistory(options: { enabled?: boolean } = {}) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const cluster = useWalletStore((state) => state.cluster);

  const address = publicKey?.toBase58() ?? null;

  return useInfiniteQuery<HistoryPage, Error, HistoryPage[], readonly unknown[], string | null>({
    queryKey: ['tx-history', cluster, address],
    enabled: (options.enabled ?? true) && publicKey !== null,
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 30_000,
    queryFn: async ({ pageParam }): Promise<HistoryPage> => {
      if (!publicKey) return { entries: [], nextCursor: null };

      const signatures: ConfirmedSignatureInfo[] = await connection.getSignaturesForAddress(
        publicKey,
        {
          limit: PAGE_SIZE,
          ...(pageParam ? { before: pageParam } : {}),
        },
        'confirmed',
      );

      if (signatures.length === 0) return { entries: [], nextCursor: null };

      const parsed = await connection.getParsedTransactions(
        signatures.map((entry) => entry.signature),
        { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
      );

      const owner = publicKey.toBase58();

      const entries: HistoryEntry[] = signatures.map((info, index) => {
        const transaction = parsed[index];
        let delta = 0n;
        let fee = 0n;
        const programIds = new Set<string>();

        if (transaction?.meta) {
          fee = BigInt(transaction.meta.fee);

          const keys = transaction.transaction.message.accountKeys;
          const ownerIndex = keys.findIndex((key) => key.pubkey.toBase58() === owner);

          if (ownerIndex >= 0) {
            const pre = BigInt(transaction.meta.preBalances[ownerIndex] ?? 0);
            const post = BigInt(transaction.meta.postBalances[ownerIndex] ?? 0);
            delta = post - pre;
          }

          for (const instruction of transaction.transaction.message.instructions) {
            programIds.add(instruction.programId.toBase58());
          }
        }

        return {
          signature: info.signature,
          slot: info.slot,
          blockTime: info.blockTime ?? null,
          success: info.err === null,
          delta,
          fee,
          programIds: [...programIds],
        };
      });

      // A short final page means there is nothing older to fetch.
      const nextCursor =
        signatures.length < PAGE_SIZE
          ? null
          : (signatures[signatures.length - 1]?.signature ?? null);

      return { entries, nextCursor };
    },
    select: (data) => data.pages,
  });
}
