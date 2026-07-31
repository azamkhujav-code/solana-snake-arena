'use client';

import { Button } from '@arena/ui';
import { useState } from 'react';

import { useCluster } from '@/hooks/use-cluster';
import { getCluster } from '@/lib/cluster';

const DOT: Record<string, string> = {
  devnet: 'bg-emerald-400',
  testnet: 'bg-amber-400',
  'mainnet-beta': 'bg-rose-400',
  localnet: 'bg-sky-400',
};

/**
 * Network indicator and switcher.
 *
 * Switching here changes the RPC endpoint the app uses, which is what actually
 * decides where transactions land. Phantom's own network setting is not
 * readable by dApps and only affects what Phantom itself displays — hence the
 * hint shown alongside, rather than a claim that we detected their network.
 */
export function NetworkBadge() {
  const { cluster, config, available, mismatch, verified, checking, switchCluster } = useCluster();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
      >
        <span
          className={`size-2 rounded-full ${mismatch ? 'bg-rose-500' : (DOT[cluster] ?? 'bg-slate-400')}`}
          aria-hidden
        />
        {config.label}
        {checking ? <span className="text-slate-500">…</span> : null}
        {verified ? <span className="text-emerald-400">✓</span> : null}
      </button>

      {mismatch ? (
        <p className="absolute right-0 top-full mt-1 w-64 rounded-lg border border-rose-900 bg-rose-950/90 p-2 text-xs text-rose-200">
          The configured RPC is serving a different chain than <strong>{config.label}</strong>.
          Check <code>NEXT_PUBLIC_SOLANA_RPC_URL</code>.
        </p>
      ) : null}

      {open ? (
        <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-lg border border-slate-800 bg-slate-900 shadow-xl">
          {available.map((id) => {
            const option = getCluster(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  switchCluster(id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-800 ${
                  id === cluster ? 'text-emerald-400' : 'text-slate-200'
                }`}
              >
                <span className={`size-2 rounded-full ${DOT[id] ?? 'bg-slate-400'}`} aria-hidden />
                {option.label}
                {id === cluster ? <span className="ml-auto text-xs">current</span> : null}
              </button>
            );
          })}
          <p className="border-t border-slate-800 px-3 py-2 text-[11px] leading-snug text-slate-500">
            This sets the network the app uses. Phantom&apos;s own network setting is separate and
            only affects what Phantom displays.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Compact prompt shown when the app is not on devnet during development. */
export function SwitchToDevnetPrompt() {
  const { cluster, switchToDevnet } = useCluster();

  if (cluster === 'devnet') return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-amber-900 bg-amber-950/60 px-3 py-2 text-xs text-amber-200">
      <span>
        You are on <strong>{cluster}</strong>. Slither Arena runs on devnet.
      </span>
      <Button size="sm" variant="secondary" onClick={switchToDevnet}>
        Switch to Devnet
      </Button>
    </div>
  );
}
