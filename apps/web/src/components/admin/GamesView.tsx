'use client';

import { useState } from 'react';

import { useAdminGame, useAdminGames, useCancelGame, useRetrySettlement } from '@/hooks/use-admin';
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

export function GamesView() {
  const [status, setStatus] = useState('');
  const [settlementStatus, setSettlementStatus] = useState('');
  const [unaccountedOnly, setUnaccountedOnly] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [openGameId, setOpenGameId] = useState<string | null>(null);

  const { data, isLoading, error } = useAdminGames({
    ...(status ? { status } : {}),
    ...(settlementStatus ? { settlementStatus } : {}),
    ...(unaccountedOnly ? { unaccountedOnly: true } : {}),
    ...(cursor ? { cursor } : {}),
  });

  if (error) return <AdminError error={error} />;

  const games = data?.games ?? [];

  return (
    <>
      <Section
        title="Games"
        description="Finished matches are financial records. There is no edit — a wrong one is corrected with a compensating ledger entry."
        actions={
          <div className="flex flex-wrap items-end gap-3">
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
                <option value="RUNNING">Running</option>
                <option value="COMPLETED">Completed</option>
                <option value="CANCELLED">Cancelled</option>
                <option value="PENDING">Pending</option>
              </select>
            </Field>
            <Field label="Settlement">
              <select
                value={settlementStatus}
                onChange={(event) => {
                  setSettlementStatus(event.target.value);
                  setCursor(undefined);
                }}
                className={inputClass}
              >
                <option value="">All</option>
                <option value="NOT_REQUIRED">Not required</option>
                <option value="PENDING">Pending</option>
                <option value="SUBMITTED">Submitted</option>
                <option value="CONFIRMED">Confirmed</option>
                <option value="FAILED">Failed</option>
              </select>
            </Field>
            <label className="flex items-center gap-2 pb-1 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={unaccountedOnly}
                onChange={(event) => {
                  setUnaccountedOnly(event.target.checked);
                  setCursor(undefined);
                }}
                className="accent-rose-500"
              />
              Money unaccounted for
            </label>
          </div>
        }
      >
        <Table>
          <thead>
            <tr>
              <Th>Started</Th>
              <Th>Room</Th>
              <Th>Status</Th>
              <Th>Settlement</Th>
              <Th align="right">Players</Th>
              <Th align="right">Pot</Th>
              <Th align="right">Paid out</Th>
              <Th align="right">Rake</Th>
              <Th align="right">Unaccounted</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            <TableState
              isLoading={isLoading}
              error={null}
              isEmpty={games.length === 0}
              columns={10}
              emptyMessage={
                unaccountedOnly
                  ? 'Every completed game adds up. Nothing stranded.'
                  : 'No games match.'
              }
            />
            {games.map((game) => (
              <tr key={game.id} className="hover:bg-slate-900/40">
                <Td className="text-xs text-slate-500">{formatTimestamp(game.startedAt)}</Td>
                <Td>
                  <div className="text-slate-200">{game.roomCode}</div>
                  <span className="text-[11px] text-slate-600">
                    {game.mode} · {game.region}
                  </span>
                </Td>
                <Td>
                  <Badge value={game.status} />
                </Td>
                <Td>
                  <Badge value={game.settlementStatus} />
                </Td>
                <Td align="right" className="font-mono text-xs">
                  {game.playerCount}
                </Td>
                <Td align="right">
                  <Sol lamports={game.potLamports} />
                </Td>
                <Td align="right">
                  <Sol lamports={game.payoutLamports} />
                </Td>
                <Td align="right">
                  <Sol lamports={game.rakeLamports} />
                </Td>
                <Td align="right">
                  {/* What the escrow still holds. On a finished game — settled
                      or cancelled — that is money stranded in the pot, and it
                      is the whole reason this column exists. A game still in
                      flight holds its pot legitimately, so it is not flagged. */}
                  <Sol
                    lamports={game.unaccountedLamports}
                    emphasiseNonZero={game.status === 'COMPLETED' || game.status === 'CANCELLED'}
                    decimals={9}
                  />
                </Td>
                <Td>
                  <button
                    type="button"
                    onClick={() => setOpenGameId(game.id)}
                    className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:border-slate-500"
                  >
                    Trace
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

      {openGameId ? <GameDrawer gameId={openGameId} onClose={() => setOpenGameId(null)} /> : null}
    </>
  );
}

/** Standings and the full ledger trail for one game, side by side. */
function GameDrawer({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const { data, isLoading } = useAdminGame(gameId);
  const [reason, setReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const retry = useRetrySettlement(gameId);
  const cancel = useCancelGame(gameId);

  const canRetry = data?.settlementStatus === 'FAILED';
  // The escrow still holds lamports. Whatever the status says, this match's pot
  // has gone neither to a winner nor back to the players.
  const stranded = data !== undefined && BigInt(data.unaccountedLamports) > 0n;
  const reasonValid = reason.trim().length >= 8;
  const cancelReasonValid = cancelReason.trim().length >= 8;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        className="h-full w-full max-w-3xl overflow-y-auto border-l border-slate-800 bg-slate-950 p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Game trace</h2>
            <Id value={gameId} />
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>

        {isLoading || !data ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            {canRetry ? (
              <div className="mb-6 rounded-lg border border-rose-900 bg-rose-950/30 p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-rose-300">
                  Settlement failed
                </h3>
                <p className="mt-1 text-xs text-rose-200/70">
                  Winners were not paid. Re-queueing is safe — payout is idempotent on the game id,
                  so this cannot double-pay even if the first attempt partly succeeded.
                </p>
                <div className="mt-3 flex gap-2">
                  <input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason (min 8 chars)"
                    className={`${inputClass} flex-1`}
                  />
                  <button
                    type="button"
                    disabled={!reasonValid || retry.isPending}
                    onClick={() => retry.mutate({ reason })}
                    className="rounded bg-rose-700 px-3 py-1 text-xs font-medium text-white hover:bg-rose-600 disabled:opacity-40"
                  >
                    Re-queue
                  </button>
                </div>
                {retry.error ? (
                  <p className="mt-2 text-xs text-rose-300">{retry.error.message}</p>
                ) : null}
              </div>
            ) : null}

            {stranded ? (
              <div className="mb-6 rounded-lg border border-amber-900 bg-amber-950/30 p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                  Pot stranded in escrow
                </h3>
                <p className="mt-1 text-xs text-amber-200/70">
                  <Sol lamports={data.unaccountedLamports} /> entered this match and never left.
                  Cancelling returns every entry fee to the account it came from, in balanced ledger
                  entries. It is idempotent per player, so clicking twice cannot pay twice — and it
                  refuses outright on a game that has already paid a winner.
                </p>
                <div className="mt-3 flex gap-2">
                  <input
                    value={cancelReason}
                    onChange={(event) => setCancelReason(event.target.value)}
                    placeholder="Reason (min 8 chars)"
                    className={`${inputClass} flex-1`}
                  />
                  <button
                    type="button"
                    disabled={!cancelReasonValid || cancel.isPending}
                    onClick={() => cancel.mutate({ reason: cancelReason })}
                    className="rounded bg-amber-700 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-40"
                  >
                    Cancel &amp; refund
                  </button>
                </div>
                {cancel.error ? (
                  <p className="mt-2 text-xs text-amber-300">{cancel.error.message}</p>
                ) : null}
              </div>
            ) : null}

            {cancel.data && cancel.data.refunds.length > 0 ? (
              <div className="mb-6 rounded-lg border border-emerald-900 bg-emerald-950/30 p-4 text-xs text-emerald-200/80">
                Refunded <Sol lamports={cancel.data.refundedLamports} /> to{' '}
                {cancel.data.refunds.length} player
                {cancel.data.refunds.length === 1 ? '' : 's'}. The entries are in the ledger trail
                below.
              </div>
            ) : null}

            <Section title="Standings">
              <Table>
                <thead>
                  <tr>
                    <Th align="right">#</Th>
                    <Th>Player</Th>
                    <Th>Result</Th>
                    <Th align="right">Score</Th>
                    <Th align="right">Kills</Th>
                    <Th align="right">Entry</Th>
                    <Th align="right">Payout</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.players.map((player) => (
                    <tr key={player.userId}>
                      <Td align="right" className="font-mono text-xs">
                        {player.placement ?? '—'}
                      </Td>
                      <Td>{player.username ?? <Id value={player.userId} />}</Td>
                      <Td>
                        <Badge value={player.state} />
                      </Td>
                      <Td align="right" className="font-mono text-xs">
                        {player.score}
                      </Td>
                      <Td align="right" className="font-mono text-xs">
                        {player.kills}
                      </Td>
                      <Td align="right">
                        <Sol lamports={player.entryLamports} />
                      </Td>
                      <Td align="right">
                        <Sol lamports={player.payoutLamports} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Section>

            <Section
              title="Ledger trail"
              description="Every entry tagged with this game, oldest first. Entry fees in, payout and rake out."
            >
              {data.ledger.length === 0 ? (
                <p className="text-sm text-slate-600">
                  No ledger entries. Expected for a free-to-play match.
                </p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>When</Th>
                      <Th>Type</Th>
                      <Th align="right">Amount</Th>
                      <Th>Pool account</Th>
                      <Th>Player</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ledger.map((row) => (
                      <tr key={row.id}>
                        <Td className="text-xs text-slate-500">{formatTimestamp(row.createdAt)}</Td>
                        <Td>
                          <Badge value={row.type} />
                        </Td>
                        <Td align="right">
                          <Sol lamports={row.signedAmountLamports} sign decimals={6} />
                        </Td>
                        <Td className="text-xs">{row.poolAccountName}</Td>
                        <Td className="text-xs">{row.username ?? '—'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>
          </>
        )}
      </aside>
    </div>
  );
}
