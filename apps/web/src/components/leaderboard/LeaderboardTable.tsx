'use client';

import { useState } from 'react';

import { useLeaderboard, type LeaderboardWindow } from '@/hooks/use-leaderboard';
import { formatSol } from '@/lib/lamports';

/**
 * The global leaderboard.
 *
 * A client island rather than a server component because the window is a piece
 * of client state — switching it must not cost a round trip through the server
 * renderer, and the board is polled anyway.
 *
 * Scores arrive as decimal strings and are rendered with the same bigint-safe
 * formatter as every other amount. A leaderboard is exactly where a big number
 * shows up first, and `Number(score)` would round it silently.
 */
const WINDOWS: { id: LeaderboardWindow; label: string }[] = [
  { id: 'daily', label: 'Today' },
  { id: 'weekly', label: 'This week' },
  { id: 'all-time', label: 'All time' },
];

export function LeaderboardTable() {
  const [window, setWindow] = useState<LeaderboardWindow>('daily');
  const { data, isLoading, error } = useLeaderboard(window);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {WINDOWS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setWindow(option.id)}
            className={
              option.id === window
                ? 'rounded bg-slate-700 px-3 py-1 text-xs font-medium text-slate-100'
                : 'rounded px-3 py-1 text-xs font-medium text-slate-400 hover:bg-slate-800/60'
            }
          >
            {option.label}
          </button>
        ))}

        {data ? (
          <span className="ml-auto text-xs text-slate-500">
            {data.total.toLocaleString()} ranked · {data.periodKey}
          </span>
        ) : null}
      </div>

      {error ? (
        // Named plainly rather than shown as an endless spinner: "the API is
        // down" and "you are not ranked yet" are different things, and a reader
        // has no way to tell them apart from a blank table.
        <p className="rounded border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-300">
          Could not load the leaderboard. {error.message}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr>
                {['#', 'Player', 'Score', 'Games', 'Wins', 'Kills'].map((heading, index) => (
                  <th
                    key={heading}
                    className={`whitespace-nowrap border-b border-slate-800 bg-slate-900/80 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 ${
                      index >= 2 ? 'text-right' : 'text-left'
                    }`}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-slate-500">
                    Loading…
                  </td>
                </tr>
              ) : data && data.entries.length > 0 ? (
                data.entries.map((entry) => (
                  <tr key={entry.userId} className="hover:bg-slate-900/40">
                    <td className="border-b border-slate-800/60 px-3 py-2 font-mono text-slate-400">
                      {entry.rank}
                    </td>
                    <td className="border-b border-slate-800/60 px-3 py-2 text-slate-200">
                      {entry.nickname ?? <span className="text-slate-600">anonymous</span>}
                    </td>
                    <td
                      className="border-b border-slate-800/60 px-3 py-2 text-right font-mono tabular-nums text-slate-200"
                      title={`${entry.score} lamports`}
                    >
                      {formatSol(entry.score)}
                    </td>
                    <td className="border-b border-slate-800/60 px-3 py-2 text-right font-mono text-slate-400">
                      {entry.gamesPlayed}
                    </td>
                    <td className="border-b border-slate-800/60 px-3 py-2 text-right font-mono text-slate-400">
                      {entry.wins}
                    </td>
                    <td className="border-b border-slate-800/60 px-3 py-2 text-right font-mono text-slate-400">
                      {entry.kills}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-slate-600">
                    Nobody has ranked in this window yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
