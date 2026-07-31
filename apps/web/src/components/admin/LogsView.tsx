'use client';

import { useState } from 'react';

import { useAdminAudit } from '@/hooks/use-admin';
import { formatRelativeTime, formatTimestamp } from '@/lib/lamports';

import { AdminError } from './AdminShell';
import {
  Badge,
  Field,
  Id,
  Pager,
  Section,
  Table,
  TableState,
  Td,
  Th,
  inputClass,
} from './primitives';

/**
 * The audit trail.
 *
 * Worth being precise about what this is, because "Logs" invites the wrong
 * expectation: these are **admin actions**, written inside the same database
 * transaction as the change they describe. Application logs — requests, errors,
 * stack traces — go to stdout and from there to the log shipper. They answer a
 * different question and live under a retention policy this table deliberately
 * does not share.
 */
export function LogsView() {
  const [severity, setSeverity] = useState('');
  const [action, setAction] = useState('');
  const [userId, setUserId] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useAdminAudit({
    ...(severity ? { severity } : {}),
    ...(action ? { action } : {}),
    ...(userId ? { userId } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 100,
  });

  const { data, isLoading, error } = query;

  if (error) return <AdminError error={error} />;

  const entries = data?.entries ?? [];
  // Anchored to the fetch, not to render. See the note in PlayersView.
  const now = query.dataUpdatedAt;

  return (
    <Section
      title="Audit trail"
      description="Who changed what, and why. Written in the same transaction as the change — there is no path that produces a mutation without an entry here."
      actions={
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Severity">
            <select
              value={severity}
              onChange={(event) => {
                setSeverity(event.target.value);
                setCursor(undefined);
              }}
              className={inputClass}
            >
              <option value="">All</option>
              <option value="CRITICAL">Critical</option>
              <option value="WARN">Warn</option>
              <option value="INFO">Info</option>
            </select>
          </Field>
          <Field label="Action">
            <input
              value={action}
              onChange={(event) => {
                setAction(event.target.value);
                setCursor(undefined);
              }}
              placeholder="admin.player.balance_adjusted"
              className={`${inputClass} w-64`}
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
        </div>
      }
    >
      <div className="mb-4 rounded border border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-500">
        This is the admin audit trail, not the application log. Request and error logs are shipped
        from stdout and are not queryable here.
      </div>

      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Severity</Th>
            <Th>Action</Th>
            <Th>Actor</Th>
            <Th>Subject</Th>
            <Th>Detail</Th>
          </tr>
        </thead>
        <tbody>
          <TableState
            isLoading={isLoading}
            error={null}
            isEmpty={entries.length === 0}
            columns={6}
            emptyMessage="No audit entries match. On a new deployment this is expected."
          />
          {entries.map((entry) => {
            const isOpen = expanded === entry.id;

            return (
              <tr key={entry.id} className="align-top hover:bg-slate-900/40">
                <Td className="text-xs text-slate-500">
                  <div title={`${formatTimestamp(entry.createdAt)} UTC`}>
                    {formatRelativeTime(entry.createdAt, now)}
                  </div>
                </Td>
                <Td>
                  <Badge value={entry.severity} />
                </Td>
                <Td className="font-mono text-xs text-slate-300">{entry.action}</Td>
                <Td>
                  <Id value={entry.actorId} />
                </Td>
                <Td>
                  {entry.userId ? (
                    <Id
                      value={entry.username ?? entry.userId}
                      href={`/admin/players?q=${entry.userId}`}
                    />
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </Td>
                <Td className="whitespace-normal">
                  {entry.metadata == null ? (
                    <span className="text-slate-600">—</span>
                  ) : isOpen ? (
                    <div>
                      <pre className="max-w-xl overflow-x-auto rounded bg-slate-900 p-2 text-[11px] text-slate-300">
                        {JSON.stringify(entry.metadata, null, 2)}
                      </pre>
                      <button
                        type="button"
                        onClick={() => setExpanded(null)}
                        className="mt-1 text-[11px] text-sky-400 hover:underline"
                      >
                        Collapse
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setExpanded(entry.id)}
                      className="text-[11px] text-sky-400 hover:underline"
                    >
                      {summarise(entry.metadata)}
                    </button>
                  )}
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

/**
 * One-line preview of an entry's metadata.
 *
 * The reason is what an operator scanning the log actually wants to read, so it
 * is promoted ahead of everything else. `unknown` rather than a typed shape
 * because the column is free-form JSON by design — narrowing it here would mean
 * a new action's metadata renders as nothing.
 */
function summarise(metadata: unknown): string {
  if (typeof metadata !== 'object' || metadata === null) return 'View detail';

  const record = metadata as Record<string, unknown>;
  const reason = typeof record.reason === 'string' ? record.reason : null;

  if (reason) {
    return reason.length > 60 ? `${reason.slice(0, 60)}…` : reason;
  }

  const keys = Object.keys(record);
  return keys.length > 0 ? `${keys.slice(0, 3).join(', ')}…` : 'View detail';
}
