'use client';

import { Button } from '@arena/ui';

import type { MatchWallet } from '@/hooks/use-match-wallets';
import { shortenAddress } from '@/lib/cluster';
import {
  deriveJoinState,
  fillRatio,
  formatSolShort,
  grossPool,
  localCountdown,
  statusLabel,
  type JoinContext,
  type LobbySummary,
} from '@/lib/lobby-state';

export interface RoomCardProps {
  lobby: LobbySummary;
  context: JoinContext;
  /** When the board data arrived, for interpolating the countdown. */
  receivedAt: number;
  now: number;
  onJoin: (tierId: string) => void;
  onLeave: (tierId: string) => void;
  onSignIn: () => void;
  onToggleReady?: (tierId: string, ready: boolean) => void;
  isReady?: boolean;
  /** This room's match wallet. Undefined until the first fetch lands. */
  wallet?: MatchWallet | undefined;
}

const ACCENT: Record<string, string> = {
  practice: 'from-slate-500/20',
  bronze: 'from-amber-700/25',
  silver: 'from-slate-300/20',
  gold: 'from-yellow-500/25',
  platinum: 'from-cyan-400/20',
  diamond: 'from-sky-400/25',
  whale: 'from-fuchsia-500/25',
};

export function RoomCard({
  lobby,
  context,
  receivedAt,
  now,
  onJoin,
  onLeave,
  onSignIn,
  onToggleReady,
  isReady = false,
  wallet,
}: RoomCardProps) {
  const seconds = localCountdown(lobby.countdownSeconds, receivedAt, now);
  const join = deriveJoinState(lobby, context);
  const fill = fillRatio(lobby);
  const entryFee = BigInt(lobby.entryFeeLamports);

  /**
   * What the pot is worth.
   *
   * Prefers the server's figure over the client-derived estimate. Once a match
   * starts, `balanceLamports` is what the match wallet actually holds; before
   * that, `committedLamports` is what queued players have reserved. The local
   * `entryFee × playerCount` is only a fallback for the first paint, before the
   * wallet request lands — it agrees with the server in the simple case and
   * diverges the moment anything interesting happens, such as a player leaving
   * mid-countdown.
   */
  const held = wallet ? BigInt(wallet.balanceLamports) : 0n;
  const committed = wallet ? BigInt(wallet.committedLamports) : 0n;
  const pool = wallet ? (held > 0n ? held : committed) : grossPool(lobby);
  const sealed = held > 0n;

  const handleClick = (): void => {
    if (join.action === 'sign-in') onSignIn();
    else if (join.action === 'leave') onLeave(lobby.tierId);
    else if (join.action === 'join') onJoin(lobby.tierId);
  };

  return (
    <article
      data-testid="room-card"
      className={`relative flex flex-col overflow-hidden rounded-xl border bg-gradient-to-br to-slate-900/60 p-4 transition-colors ${
        join.active ? 'border-emerald-500/70' : 'border-slate-800/80'
      } ${ACCENT[lobby.tierId] ?? 'from-slate-700/20'}`}
    >
      {join.active ? (
        <span className="absolute right-3 top-3 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
          Queued
        </span>
      ) : null}

      <header className="mb-3">
        <h3 className="text-base font-semibold text-slate-100">{lobby.name}</h3>
        <p className="text-xs text-slate-400">{lobby.description}</p>
      </header>

      <dl className="mb-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">Entry</dt>
          <dd className="text-sm font-semibold tabular-nums text-slate-100">
            {entryFee === 0n ? 'Free' : `${formatSolShort(entryFee)} ◎`}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">Players</dt>
          <dd className="text-sm font-semibold tabular-nums text-slate-100">
            {lobby.playerCount}
            {/* No denominator: the room has no seat limit, and "12/∞" reads as
                a bug rather than as freedom to join. */}
            {lobby.maxPlayers === null ? null : (
              <span className="text-slate-500">/{lobby.maxPlayers}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">
            {sealed ? 'In wallet' : 'Pot'}
          </dt>
          <dd className="text-sm font-semibold tabular-nums text-emerald-300">
            {pool === 0n ? '—' : `${formatSolShort(pool)} ◎`}
          </dd>
        </div>
      </dl>

      <MatchWalletLine wallet={wallet} sealed={sealed} />

      {/* Capacity bar. Turns amber near full so a filling room reads at a glance. */}
      <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full transition-[width] duration-500 ${
            fill >= 1 ? 'bg-emerald-400' : 'bg-emerald-600/70'
          }`}
          style={{ width: `${Math.max(2, fill * 100)}%` }}
        />
      </div>

      <p
        className={`mb-3 text-xs tabular-nums ${
          lobby.status === 'countdown' ? 'text-amber-300' : 'text-slate-400'
        }`}
      >
        {statusLabel(lobby, seconds)}
        {lobby.readyCount > 0 ? (
          <span className="text-slate-500"> · {lobby.readyCount} ready</span>
        ) : null}
      </p>

      <div className="mt-auto space-y-2">
        <Button
          className="w-full"
          size="sm"
          variant={join.active ? 'secondary' : 'primary'}
          disabled={join.disabled}
          onClick={handleClick}
        >
          {join.label}
        </Button>

        {/* Ready only appears where it does something: in the room you are in. */}
        {join.active && lobby.status !== 'launching' && onToggleReady ? (
          <Button
            className="w-full"
            size="sm"
            variant={isReady ? 'primary' : 'ghost'}
            onClick={() => onToggleReady(lobby.tierId, !isReady)}
          >
            {isReady ? 'Ready ✓' : 'Mark ready'}
          </Button>
        ) : null}

        {join.reason ? <p className="text-[11px] text-slate-500">{join.reason}</p> : null}
      </div>
    </article>
  );
}

/**
 * The address holding this room's pot.
 *
 * Shown on the card, not just in the confirmation dialog, so a player can see
 * where the money for a room they have already joined is sitting without
 * leaving the board. Free rooms hold no funds and get no line — an address that
 * is permanently empty invites the question of why.
 */
function MatchWalletLine({
  wallet,
  sealed,
}: {
  wallet: MatchWallet | undefined;
  sealed: boolean;
}) {
  if (!wallet?.address) return null;

  return (
    <p
      className="mb-2 flex items-baseline justify-between gap-2 text-[10px]"
      title={`Match wallet ${wallet.address}`}
    >
      <span className="font-mono text-sky-400/80">{shortenAddress(wallet.address)}</span>
      <span className={wallet.onChain ? 'text-emerald-500/80' : 'text-amber-500/80'}>
        {wallet.onChain ? 'on devnet' : 'ledger'}
        {sealed ? ' · sealed' : ''}
      </span>
    </p>
  );
}
