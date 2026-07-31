'use client';

import { Button } from '@arena/ui';
import { useEffect, useRef } from 'react';

import type { MatchWallet } from '@/hooks/use-match-wallets';
import { shortenAddress } from '@/lib/cluster';
import { formatSolShort, type LobbySummary } from '@/lib/lobby-state';

export interface DepositConfirmDialogProps {
  /** The room being joined. Null closes the dialog. */
  lobby: LobbySummary | null;
  wallet: MatchWallet | undefined;
  /** The connected wallet's on-chain balance, or null while it loads. */
  walletLamports: bigint | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirms an entry fee before it is committed.
 *
 * Joining a paid room moves real money, and it previously happened on a single
 * click with nothing between the intent and the charge. One misclick on the
 * whale room is five SOL. A confirmation step is the cheapest possible guard,
 * and it doubles as the only place in the flow where the player is told what
 * actually happens to their fee.
 *
 * Built on the native `<dialog>` element rather than a div with a high z-index:
 * it renders in the top layer so nothing can paint over it, traps focus, closes
 * on Escape, and is announced as a modal to screen readers — all behaviour that
 * a hand-rolled overlay has to reimplement and usually gets wrong.
 */
export function DepositConfirmDialog({
  lobby,
  wallet,
  walletLamports,
  pending,
  onConfirm,
  onCancel,
}: DepositConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = lobby !== null;

  // `showModal()` is imperative, so the element has to be driven rather than
  // rendered. Calling it on an already-open dialog throws, hence the guard.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // Escape and the backdrop both fire `cancel`/`close` natively. Without this
  // the element would close while React still believed it was open, and the
  // dialog could never be reopened.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const handleClose = (): void => onCancel();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onCancel]);

  const entryFee = lobby ? BigInt(lobby.entryFeeLamports) : 0n;
  const balanceAfter = walletLamports === null ? null : walletLamports - entryFee;
  const heldNow = wallet ? BigInt(wallet.balanceLamports) : 0n;
  const committed = wallet ? BigInt(wallet.committedLamports) : 0n;

  // What the pot becomes once this player is in it. Committed rather than held,
  // because held is zero until the match launches.
  const potWithYou = committed + entryFee;
  const rakeBps = wallet?.rakeBps ?? 0;
  const prizeWithYou = potWithYou - (potWithYou * BigInt(rakeBps)) / 10_000n;

  return (
    <dialog
      ref={ref}
      data-testid="deposit-confirm"
      aria-labelledby="deposit-confirm-title"
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-slate-700 bg-slate-900 p-0 text-slate-100 backdrop:bg-slate-950/70 backdrop:backdrop-blur-sm"
    >
      {lobby ? (
        <div className="p-5">
          <h2 id="deposit-confirm-title" className="text-lg font-semibold">
            Join {lobby.name} for {formatSolShort(entryFee)} ◎?
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Winner takes the whole pot, less a {(rakeBps / 100).toFixed(0)}% platform fee.
          </p>

          <dl className="my-4 space-y-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-sm">
            <Row label="Entry fee" value={`${formatSolShort(entryFee)} ◎`} accent="text-rose-300" />
            <Row
              label="Your wallet"
              value={
                walletLamports === null || balanceAfter === null
                  ? '—'
                  : `${formatSolShort(walletLamports)} → ${formatSolShort(balanceAfter)} ◎`
              }
            />
            <div className="border-t border-slate-800 pt-2">
              <Row
                label="Pot with you in it"
                value={`${formatSolShort(potWithYou)} ◎`}
                accent="text-emerald-300"
              />
              <Row
                label="Winner receives"
                value={`${formatSolShort(prizeWithYou)} ◎`}
                accent="text-emerald-300"
              />
            </div>
          </dl>

          <MatchWalletNote wallet={wallet} heldNow={heldNow} />

          <p className="mt-3 text-xs text-slate-500">
            Nothing leaves your wallet yet. When the room reaches {lobby.minPlayers} players your
            wallet will ask you to approve the {formatSolShort(entryFee)} ◎ entry fee, which goes
            straight into the match wallet. A room that never fills costs you nothing.
          </p>

          <div className="mt-5 flex gap-2">
            <Button className="flex-1" onClick={onConfirm} loading={pending} disabled={pending}>
              {pending ? 'Joining…' : 'Take my seat'}
            </Button>
            <Button variant="secondary" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

function Row({
  label,
  value,
  accent = 'text-slate-100',
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="text-slate-400">{label}</dt>
      <dd className={`font-semibold tabular-nums ${accent}`}>{value}</dd>
    </div>
  );
}

/**
 * Names the account the fee ends up in.
 *
 * Shown because "where did my SOL go" is the first question a staked match
 * raises, and an address the player can check for themselves is a better answer
 * than a promise. The on-chain caveat is stated rather than omitted: while the
 * vault is uninitialised the pot is tracked in the platform ledger, and someone
 * who looks the address up on an explorer would otherwise find an empty account
 * and conclude the worst.
 */
function MatchWalletNote({ wallet, heldNow }: { wallet: MatchWallet | undefined; heldNow: bigint }) {
  if (!wallet?.address) {
    return (
      <p className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
        The match wallet is created when this room’s next match is set up. Your fee is held against
        your balance until then.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <p className="text-[10px] uppercase tracking-widest text-slate-500">Match wallet</p>
      <p className="mt-0.5 break-all font-mono text-xs text-sky-300">{wallet.address}</p>
      <p className="mt-1 text-xs text-slate-400">
        Holds {formatSolShort(heldNow)} ◎ right now
        {wallet.onChain ? (
          <span className="text-emerald-400"> · live on devnet</span>
        ) : (
          <span className="text-amber-400"> · tracked in the platform ledger, not yet on chain</span>
        )}
      </p>
    </div>
  );
}

/** Re-exported for the room card, which shows the same shortened address. */
export { shortenAddress };
