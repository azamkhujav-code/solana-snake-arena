'use client';

import { useState } from 'react';

import { useAdminPools } from '@/hooks/use-admin';
import { formatSol, formatTimestamp } from '@/lib/lamports';

import { AdminError } from './AdminShell';
import {
  Badge,
  Field,
  Id,
  Pager,
  Section,
  Sol,
  StatCard,
  Table,
  TableState,
  Td,
  Th,
  inputClass,
} from './primitives';

const KINDS = [
  '',
  'TREASURY',
  'RAKE',
  'REWARDS',
  'EXTERNAL',
  'GAME_ESCROW',
  'USER_CUSTODY',
] as const;

/**
 * Pool account browser.
 *
 * Defaults to non-zero accounts only. There is one USER_CUSTODY row per player
 * and almost all of them are empty, so an unfiltered first page would be a
 * screenful of zeroes — technically complete and practically useless.
 */
export function PoolAccountsView() {
  const [kind, setKind] = useState<string>('');
  const [nonZeroOnly, setNonZeroOnly] = useState(true);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const { data, isLoading, error } = useAdminPools({
    ...(kind ? { kind } : {}),
    nonZeroOnly,
    ...(cursor ? { cursor } : {}),
  });

  if (error) return <AdminError error={error} />;

  const accounts = data?.accounts ?? [];

  return (
    <Section
      title="Pool accounts"
      description="Every account in the double-entry system. A negative balance is only legitimate on EXTERNAL."
      actions={
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Kind">
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                setCursor(undefined);
              }}
              className={inputClass}
            >
              {KINDS.map((option) => (
                <option key={option} value={option}>
                  {option === '' ? 'All kinds' : option.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 pb-1 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={nonZeroOnly}
              onChange={(event) => {
                setNonZeroOnly(event.target.checked);
                setCursor(undefined);
              }}
              className="accent-sky-500"
            />
            Non-zero only
          </label>
        </div>
      }
    >
      {data ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <StatCard label="Accounts matched" value={data.totals.count.toLocaleString()} />
          <StatCard
            label="Total balance"
            value={`${formatSol(data.totals.balanceLamports)} SOL`}
            sub="Across all matches, not just this page"
          />
          <StatCard
            label="Total reserved"
            value={`${formatSol(data.totals.reservedLamports)} SOL`}
            sub="Committed to withdrawals or live games"
          />
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            <Th>Kind</Th>
            <Th>Name</Th>
            <Th align="right">Balance</Th>
            <Th align="right">Reserved</Th>
            <Th align="right">Spendable</Th>
            <Th>On-chain</Th>
            <Th align="right">Ver.</Th>
            <Th>Updated</Th>
          </tr>
        </thead>
        <tbody>
          <TableState
            isLoading={isLoading}
            error={null}
            isEmpty={accounts.length === 0}
            columns={8}
            emptyMessage="No accounts match. Try clearing the non-zero filter."
          />
          {accounts.map((account) => (
            <tr key={account.id} className="hover:bg-slate-900/40">
              <Td>
                <Badge value={account.kind} />
              </Td>
              <Td>
                <a
                  href={`/admin/transactions?poolAccountId=${account.id}`}
                  className="text-xs text-sky-400 hover:underline"
                  title={account.name}
                >
                  {account.name.length > 40 ? `${account.name.slice(0, 40)}…` : account.name}
                </a>
              </Td>
              <Td align="right">
                <Sol lamports={account.balanceLamports} />
              </Td>
              <Td align="right">
                <Sol lamports={account.reservedLamports} />
              </Td>
              <Td align="right">
                {/* Negative spendable means more is reserved than held, which
                    the ledger should make impossible. Flag it rather than
                    rendering it as an ordinary number. */}
                <Sol
                  lamports={account.spendableLamports}
                  emphasiseNonZero={account.spendableLamports.startsWith('-')}
                />
              </Td>
              <Td>
                <Id value={account.onchainAddress} />
              </Td>
              <Td align="right" className="font-mono text-xs text-slate-500">
                {account.version}
              </Td>
              <Td className="text-xs text-slate-500">{formatTimestamp(account.updatedAt)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <Pager
        hasNext={data?.nextCursor != null}
        atStart={cursor === undefined}
        onNext={() => setCursor(data?.nextCursor ?? undefined)}
        onReset={() => setCursor(undefined)}
      />
    </Section>
  );
}
