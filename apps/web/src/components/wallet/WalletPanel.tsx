'use client';

import { Button, Panel } from '@arena/ui';
import { useWallet } from '@solana/wallet-adapter-react';

import { useAirdrop, useBalance } from '@/hooks/use-balance';
import { useCluster } from '@/hooks/use-cluster';
import { useTransactionHistory } from '@/hooks/use-transaction-history';
import { explorerAddressUrl, explorerTxUrl, formatSol, shortenAddress } from '@/lib/cluster';

export function WalletBalance() {
  const { publicKey } = useWallet();
  const { lamports, isLoading, refetch } = useBalance();
  const { cluster } = useCluster();
  const { canAirdrop, request } = useAirdrop();

  if (!publicKey) return null;

  return (
    <Panel title="Wallet">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold tabular-nums">
            {isLoading || lamports === undefined ? '—' : formatSol(lamports)}{' '}
            <span className="text-sm font-normal text-slate-400">SOL</span>
          </p>
          <a
            href={explorerAddressUrl(publicKey.toBase58(), cluster)}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            {shortenAddress(publicKey.toBase58(), 6)} ↗
          </a>
        </div>

        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={refetch}>
            Refresh
          </Button>
          {canAirdrop ? (
            <Button size="sm" variant="secondary" onClick={() => void request(1)}>
              Airdrop 1
            </Button>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

export function TransactionHistory() {
  const { publicKey } = useWallet();
  const { cluster } = useCluster();
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useTransactionHistory();

  if (!publicKey) return null;

  const entries = (data ?? []).flatMap((page) => page.entries);

  return (
    <Panel title="Recent activity">
      {isLoading ? <p className="text-sm text-slate-400">Loading…</p> : null}
      {isError ? <p className="text-sm text-rose-400">Could not load history.</p> : null}
      {!isLoading && entries.length === 0 ? (
        <p className="text-sm text-slate-400">No transactions yet.</p>
      ) : null}

      <ul className="divide-y divide-slate-800/80">
        {entries.map((entry) => (
          <li key={entry.signature} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <a
                href={explorerTxUrl(entry.signature, cluster)}
                target="_blank"
                rel="noreferrer noopener"
                className="block truncate font-mono text-xs text-slate-300 hover:text-emerald-400"
              >
                {shortenAddress(entry.signature, 8)}
              </a>
              <p className="text-[11px] text-slate-500">
                {entry.blockTime
                  ? new Date(entry.blockTime * 1000).toLocaleString()
                  : `slot ${entry.slot}`}
                {entry.success ? '' : ' · failed'}
              </p>
            </div>

            <span
              className={`shrink-0 text-sm tabular-nums ${
                entry.delta > 0n
                  ? 'text-emerald-400'
                  : entry.delta < 0n
                    ? 'text-slate-300'
                    : 'text-slate-500'
              }`}
            >
              {entry.delta > 0n ? '+' : ''}
              {formatSol(entry.delta, 6)} SOL
            </span>
          </li>
        ))}
      </ul>

      {hasNextPage ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-3 w-full"
          loading={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          Load more
        </Button>
      ) : null}
    </Panel>
  );
}
