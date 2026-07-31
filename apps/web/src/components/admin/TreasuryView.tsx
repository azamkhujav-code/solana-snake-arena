'use client';

import Link from 'next/link';

import { useAdminTreasury } from '@/hooks/use-admin';
import { formatSol, formatTimestamp } from '@/lib/lamports';

import { AdminError } from './AdminShell';
import { Id, Section, Sol, StatCard, Table, Td, Th } from './primitives';

/**
 * Chain-versus-ledger reconciliation.
 *
 * The page is arranged as an argument: here is what the chain holds, here is
 * what our books say, and here is whether those agree. The verdicts come first
 * because they are the answer; the supporting numbers are below for whoever
 * needs to work out *why* the answer is no.
 */
export function TreasuryView() {
  const { data, isLoading, error } = useAdminTreasury();

  if (error) return <AdminError error={error} />;

  if (isLoading || !data) {
    return <div className="py-16 text-center text-sm text-slate-500">Reconciling…</div>;
  }

  const { onchain, offchain, invariants } = data;
  const rpcDown = onchain.error !== null;

  return (
    <>
      <Section
        title="Verdict"
        description="Two independent checks. Both should be green; either one red means stop and investigate before processing withdrawals."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <StatCard
            label="Ledger integrity"
            value={invariants.ledgerBalanced ? 'Balanced' : 'DRIFT'}
            tone={invariants.ledgerBalanced ? 'good' : 'bad'}
            sub={
              invariants.ledgerBalanced
                ? 'Pool balances match posted entries'
                : `Off by ${formatSol(invariants.ledgerDriftLamports, { sign: true })} SOL`
            }
          />
          <StatCard
            label="Custody solvency"
            value={
              invariants.custodySolvent === null
                ? 'Unknown'
                : invariants.custodySolvent
                  ? 'Covered'
                  : 'INSOLVENT'
            }
            tone={
              invariants.custodySolvent === null
                ? 'warn'
                : invariants.custodySolvent
                  ? 'good'
                  : 'bad'
            }
            sub={
              invariants.custodySolvent === null
                ? 'Chain balance unavailable — not a shortfall, just unknown'
                : `${formatSol(invariants.custodyCoverageLamports, { sign: true })} SOL against what players are owed`
            }
          />
        </div>
      </Section>

      <Section
        title="On chain"
        description={
          rpcDown
            ? 'The RPC did not answer. Off-chain figures below are still accurate.'
            : `Read at ${formatTimestamp(onchain.fetchedAt)} UTC.`
        }
      >
        {rpcDown ? (
          <div className="rounded-lg border border-amber-800/70 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
            {onchain.error}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <StatCard
              label="Pool vault"
              value={`${formatSol(onchain.poolLamports)} SOL`}
              sub="Backs every player balance"
            />
            <StatCard label="Treasury vault" value={`${formatSol(onchain.treasuryLamports)} SOL`} />
          </div>
        )}
      </Section>

      <Section
        title="Off chain"
        description="Pool balances by kind. EXTERNAL mirrors net inflow and is legitimately negative — it is what makes the grand total sum to zero."
      >
        <Table>
          <thead>
            <tr>
              <Th>Pool</Th>
              <Th align="right">Balance (SOL)</Th>
              <Th>Meaning</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td>Player custody</Td>
              <Td align="right">
                <Sol lamports={offchain.playerCustodyLamports} />
              </Td>
              <Td className="text-slate-500">Owed to players, spendable</Td>
            </tr>
            <tr>
              <Td>Game escrow</Td>
              <Td align="right">
                <Sol lamports={offchain.escrowLamports} />
              </Td>
              <Td className="text-slate-500">Owed to players, locked in live games</Td>
            </tr>
            <tr>
              <Td>Treasury</Td>
              <Td align="right">
                <Sol lamports={offchain.treasuryLamports} />
              </Td>
              <Td className="text-slate-500">House funds</Td>
            </tr>
            <tr>
              <Td>Rake</Td>
              <Td align="right">
                <Sol lamports={offchain.rakeLamports} />
              </Td>
              <Td className="text-slate-500">Collected, not yet swept</Td>
            </tr>
            <tr>
              <Td>Rewards</Td>
              <Td align="right">
                <Sol lamports={offchain.rewardsLamports} />
              </Td>
              <Td className="text-slate-500">Earmarked for bonuses</Td>
            </tr>
            <tr className="bg-slate-900/40">
              <Td className="font-semibold text-slate-200">All pools</Td>
              <Td align="right">
                <Sol lamports={offchain.poolTotalLamports} />
              </Td>
              <Td className="text-slate-500">Including EXTERNAL</Td>
            </tr>
            <tr className="bg-slate-900/40">
              <Td className="font-semibold text-slate-200">Posted ledger</Td>
              <Td align="right">
                <Sol lamports={offchain.ledgerTotalLamports} />
              </Td>
              <Td className="text-slate-500">Must equal the line above</Td>
            </tr>
            <tr className="bg-slate-900/60">
              <Td className="font-semibold text-slate-200">Drift</Td>
              <Td align="right">
                <Sol lamports={invariants.ledgerDriftLamports} sign emphasiseNonZero decimals={9} />
              </Td>
              <Td className="text-slate-500">Anything but zero is a bug</Td>
            </tr>
          </tbody>
        </Table>
      </Section>

      <Section
        title="Imbalanced transfers"
        description="Entry groups whose legs do not sum to zero, over the last 24 hours. This catches what the total-versus-total check cannot: two broken transfers whose errors cancel out."
      >
        {invariants.imbalancedEntryGroups.length === 0 ? (
          <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 px-4 py-3 text-sm text-emerald-300">
            Every transfer in the window balances.
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Entry group</Th>
                <Th align="right">Drift (SOL)</Th>
                <Th>Inspect</Th>
              </tr>
            </thead>
            <tbody>
              {invariants.imbalancedEntryGroups.map((group) => (
                <tr key={group.entryGroupId}>
                  <Td>
                    <Id value={group.entryGroupId} />
                  </Td>
                  <Td align="right">
                    <Sol lamports={group.driftLamports} sign emphasiseNonZero decimals={9} />
                  </Td>
                  <Td>
                    <Link
                      href={`/admin/transactions?entryGroupId=${group.entryGroupId}`}
                      className="text-xs text-sky-400 hover:underline"
                    >
                      View legs
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </>
  );
}
