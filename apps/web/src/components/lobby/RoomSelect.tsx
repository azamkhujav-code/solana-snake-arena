'use client';

import { Panel } from '@arena/ui';
import { useCallback, useMemo, useState } from 'react';

import { useBalance } from '@/hooks/use-balance';
import {
  useJoinLobby,
  useLeaveLobby,
  useLobbies,
  useSecondTicker,
  useSetReady,
} from '@/hooks/use-lobbies';
import { formatSolShort, type JoinContext, type LobbySummary } from '@/lib/lobby-state';
import { useWalletConnect } from '@/hooks/use-wallet-connect';
import { useSessionStore } from '@/stores/session-store';

import { useEntryFee } from '@/hooks/use-entry-fee';
import { useMatchLaunch } from '@/hooks/use-match-launch';
import { usePreloadArena } from '@/hooks/use-preload-arena';
import { useMatchWallets } from '@/hooks/use-match-wallets';

import { DepositConfirmDialog } from './DepositConfirmDialog';
import { RoomCard } from './RoomCard';

/**
 * Collects the entry fee once the queued room starts counting down.
 *
 * Rendered as a banner rather than a modal: a dialog that steals focus during a
 * countdown is more likely to be dismissed by reflex than read, and the wallet
 * is already showing its own approval prompt.
 */
function EntryFeeBanner({ lobby }: { lobby: LobbySummary | null }) {
  const setReady = useSetReady();
  const tierId = lobby?.tierId ?? null;

  // Paying is readiness: it lets a lobby where everyone has paid start on the
  // short timer rather than waiting out a countdown sized for the slowest
  // wallet approval.
  const markReady = useCallback(() => {
    if (tierId) setReady.mutate({ tierId, ready: true });
    // `setReady` is a stable mutation object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierId]);

  const { status, error, retry } = useEntryFee(lobby, markReady);

  if (!lobby || BigInt(lobby.entryFeeLamports) === 0n || status === 'idle') return null;

  if (status === 'paid') {
    return (
      <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300">
        Entry fee paid into the match wallet. Starting…
      </p>
    );
  }

  if (status === 'failed') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
        <span>Entry fee not paid: {error ?? 'unknown error'}. You will sit this match out.</span>
        <button
          type="button"
          onClick={retry}
          className="shrink-0 rounded border border-rose-700 px-2 py-1 text-rose-200 hover:bg-rose-900/40"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <p className="rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
      {status === 'awaiting-signature'
        ? `Approve ${formatSolShort(BigInt(lobby.entryFeeLamports))} ◎ in your wallet to enter this match.`
        : 'Paying the entry fee…'}
    </p>
  );
}

/**
 * The seven-room board.
 *
 * Renders every tier at all times, including ones the player cannot afford, so
 * the ladder is visible and the next rung is obvious. Hiding unaffordable rooms
 * would make the board silently shrink as the balance drops.
 */
export function RoomSelect() {
  const { data, isLoading, isError, receivedAt, refetch } = useLobbies();
  const wallets = useMatchWallets();
  // The wallet's own on-chain balance. There is no platform balance any more:
  // entry fees are paid from the wallet when the match starts.
  const balance = useBalance();
  const authenticated = useSessionStore((state) => state.status === 'authenticated');
  const { openWalletModal } = useWalletConnect();
  const now = useSecondTicker();

  const join = useJoinLobby();
  const leave = useLeaveLobby();
  const ready = useSetReady();
  // Watches the board and takes the player into the match when their room
  // starts. Without it a paid seat leads nowhere.
  const launch = useMatchLaunch();
  // The renderer is the slowest thing between clicking a room and playing.
  // Fetch it while the board is being read.
  usePreloadArena();

  const [readyTiers, setReadyTiers] = useState<Record<string, boolean>>({});

  const spendable = useMemo(() => balance.lamports ?? null, [balance.lamports]);

  /**
   * The room awaiting confirmation, if any.
   *
   * Paid rooms route through a dialog rather than joining on the click: the
   * click commits real money, and one misclick on the whale room is five SOL.
   * Free rooms join straight away — a confirmation that only ever says "this
   * costs nothing" trains people to dismiss the dialog without reading it,
   * which is exactly the habit that makes the paid one useless.
   */
  const [confirming, setConfirming] = useState<string | null>(null);

  const handleJoin = useCallback(
    (tierId: string) => {
      const lobby = data?.lobbies.find((entry) => entry.tierId === tierId);

      if (lobby && BigInt(lobby.entryFeeLamports) > 0n) {
        setConfirming(tierId);
        return;
      }

      // Free room: take the seat and go. There is no pot to coordinate, so
      // there is nothing to wait for — and a practice arena you cannot reach
      // for ten minutes is not practice.
      join.mutate(tierId, {
        onSuccess: () => {
          void launch.playNow(tierId);
        },
      });
    },
    [data, join, launch],
  );

  const confirmJoin = useCallback(() => {
    if (!confirming) return;
    join.mutate(confirming, { onSuccess: () => setConfirming(null) });
  }, [confirming, join]);
  const handleLeave = useCallback(
    (tierId: string) => {
      leave.mutate(tierId);
      setReadyTiers((current) => ({ ...current, [tierId]: false }));
    },
    [leave],
  );
  const handleReady = useCallback(
    (tierId: string, value: boolean) => {
      setReadyTiers((current) => ({ ...current, [tierId]: value }));
      ready.mutate({ tierId, ready: value });
    },
    [ready],
  );
  // Uses the connector rather than opening the modal directly: selecting a
  // wallet only triggers a silent reconnect, which never prompts.
  const handleSignIn = openWalletModal;

  if (!authenticated) {
    return (
      <Panel title="Rooms">
        <p className="text-sm text-slate-400">
          Connect a wallet and sign in to see the room board.
        </p>
      </Panel>
    );
  }

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 7 }, (_, index) => (
          <div
            key={index}
            className="h-52 animate-pulse rounded-xl border border-slate-800/60 bg-slate-900/40"
          />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Panel title="Rooms">
        <p className="mb-3 text-sm text-rose-400">Could not load the room board.</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="text-sm text-emerald-400 hover:text-emerald-300"
        >
          Try again
        </button>
      </Panel>
    );
  }

  // Resolved from the live board rather than captured at click time, so the
  // dialog's player count and pot keep updating while it is open.
  const confirmingLobby = confirming
    ? (data.lobbies.find((entry) => entry.tierId === confirming) ?? null)
    : null;

  // The room this player is queued in. Once it starts counting down, the entry
  // fee is collected — see `useEntryFee`.
  const queuedLobby = data.currentTierId
    ? (data.lobbies.find((entry) => entry.tierId === data.currentTierId) ?? null)
    : null;

  const pendingTier = join.isPending
    ? (join.variables ?? null)
    : leave.isPending
      ? (leave.variables ?? null)
      : null;

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">Rooms</h2>
        {launch.launching ? (
          <p className="text-xs text-amber-300">Your match is starting — joining…</p>
        ) : data.currentTierId ? (
          <p className="text-xs text-emerald-400">Queued in {data.currentTierId}</p>
        ) : null}
      </header>

      <EntryFeeBanner lobby={queuedLobby} />

      {launch.error ? (
        <p className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
          Could not join the match: {launch.error}. Your seat is still held.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.lobbies.map((lobby) => {
          const context: JoinContext = {
            authenticated,
            spendableLamports: spendable,
            currentTierId: data.currentTierId,
            pending: pendingTier === lobby.tierId,
          };

          return (
            <RoomCard
              key={lobby.tierId}
              lobby={lobby}
              context={context}
              receivedAt={receivedAt}
              now={now}
              onJoin={handleJoin}
              onLeave={handleLeave}
              onSignIn={handleSignIn}
              onToggleReady={handleReady}
              isReady={readyTiers[lobby.tierId] ?? false}
              wallet={wallets.byTier.get(lobby.tierId)}
            />
          );
        })}
      </div>

      <p className="text-[11px] text-slate-500">
        Each match has its own wallet. Entry fees move into it when the match starts, and the last
        surviving snake takes the balance less the platform fee.
      </p>

      <DepositConfirmDialog
        lobby={confirmingLobby}
        wallet={confirming ? wallets.byTier.get(confirming) : undefined}
        walletLamports={spendable}
        pending={join.isPending}
        onConfirm={confirmJoin}
        onCancel={() => setConfirming(null)}
      />
    </section>
  );
}
