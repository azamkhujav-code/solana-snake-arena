'use client';

import { useAdminStats } from '@/hooks/use-admin';
import { formatSol } from '@/lib/lamports';

import { AdminError } from './AdminShell';
import { Section, StatCard } from './primitives';

/**
 * The overview page.
 *
 * Ordered by what an operator opening this at the start of a shift needs to
 * know, in order: is anything broken, is the money where it should be, and is
 * the platform busy. Alerts come first because if one is showing, nothing
 * further down the page matters yet.
 */
export function StatisticsView() {
  const { data, isLoading, error } = useAdminStats();

  if (error) return <AdminError error={error} />;

  if (isLoading || !data) {
    return <div className="py-16 text-center text-sm text-slate-500">Loading statistics…</div>;
  }

  const { players, games, money, custody, alerts } = data;
  const criticals = alerts.filter((alert) => alert.severity === 'critical');

  return (
    <>
      {alerts.length > 0 ? (
        <div className="mb-8 space-y-2">
          {alerts.map((alert) => (
            <div
              key={alert.code}
              className={
                alert.severity === 'critical'
                  ? 'flex items-center gap-3 rounded-lg border border-rose-800 bg-rose-950/40 px-4 py-3'
                  : 'flex items-center gap-3 rounded-lg border border-amber-800/70 bg-amber-950/30 px-4 py-3'
              }
            >
              <span
                className={
                  alert.severity === 'critical'
                    ? 'rounded bg-rose-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-300'
                    : 'rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300'
                }
              >
                {alert.severity}
              </span>
              <span className="text-sm text-slate-200">{alert.message}</span>
              {alert.count > 1 ? (
                <span className="ml-auto font-mono text-sm text-slate-400">×{alert.count}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-8 rounded-lg border border-emerald-900/60 bg-emerald-950/20 px-4 py-3 text-sm text-emerald-300">
          No alerts. The ledger balances and custody is covered.
        </div>
      )}

      <Section
        title="Custody"
        description={
          criticals.length > 0
            ? 'These figures are not trustworthy while a ledger alert is open.'
            : 'What the platform is holding right now, by pool.'
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard
            label="Player balances"
            value={`${formatSol(custody.playerBalances)} SOL`}
            sub="Owed to players"
          />
          <StatCard
            label="In escrow"
            value={`${formatSol(custody.escrowed)} SOL`}
            sub="Locked in live games"
          />
          <StatCard label="Treasury" value={`${formatSol(custody.treasury)} SOL`} />
          <StatCard label="Rake" value={`${formatSol(custody.rake)} SOL`} sub="Not yet swept" />
          <StatCard label="Rewards" value={`${formatSol(custody.rewards)} SOL`} sub="Earmarked" />
        </div>
      </Section>

      <Section title={`Money · last ${data.windowHours}h`}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Deposited" value={`${formatSol(money.depositedInWindow)} SOL`} />
          <StatCard label="Withdrawn" value={`${formatSol(money.withdrawnInWindow)} SOL`} />
          <StatCard
            label="Net flow"
            value={`${formatSol(money.netFlowInWindow, { sign: true })} SOL`}
            // Outflow is normal and healthy; only the direction is worth noting.
            tone={money.netFlowInWindow.startsWith('-') ? 'warn' : 'good'}
            sub="Deposits minus withdrawals"
          />
          <StatCard label="Wagered" value={`${formatSol(money.wageredInWindow)} SOL`} />
          <StatCard
            label="Rake taken"
            value={`${formatSol(money.rakeInWindow)} SOL`}
            tone="good"
            sub="Revenue"
          />
        </div>
      </Section>

      <Section title={`Activity · last ${data.windowHours}h`}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Active players"
            value={players.active.toLocaleString()}
            sub={`${players.total.toLocaleString()} total`}
          />
          <StatCard label="New players" value={players.newInWindow.toLocaleString()} />
          <StatCard
            label="Games played"
            value={games.inWindow.toLocaleString()}
            sub={`${games.running} running now`}
          />
          <StatCard
            label="Banned"
            value={players.banned.toLocaleString()}
            tone={players.banned > 0 ? 'warn' : 'neutral'}
          />
        </div>
      </Section>

      <Section title="Settlement">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Awaiting settlement"
            value={games.awaitingSettlement.toLocaleString()}
            tone={games.awaitingSettlement > 0 ? 'warn' : 'neutral'}
            sub="Completed, payout queued"
          />
          <StatCard
            label="Failed settlement"
            value={games.failedSettlement.toLocaleString()}
            tone={games.failedSettlement > 0 ? 'bad' : 'good'}
            sub="Winners not paid"
          />
        </div>
      </Section>
    </>
  );
}
