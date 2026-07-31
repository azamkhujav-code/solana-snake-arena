'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { useAdminTransactions } from '@/hooks/use-admin';
import { formatTimestamp } from '@/lib/lamports';

import { AdminError } from './AdminShell';
import {
  Badge,
  Field,
  Id,
  Pager,
  Section,
  Sol,
  Table,
  TableState,
  Td,
  Th,
  inputClass,
} from './primitives';

const TYPES = [
  '',
  'DEPOSIT',
  'WITHDRAWAL',
  'ENTRY_FEE',
  'PAYOUT',
  'RAKE',
  'REWARD',
  'REFUND',
  'TRANSFER',
  'ADJUSTMENT',
] as const;

/**
 * The ledger browser.
 *
 * Read-only, and there is deliberately no way to make it otherwise. The ledger
 * is append-only by design — a mistake is corrected by posting a compensating
 * entry, which is what makes the history worth trusting. An edit button here
 * would quietly undo that guarantee.
 *
 * Rows are grouped visually by `entryGroupId` so the two legs of a transfer
 * read as one movement rather than two unrelated lines.
 */
export function TransactionsView() {
  const params = useSearchParams();

  // Deep links from the treasury and pool pages arrive as query params.
  const [type, setType] = useState('');
  const [userId, setUserId] = useState(params.get('userId') ?? '');
  const [poolAccountId, setPoolAccountId] = useState(params.get('poolAccountId') ?? '');
  const [minSol, setMinSol] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  // The filter is in SOL because that is what an operator has in their head;
  // the API wants lamports. Guarded against junk so a stray keystroke does not
  // send `NaN` to the server.
  const minLamports = (() => {
    const parsed = Number.parseFloat(minSol);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return BigInt(Math.round(parsed * 1e9)).toString();
  })();

  const { data, isLoading, error } = useAdminTransactions({
    ...(type ? { type } : {}),
    ...(userId ? { userId } : {}),
    ...(poolAccountId ? { poolAccountId } : {}),
    ...(minLamports ? { minLamports } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 100,
  });

  if (error) return <AdminError error={error} />;

  const rows = data?.transactions ?? [];

  return (
    <Section
      title="Ledger"
      description="Append-only. Every row is one leg of a transfer; legs sharing an entry group sum to zero."
      actions={
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Type">
            <select
              value={type}
              onChange={(event) => {
                setType(event.target.value);
                setCursor(undefined);
              }}
              className={inputClass}
            >
              {TYPES.map((option) => (
                <option key={option} value={option}>
                  {option === '' ? 'All types' : option.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Min amount (SOL)">
            <input
              value={minSol}
              onChange={(event) => {
                setMinSol(event.target.value);
                setCursor(undefined);
              }}
              placeholder="0.1"
              inputMode="decimal"
              className={`${inputClass} w-24`}
            />
          </Field>
          <Field label="Player id">
            <input
              value={userId}
              onChange={(event) => {
                setUserId(event.target.value);
                setCursor(undefined);
              }}
              placeholder="uuid"
              className={`${inputClass} w-48`}
            />
          </Field>
          <Field label="Pool account id">
            <input
              value={poolAccountId}
              onChange={(event) => {
                setPoolAccountId(event.target.value);
                setCursor(undefined);
              }}
              placeholder="uuid"
              className={`${inputClass} w-48`}
            />
          </Field>
        </div>
      }
    >
      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Type</Th>
            <Th>Status</Th>
            <Th align="right">Amount</Th>
            <Th align="right">Balance after</Th>
            <Th>Pool account</Th>
            <Th>Player</Th>
            <Th>Entry group</Th>
            <Th>Description</Th>
          </tr>
        </thead>
        <tbody>
          <TableState
            isLoading={isLoading}
            error={null}
            isEmpty={rows.length === 0}
            columns={9}
            emptyMessage="No entries match these filters."
          />
          {rows.map((row, index) => {
            // A rule above the first leg of each group turns two adjacent rows
            // into one visible transfer.
            const startsGroup = index === 0 || rows[index - 1]?.entryGroupId !== row.entryGroupId;

            return (
              <tr
                key={row.id}
                className={startsGroup ? 'border-t-2 border-t-slate-700/70' : undefined}
              >
                <Td className="text-xs text-slate-500">{formatTimestamp(row.createdAt)}</Td>
                <Td>
                  <Badge value={row.type} />
                </Td>
                <Td>
                  <Badge value={row.status} />
                </Td>
                <Td align="right">
                  <Sol lamports={row.signedAmountLamports} sign decimals={6} />
                </Td>
                <Td align="right">
                  <Sol lamports={row.balanceAfterLamports} decimals={6} />
                </Td>
                <Td>
                  <a
                    href={`/admin/transactions?poolAccountId=${row.poolAccountId}`}
                    className="text-xs text-sky-400 hover:underline"
                    title={row.poolAccountName}
                  >
                    {row.poolAccountName.length > 28
                      ? `${row.poolAccountName.slice(0, 28)}…`
                      : row.poolAccountName}
                  </a>
                </Td>
                <Td>
                  {row.userId ? (
                    <Id
                      value={row.username ?? row.userId}
                      href={`/admin/players?q=${row.userId}`}
                    />
                  ) : (
                    <span className="text-slate-600">system</span>
                  )}
                </Td>
                <Td>
                  <Id value={row.entryGroupId} />
                </Td>
                <Td
                  className="max-w-[280px] truncate text-xs text-slate-500"
                  title={row.description ?? ''}
                >
                  {row.description ?? '—'}
                </Td>
              </tr>
            );
          })}
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
