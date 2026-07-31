'use client';

import { LeaveMatch } from '@/components/game/LeaveMatch';
import { useCustodyBalance } from '@/hooks/use-custody';
import { useMatchWallets } from '@/hooks/use-match-wallets';
import {
  buildLeaderboardRows,
  formatMatchTime,
  formatScore,
  fpsQuality,
  pingQuality,
  type Quality,
} from '@/lib/hud-state';
import { formatSolShort } from '@/lib/lobby-state';
import { useGameStore } from '@/stores/game-store';
import { useSettingsStore } from '@/stores/settings-store';

const QUALITY_COLOUR: Record<Quality, string> = {
  good: 'text-emerald-400',
  fair: 'text-amber-400',
  poor: 'text-rose-400',
};

/**
 * Overlay HUD.
 *
 * Every value is selected individually from the store so a score change does
 * not re-render the leaderboard, and a leaderboard update does not re-render
 * the FPS counter. With a single `useGameStore()` call the whole HUD would
 * re-render on every store write.
 *
 * The container is `pointer-events-none` so the HUD never swallows a click
 * meant for the canvas; individual panels opt back in where needed.
 */
export function Hud({ onLeave }: { onLeave: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-0 select-none p-3 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <ScorePanel />
          <KillCounter />
        </div>

        <div className="flex flex-col items-center gap-2">
          <MatchTimer />
          <PotChip />
          <WalletChip />
          {/* The only way out while alive. The HUD container is
              `pointer-events-none`; this opts back in. */}
          <LeaveMatch onQuit={onLeave} />
        </div>

        <Leaderboard />
      </div>

      <KillFeed />
      <Diagnostics />
    </div>
  );
}

function ScorePanel() {
  const score = useGameStore((state) => state.score);
  const rank = useGameStore((state) => state.rank);
  const alive = useGameStore((state) => state.alive);

  return (
    <div className="rounded-xl border border-slate-800/80 bg-slate-900/70 px-3 py-2 backdrop-blur-md">
      <p className="text-[10px] uppercase tracking-widest text-slate-400">Score</p>
      <p className="text-2xl font-semibold tabular-nums leading-tight">{formatScore(score)}</p>
      {rank !== null ? <p className="text-xs text-slate-400">Rank #{rank}</p> : null}
      {!alive ? <p className="text-xs text-amber-400">Spectating</p> : null}
    </div>
  );
}

function KillCounter() {
  const kills = useGameStore((state) => state.kills);

  return (
    <div className="rounded-xl border border-slate-800/80 bg-slate-900/70 px-3 py-2 backdrop-blur-md">
      <p className="text-[10px] uppercase tracking-widest text-slate-400">Kills</p>
      <p className="text-xl font-semibold tabular-nums leading-tight text-rose-300">{kills}</p>
    </div>
  );
}

function MatchTimer() {
  const elapsedMs = useGameStore((state) => state.elapsedMs);

  return (
    <div className="rounded-full border border-slate-800/80 bg-slate-900/70 px-4 py-1.5 backdrop-blur-md">
      <p className="text-lg font-semibold tabular-nums">{formatMatchTime(elapsedMs)}</p>
    </div>
  );
}

/**
 * What the last surviving snake wins.
 *
 * The single number that makes a staked match feel like one. Shows the prize
 * — the pot after the platform fee — rather than the gross, because the gross
 * is not what anyone receives and a player who saw it first would read the
 * payout as short.
 *
 * Hidden entirely on free rooms and between matches. A prize chip reading zero
 * is worse than no chip: it looks like a bug in the thing the player cares
 * most about.
 */
function PotChip() {
  const roomId = useGameStore((state) => state.roomId);
  const { byTier } = useMatchWallets();

  // The realtime room id is the tier id, which is what the board is keyed by.
  const wallet = roomId ? byTier.get(roomId) : undefined;
  if (!wallet?.address) return null;

  const prize = BigInt(wallet.prizeLamports);
  const pending = BigInt(wallet.committedLamports);
  const amount = prize > 0n ? prize : pending;
  if (amount === 0n) return null;

  return (
    <div className="rounded-full border border-emerald-700/60 bg-emerald-950/50 px-3 py-1 backdrop-blur-md">
      <p className="text-xs font-semibold tabular-nums text-emerald-300">
        {formatSolShort(amount)} ◎ {prize > 0n ? 'to the winner' : 'staked'}
      </p>
    </div>
  );
}

/** Custody balance, so the player can see their stake without leaving the game. */
function WalletChip() {
  const { data } = useCustodyBalance();
  if (!data) return null;

  return (
    <div className="rounded-full border border-slate-800/80 bg-slate-900/70 px-3 py-1 backdrop-blur-md">
      <p className="text-xs tabular-nums text-emerald-300">
        {formatSolShort(BigInt(data.spendable))} ◎
      </p>
    </div>
  );
}

function Leaderboard() {
  const entries = useGameStore((state) => state.leaderboard);
  const playerId = useGameStore((state) => state.playerId);

  const rows = buildLeaderboardRows(entries, playerId);
  if (rows.length === 0) return null;

  return (
    <div className="w-44 rounded-xl border border-slate-800/80 bg-slate-900/70 px-3 py-2 backdrop-blur-md sm:w-56">
      <p className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-400">Leaderboard</p>

      <ol className="space-y-0.5 text-xs">
        {rows.map((row) => (
          <li
            key={row.playerId}
            className={`flex items-baseline justify-between gap-2 rounded px-1 py-0.5 ${
              row.isSelf ? 'bg-emerald-500/15 text-emerald-200' : 'text-slate-300'
            } ${row.detached ? 'mt-1.5 border-t border-slate-800 pt-1.5' : ''}`}
          >
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="w-5 shrink-0 tabular-nums text-slate-500">{row.rank}</span>
              <span className="truncate">{row.nickname}</span>
            </span>
            <span className="shrink-0 tabular-nums">
              {formatScore(row.score)}
              {row.kills > 0 ? (
                <span className="ml-1 text-[10px] text-rose-400">{row.kills}k</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function KillFeed() {
  const feed = useGameStore((state) => state.killFeed);
  if (feed.length === 0) return null;

  return (
    <ul className="absolute right-3 top-1/4 space-y-1 text-right sm:right-4">
      {feed.map((item) => (
        <li
          key={item.id}
          className={`text-xs ${item.isSelf ? 'font-medium text-emerald-300' : 'text-slate-400'}`}
        >
          {item.text}
        </li>
      ))}
    </ul>
  );
}

/**
 * FPS and ping.
 *
 * Always visible rather than hidden behind a debug flag: in a real-time game
 * these are the first things a player checks when it feels wrong, and hiding
 * them turns "my connection is bad" into "your game is broken".
 */
function Diagnostics() {
  const fps = useGameStore((state) => state.fps);
  const rttMs = useGameStore((state) => state.rttMs);
  const status = useGameStore((state) => state.status);
  const verbose = useSettingsStore((state) => state.showDebugOverlay);

  return (
    <div className="absolute bottom-3 left-3 flex items-center gap-3 rounded-lg border border-slate-800/80 bg-slate-900/70 px-2.5 py-1 text-[11px] tabular-nums backdrop-blur-md sm:bottom-4 sm:left-4">
      <span className={QUALITY_COLOUR[fpsQuality(fps)]}>{fps} fps</span>
      <span className={QUALITY_COLOUR[pingQuality(rttMs)]}>{rttMs} ms</span>
      {status !== 'connected' ? <span className="text-amber-400">{status}</span> : null}
      {verbose ? <VerboseStats /> : null}
    </div>
  );
}

function VerboseStats() {
  const mass = useGameStore((state) => state.mass);
  const packetLoss = useGameStore((state) => state.packetLoss);

  return (
    <>
      <span className="text-slate-500">mass {Math.round(mass)}</span>
      <span className="text-slate-500">loss {(packetLoss * 100).toFixed(1)}%</span>
    </>
  );
}
