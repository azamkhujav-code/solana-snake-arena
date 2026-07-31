'use client';

import type { AdminPlayer } from '@arena/protocol';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

import {
  useAdminPlayers,
  useAdjustBalance,
  useSetPlayerRole,
  useSetPlayerStatus,
} from '@/hooks/use-admin';
import { formatRelativeTime } from '@/lib/lamports';

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

export function PlayersView() {
  const params = useSearchParams();

  const [q, setQ] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('recent');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<AdminPlayer | null>(null);

  const query = useAdminPlayers({
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
    sort,
    ...(cursor ? { cursor } : {}),
  });

  const { data, isLoading, error } = query;

  if (error) return <AdminError error={error} />;

  const players = data?.players ?? [];
  // Relative times are measured from when the data was fetched, not from now.
  // `Date.now()` in render is impure — and this is the better anchor anyway:
  // "2 minutes ago" should not creep forward every time an unrelated bit of
  // state re-renders the table. It is 0 before the first fetch, which only
  // matters while the empty state is showing.
  const now = query.dataUpdatedAt;

  return (
    <>
      <Section
        title="Players"
        description="Search by username or wallet address."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Search">
              <input
                value={q}
                onChange={(event) => {
                  setQ(event.target.value);
                  setCursor(undefined);
                }}
                placeholder="username or wallet"
                className={`${inputClass} w-56`}
              />
            </Field>
            <Field label="Status">
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setCursor(undefined);
                }}
                className={inputClass}
              >
                <option value="">All</option>
                <option value="ACTIVE">Active</option>
                <option value="SHADOWBANNED">Shadowbanned</option>
                <option value="BANNED">Banned</option>
                <option value="CLOSED">Closed</option>
              </select>
            </Field>
            <Field label="Sort">
              <select
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value);
                  setCursor(undefined);
                }}
                className={inputClass}
              >
                <option value="recent">Newest</option>
                <option value="balance">Lifetime won</option>
                <option value="wagered">Lifetime wagered</option>
                <option value="games">Games played</option>
              </select>
            </Field>
          </div>
        }
      >
        <Table>
          <thead>
            <tr>
              <Th>Player</Th>
              <Th>Status</Th>
              <Th>Role</Th>
              <Th align="right">Balance</Th>
              <Th align="right">Reserved</Th>
              <Th align="right">Net P/L</Th>
              <Th align="right">Games</Th>
              <Th>Wallet</Th>
              <Th>Last seen</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            <TableState
              isLoading={isLoading}
              error={null}
              isEmpty={players.length === 0}
              columns={10}
              emptyMessage="No players match."
            />
            {players.map((player) => (
              <tr key={player.id} className="hover:bg-slate-900/40">
                <Td>
                  <div className="text-slate-200">{player.username ?? '(no username)'}</div>
                  <Id value={player.id} />
                </Td>
                <Td>
                  <Badge value={player.status} />
                </Td>
                <Td>{player.role === 'PLAYER' ? null : <Badge value={player.role} />}</Td>
                <Td align="right">
                  <Sol lamports={player.balanceLamports} />
                </Td>
                <Td align="right">
                  <Sol lamports={player.reservedLamports} />
                </Td>
                <Td align="right">
                  <Sol lamports={player.netLamports} sign />
                </Td>
                <Td align="right" className="font-mono text-xs">
                  {player.gamesPlayed}
                </Td>
                <Td>
                  <Id value={player.primaryWallet} />
                </Td>
                <Td className="text-xs text-slate-500">
                  {formatRelativeTime(player.lastSeenAt, now)}
                </Td>
                <Td>
                  <button
                    type="button"
                    onClick={() => setSelected(player)}
                    className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:border-slate-500"
                  >
                    Manage
                  </button>
                </Td>
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

      {selected ? <ManagePlayer player={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

/**
 * The moderation drawer.
 *
 * Every action demands a written reason before its button enables. That is not
 * ceremony: the reason is what makes the action reviewable months later, and an
 * unexplained ban is indistinguishable from an abusive one. The server enforces
 * the same minimum, so this is a courtesy that saves a round trip rather than
 * the actual control.
 */
function ManagePlayer({ player, onClose }: { player: AdminPlayer; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [adjustSol, setAdjustSol] = useState('');

  const setStatus = useSetPlayerStatus(player.id);
  const setRole = useSetPlayerRole(player.id);
  const adjust = useAdjustBalance(player.id);

  const reasonValid = reason.trim().length >= 8;
  const busy = setStatus.isPending || setRole.isPending || adjust.isPending;
  const failure = setStatus.error ?? setRole.error ?? adjust.error;

  const adjustLamports = (() => {
    const parsed = Number.parseFloat(adjustSol);
    if (!Number.isFinite(parsed) || parsed === 0) return null;
    // Rounded to a whole lamport: the API rejects fractions, and silently
    // truncating a typo is worse than refusing it.
    return BigInt(Math.round(parsed * 1e9)).toString();
  })();

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        className="h-full w-full max-w-md overflow-y-auto border-l border-slate-800 bg-slate-950 p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              {player.username ?? '(no username)'}
            </h2>
            <Id value={player.id} />
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>

        <dl className="mb-6 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-slate-500">Balance</dt>
            <dd>
              <Sol lamports={player.balanceLamports} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Reserved</dt>
            <dd>
              <Sol lamports={player.reservedLamports} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Status</dt>
            <dd>
              <Badge value={player.status} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Role</dt>
            <dd>
              <Badge value={player.role} />
            </dd>
          </div>
        </dl>

        <div className="mb-6">
          <Field label="Reason (required, min 8 chars — goes to the audit log)">
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              placeholder="Chargeback investigation #482"
              className={`${inputClass} w-full`}
            />
          </Field>
        </div>

        {failure ? (
          <div className="mb-4 rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
            {failure.message}
          </div>
        ) : null}

        <section className="mb-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Status
          </h3>
          <div className="flex flex-wrap gap-2">
            {(['ACTIVE', 'SHADOWBANNED', 'BANNED'] as const).map((next) => (
              <button
                key={next}
                type="button"
                disabled={!reasonValid || busy || player.status === next}
                onClick={() => setStatus.mutate({ status: next, reason })}
                className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-slate-500 disabled:opacity-40"
              >
                {next === 'ACTIVE' ? 'Reinstate' : next === 'BANNED' ? 'Ban' : 'Shadowban'}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-600">
            A ban does not touch the balance. Their money stays theirs and withdrawable.
          </p>
        </section>

        <section className="mb-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Role
          </h3>
          <div className="flex flex-wrap gap-2">
            {(['PLAYER', 'MODERATOR', 'ADMIN'] as const).map((next) => (
              <button
                key={next}
                type="button"
                disabled={!reasonValid || busy || player.role === next}
                onClick={() => setRole.mutate({ role: next, reason })}
                className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:border-slate-500 disabled:opacity-40"
              >
                {next}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Adjust balance
          </h3>
          <Field label="Amount in SOL (negative to debit)">
            <input
              value={adjustSol}
              onChange={(event) => setAdjustSol(event.target.value)}
              placeholder="-0.25"
              inputMode="decimal"
              className={`${inputClass} w-full`}
            />
          </Field>
          <button
            type="button"
            disabled={!reasonValid || busy || adjustLamports === null}
            onClick={() => {
              if (!adjustLamports) return;
              adjust.mutate({
                amountLamports: adjustLamports,
                reason,
                // Derived from the inputs so a double-click is the same request
                // rather than two corrections. Changing the amount or the
                // reason makes it a genuinely different one.
                idempotencyKey: `ui-${player.id}-${adjustLamports}-${reason.trim().slice(0, 32)}`,
              });
            }}
            className="mt-3 w-full rounded bg-rose-700 px-3 py-2 text-xs font-medium text-white hover:bg-rose-600 disabled:opacity-40"
          >
            Post adjustment
          </button>
          {adjust.data ? (
            <p className="mt-2 text-[11px] text-emerald-400">
              {adjust.data.alreadyApplied
                ? 'Already applied — this key was used before, nothing moved.'
                : 'Posted. New balance '}
              {!adjust.data.alreadyApplied ? <Sol lamports={adjust.data.balanceLamports} /> : null}
            </p>
          ) : null}
          <p className="mt-2 text-[11px] text-slate-600">
            Posts a two-leg ADJUSTMENT against the treasury. It is a real ledger movement, logged
            CRITICAL — not a balance edit.
          </p>
        </section>
      </aside>
    </div>
  );
}
