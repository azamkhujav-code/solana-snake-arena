'use client';

import { Button, Panel } from '@arena/ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { useState } from 'react';

import {
  useCustodyBalance,
  useDeposit,
  useWithdraw,
  useWithdrawalQuote,
  type FlowStage,
} from '@/hooks/use-custody';
import { explorerTxUrl, formatSol, LAMPORTS_PER_SOL } from '@/lib/cluster';
import { useBalance } from '@/hooks/use-balance';
import { useCluster } from '@/hooks/use-cluster';
import { useProgramDeployed } from '@/hooks/use-program-status';

const STAGE_LABEL: Record<FlowStage, string> = {
  idle: '',
  'creating-intent': 'Preparing…',
  'awaiting-signature': 'Approve in your wallet…',
  sending: 'Sending…',
  confirming: 'Confirming…',
  done: '',
};

/** Parses a SOL string into lamports without floating point. */
function solToLamports(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d*\.?\d{0,9}$/.test(trimmed) || trimmed === '' || trimmed === '.') return null;

  const [whole = '0', fraction = ''] = trimmed.split('.');
  const padded = fraction.padEnd(9, '0');
  try {
    return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(padded || '0');
  } catch {
    return null;
  }
}

export function CustodyPanel() {
  const { connected } = useWallet();
  const { cluster } = useCluster();
  const { data: balance, isLoading } = useCustodyBalance();

  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState<FlowStage>('idle');
  const [result, setResult] = useState<{ ok: boolean; message: string; signature?: string } | null>(
    null,
  );

  const lamports = solToLamports(amount);
  const deposit = useDeposit();
  const withdraw = useWithdraw();
  const quote = useWithdrawalQuote(mode === 'withdraw' ? lamports : null);

  const busy = deposit.isPending || withdraw.isPending;

  /**
   * Both flows are instructions to the arena program. If it is not deployed on
   * this cluster the transaction cannot succeed, and the failure lands in the
   * wallet as "Failed to simulate the results of this request" — a red banner
   * that names no cause and points the finger at the user's wallet.
   *
   * Checked here so the form can say what is actually wrong instead of building
   * a transaction it knows will fail.
   */
  const program = useProgramDeployed();
  const programMissing = program.deployed === false;

  /**
   * The connected wallet's balance *on the cluster this app uses*.
   *
   * Shown next to the deposit form because a dApp cannot read which network
   * Phantom is set to — only Phantom knows that, and it simulates and prices
   * fees against its own selection rather than the RPC we hand it.
   *
   * The failure that produces is genuinely baffling: Phantom says "You don't
   * have enough SOL" and "Failed to simulate" for a wallet that is visibly
   * funded, because on *mainnet* it holds nothing and the arena program does
   * not exist. Printing what we can see turns that into a visible contradiction
   * — the app says 5 SOL, the wallet says none — which points straight at the
   * network setting instead of at the balance.
   */
  const onChain = useBalance();

  if (!connected) {
    return (
      <Panel title="Balance">
        <p className="text-sm text-slate-400">Connect a wallet to deposit or withdraw.</p>
      </Panel>
    );
  }

  const submit = async () => {
    if (!lamports || lamports <= 0n) return;
    // Belt and braces: the button is disabled, but a stale render or a keyboard
    // submit must not push a transaction that cannot land.
    if (programMissing) return;
    setResult(null);

    try {
      if (mode === 'deposit') {
        const outcome = await deposit.mutateAsync({ lamports, onStage: setStage });
        setResult({
          ok: outcome.status === 'confirmed',
          message:
            outcome.status === 'confirmed'
              ? `Deposited ${formatSol(BigInt(outcome.creditedLamports ?? '0'))} SOL`
              : // A pending result is not a failure — the reconciler will finish it.
                (outcome.reason ?? 'Deposit is still processing'),
          signature: outcome.signature,
        });
      } else {
        const outcome = await withdraw.mutateAsync({ lamports, onStage: setStage });
        setResult({
          ok: outcome.status === 'confirmed',
          message:
            outcome.status === 'confirmed'
              ? `Withdrew ${formatSol(BigInt(outcome.net ?? '0'))} SOL`
              : (outcome.reason ?? 'Withdrawal is still processing'),
          ...(outcome.signature ? { signature: outcome.signature } : {}),
        });
      }
      setAmount('');
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : 'Failed' });
    } finally {
      setStage('idle');
    }
  };

  const spendable = balance ? BigInt(balance.spendable) : 0n;
  const reserved = balance ? BigInt(balance.reserved) : 0n;

  return (
    <Panel title="Arena balance">
      <div className="mb-4">
        <p className="text-2xl font-semibold tabular-nums">
          {isLoading || !balance ? '—' : formatSol(spendable)}{' '}
          <span className="text-sm font-normal text-slate-400">SOL</span>
        </p>
        {reserved > 0n ? (
          <p className="text-xs text-amber-400">{formatSol(reserved)} SOL reserved in play</p>
        ) : null}
      </div>

      {programMissing ? (
        <div className="mb-3 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3">
          <p className="text-sm font-medium text-amber-300">
            Deposits are unavailable on this cluster
          </p>
          <p className="mt-1 text-xs text-amber-200/80">
            The arena program is not deployed at{' '}
            <span className="break-all font-mono">{program.programId}</span>, so a deposit
            transaction cannot succeed. Your wallet would reject it with a simulation failure.
          </p>
          <p className="mt-1 text-xs text-amber-200/60">
            Your arena balance above is unaffected, and free rooms are still playable.
          </p>
        </div>
      ) : null}

      {!programMissing && onChain.lamports !== undefined ? (
        <p className="mb-3 flex items-baseline justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs">
          <span className="text-slate-400">In your wallet on {cluster}</span>
          <span className="font-semibold tabular-nums text-slate-200">
            {formatSol(onChain.lamports)} SOL
          </span>
        </p>
      ) : null}

      {!programMissing && onChain.lamports === 0n ? (
        <p className="mb-3 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-200/90">
          This wallet holds no SOL on {cluster}. If your wallet shows a balance, it is probably set
          to a different network — switch it to {cluster} in Phantom under Settings → Developer
          Settings.
        </p>
      ) : null}

      <div className="mb-3 flex gap-1 rounded-lg bg-slate-800/60 p-1">
        {(['deposit', 'withdraw'] as const).map((option) => (
          <button
            key={option}
            type="button"
            disabled={busy}
            onClick={() => {
              setMode(option);
              setResult(null);
            }}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm capitalize transition-colors ${
              mode === option
                ? 'bg-slate-700 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <label className="block">
        <span className="sr-only">Amount in SOL</span>
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          placeholder="0.0"
          disabled={busy}
          className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-emerald-500"
        />
      </label>

      {mode === 'withdraw' && quote.data ? (
        <dl className="mt-2 space-y-1 text-xs text-slate-400">
          <div className="flex justify-between">
            <dt>Fee ({quote.data.feeBps / 100}%)</dt>
            <dd className="tabular-nums">{formatSol(BigInt(quote.data.fee), 6)} SOL</dd>
          </div>
          <div className="flex justify-between font-medium text-slate-200">
            <dt>You receive</dt>
            <dd className="tabular-nums">{formatSol(BigInt(quote.data.net), 6)} SOL</dd>
          </div>
        </dl>
      ) : null}

      <Button
        className="mt-3 w-full"
        loading={busy}
        disabled={!lamports || lamports <= 0n || busy || programMissing}
        onClick={() => void submit()}
      >
        {busy ? STAGE_LABEL[stage] || 'Working…' : mode === 'deposit' ? 'Deposit' : 'Withdraw'}
      </Button>

      {result ? (
        <div
          className={`mt-3 rounded-lg border p-2 text-xs ${
            result.ok
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-amber-900 bg-amber-950/50 text-amber-200'
          }`}
        >
          <p>{result.message}</p>
          {result.signature ? (
            <a
              href={explorerTxUrl(result.signature, cluster)}
              target="_blank"
              rel="noreferrer noopener"
              className="underline hover:no-underline"
            >
              View transaction ↗
            </a>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
