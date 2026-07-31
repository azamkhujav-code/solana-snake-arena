'use client';

import { useWallet } from '@solana/wallet-adapter-react';
import { useEffect, useState } from 'react';

/**
 * Live wallet-adapter state, for diagnosing a connection that does nothing.
 *
 * Exists because "I clicked connect and nothing happened" has several distinct
 * causes that look identical from the outside: the extension not injecting, the
 * adapter never being selected, a silent reconnect that declines to prompt, and
 * a rejection that was swallowed. This page shows which one it is.
 *
 * It calls `adapter.connect()` directly rather than going through the app's
 * flow, so a failure here isolates the problem to the wallet rather than to
 * anything this codebase does with it.
 */
interface Probe {
  windowSolana: boolean;
  windowPhantom: boolean;
  phantomIsPhantom: boolean;
  standardWallets: string[];
}

function probeWindow(): Probe {
  const w = window as unknown as {
    solana?: { isPhantom?: boolean };
    phantom?: { solana?: { isPhantom?: boolean } };
  };

  // Wallet Standard wallets announce themselves on an app-initiated event.
  const standard: string[] = [];
  try {
    window.dispatchEvent(
      new CustomEvent('wallet-standard:app-ready', {
        detail: {
          register: (...wallets: { name?: string }[]) => {
            for (const wallet of wallets) if (wallet?.name) standard.push(wallet.name);
            return () => undefined;
          },
        },
      }),
    );
  } catch {
    /* the event is best-effort; absence is itself a signal */
  }

  return {
    windowSolana: Boolean(w.solana),
    windowPhantom: Boolean(w.phantom?.solana),
    phantomIsPhantom: Boolean(w.solana?.isPhantom ?? w.phantom?.solana?.isPhantom),
    standardWallets: standard,
  };
}

function Row({ label, value }: { label: string; value: string }) {
  const bad = value === 'false' || value === 'none' || value === '(none)';
  return (
    <div className="flex justify-between gap-4 border-b border-slate-800 py-1.5">
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono ${bad ? 'text-rose-400' : 'text-emerald-400'}`}>{value}</span>
    </div>
  );
}

export function WalletDebug() {
  const { wallets, wallet, select, connect, connected, connecting, publicKey, disconnect } =
    useWallet();

  const [probe, setProbe] = useState<Probe | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const append = (line: string) =>
    setLog((current) => [...current, `${new Date().toISOString().slice(11, 19)}  ${line}`]);

  // Deferred to a task rather than run synchronously in the effect: the probe
  // dispatches an event and reads what handlers registered during it, so it has
  // to happen after the extension has had a chance to respond — and a
  // synchronous setState here would cascade a render.
  useEffect(() => {
    const timer = setTimeout(() => setProbe(probeWindow()), 250);
    return () => clearTimeout(timer);
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-sm">
      <h1 className="mb-1 text-xl font-bold text-slate-100">Wallet debug</h1>
      <p className="mb-8 text-slate-500">
        Everything the adapter can see. Red means the thing above it is missing.
      </p>

      <section className="mb-8">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
          Browser
        </h2>
        {probe ? (
          <>
            <Row label="window.solana exists" value={String(probe.windowSolana)} />
            <Row label="window.phantom.solana exists" value={String(probe.windowPhantom)} />
            <Row label="reports isPhantom" value={String(probe.phantomIsPhantom)} />
            <Row
              label="Wallet Standard registrations"
              value={probe.standardWallets.join(', ') || '(none)'}
            />
          </>
        ) : (
          <p className="text-slate-500">probing…</p>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
          Adapter
        </h2>
        <Row label="wallets the app offers" value={String(wallets.length)} />
        <Row label="selected wallet" value={wallet?.adapter.name ?? '(none)'} />
        <Row label="selected readyState" value={wallet?.readyState ?? '(none)'} />
        <Row label="connecting" value={String(connecting)} />
        <Row label="connected" value={String(connected)} />
        <Row label="publicKey" value={publicKey?.toBase58() ?? '(none)'} />

        <div className="mt-4 space-y-1">
          {wallets.map((entry) => (
            <div
              key={entry.adapter.name}
              className="flex items-center justify-between gap-3 rounded border border-slate-800 px-3 py-2"
            >
              <span className="text-slate-200">{entry.adapter.name}</span>
              <span
                className={`font-mono text-xs ${
                  entry.readyState === 'Installed' ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {entry.readyState}
              </span>
              <button
                type="button"
                className="rounded bg-sky-600 px-2 py-1 text-xs text-white"
                onClick={() => {
                  append(`select("${entry.adapter.name}")`);
                  select(entry.adapter.name);
                }}
              >
                select
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
          Actions
        </h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded bg-emerald-700 px-3 py-1.5 text-white"
            onClick={() => {
              append('connect() — via the react hook');
              connect().then(
                () => append('connect() resolved'),
                (error: unknown) =>
                  append(
                    `connect() REJECTED: ${(error as Error).name}: ${(error as Error).message}`,
                  ),
              );
            }}
          >
            connect()
          </button>

          <button
            type="button"
            className="rounded bg-amber-700 px-3 py-1.5 text-white"
            onClick={() => {
              // Straight at the adapter, bypassing the app entirely. If this
              // prompts and the app's button does not, the bug is ours.
              const adapter = wallet?.adapter;
              if (!adapter) return append('no wallet selected — press select first');
              append(`${adapter.name}.connect() — direct on the adapter`);
              adapter.connect().then(
                () => append('adapter.connect() resolved'),
                (error: unknown) =>
                  append(
                    `adapter.connect() REJECTED: ${(error as Error).name}: ${(error as Error).message}`,
                  ),
              );
            }}
          >
            adapter.connect()
          </button>

          <button
            type="button"
            className="rounded bg-slate-700 px-3 py-1.5 text-white"
            onClick={() => {
              // The raw provider, bypassing wallet-adapter completely. If this
              // prompts and nothing else does, the library is the problem.
              const w = window as unknown as { solana?: { connect?: () => Promise<unknown> } };
              if (!w.solana?.connect) return append('window.solana.connect is not available');
              append('window.solana.connect() — raw provider');
              w.solana.connect().then(
                (result) => append(`raw connect resolved: ${JSON.stringify(result).slice(0, 120)}`),
                (error: unknown) => append(`raw connect REJECTED: ${(error as Error).message}`),
              );
            }}
          >
            window.solana.connect()
          </button>

          <button
            type="button"
            className="rounded bg-rose-800 px-3 py-1.5 text-white"
            onClick={() => {
              void disconnect();
              append('disconnect()');
            }}
          >
            disconnect
          </button>

          <button
            type="button"
            className="rounded border border-slate-700 px-3 py-1.5 text-slate-300"
            onClick={() => {
              localStorage.removeItem('arena-wallet-name');
              localStorage.removeItem('arena-wallet');
              append('cleared stored wallet selection — reload the page');
            }}
          >
            clear stored selection
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">Log</h2>
        <pre className="min-h-[8rem] overflow-x-auto rounded border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300">
          {log.length > 0 ? log.join('\n') : 'press a button above'}
        </pre>
      </section>
    </main>
  );
}
