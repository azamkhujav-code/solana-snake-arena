'use client';

import type { AdminRoom } from '@arena/protocol';
import { useState } from 'react';

import { useAdminRooms, useUpdateRoom } from '@/hooks/use-admin';

import { AdminError } from './AdminShell';
import { Badge, Field, Section, Sol, Table, TableState, Td, Th, inputClass } from './primitives';

export function RoomsView() {
  const { data, isLoading, error } = useAdminRooms();
  const [editing, setEditing] = useState<AdminRoom | null>(null);

  if (error) return <AdminError error={error} />;

  const rooms = data?.rooms ?? [];

  return (
    <>
      <Section
        title="Rooms"
        description="Includes closed rooms — an operator needs to see the room a complaint refers to even after it was retired."
      >
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th>Mode</Th>
              <Th>Region</Th>
              <Th align="right">Entry fee</Th>
              <Th align="right">Rake</Th>
              <Th align="right">Capacity</Th>
              <Th align="right">Games</Th>
              <Th align="right">Volume</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            <TableState
              isLoading={isLoading}
              error={null}
              isEmpty={rooms.length === 0}
              columns={11}
              emptyMessage="No rooms configured."
            />
            {rooms.map((room) => (
              <tr key={room.id} className="hover:bg-slate-900/40">
                <Td className="font-mono text-xs text-slate-200">{room.code}</Td>
                <Td>{room.name ?? '—'}</Td>
                <Td>
                  <Badge value={room.status} />
                </Td>
                <Td className="text-xs">{room.mode}</Td>
                <Td className="text-xs">{room.region}</Td>
                <Td align="right">
                  <Sol lamports={room.entryFeeLamports} />
                </Td>
                <Td align="right" className="font-mono text-xs">
                  {(room.rakeBps / 100).toFixed(2)}%
                </Td>
                <Td align="right" className="font-mono text-xs">
                  {room.maxPlayers}
                </Td>
                <Td align="right" className="font-mono text-xs">
                  {room.gamesPlayed.toLocaleString()}
                </Td>
                <Td align="right">
                  <Sol lamports={room.volumeLamports} />
                </Td>
                <Td>
                  <button
                    type="button"
                    onClick={() => setEditing(room)}
                    className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:border-slate-500"
                  >
                    Edit
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>

      {editing ? <EditRoom room={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

/**
 * Room editor.
 *
 * Entry fee and rake are shown but not editable, and the note says why: changing
 * the price of a room players are already queued in changes the deal they
 * agreed to. Rendering them as disabled inputs rather than omitting them is
 * deliberate — an operator looking for the field needs to find out it is not
 * there on purpose, not conclude the page is broken.
 */
function EditRoom({ room, onClose }: { room: AdminRoom; onClose: () => void }) {
  const [status, setStatus] = useState(room.status);
  const [name, setName] = useState(room.name ?? '');
  const [maxPlayers, setMaxPlayers] = useState(String(room.maxPlayers));
  const [reason, setReason] = useState('');

  const update = useUpdateRoom(room.id);
  const reasonValid = reason.trim().length >= 8;
  const capacity = Number.parseInt(maxPlayers, 10);
  const capacityValid = Number.isInteger(capacity) && capacity >= 2 && capacity <= 64;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        className="h-full w-full max-w-md overflow-y-auto border-l border-slate-800 bg-slate-950 p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between">
          <h2 className="text-base font-semibold text-slate-100">Room {room.code}</h2>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <Field label="Status">
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className={inputClass}
            >
              <option value="ACTIVE">Active</option>
              <option value="DRAINING">Draining — no new joins, live games finish</option>
              <option value="CLOSED">Closed</option>
            </select>
          </Field>

          <Field label="Name">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Max players">
            <input
              value={maxPlayers}
              onChange={(event) => setMaxPlayers(event.target.value)}
              inputMode="numeric"
              className={inputClass}
            />
          </Field>

          <div className="rounded border border-slate-800 bg-slate-900/40 p-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-600">Entry fee</div>
                <Sol lamports={room.entryFeeLamports} />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-600">Rake</div>
                <span className="font-mono text-slate-300">{(room.rakeBps / 100).toFixed(2)}%</span>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Not editable. Repricing a room players are queued in changes the deal they agreed to —
              close it and open a new one, which leaves the old terms visible in history.
            </p>
          </div>

          <Field label="Reason (required, min 8 chars)">
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              placeholder="Draining ahead of the v2 rollout"
              className={`${inputClass} w-full`}
            />
          </Field>

          {update.error ? (
            <div className="rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
              {update.error.message}
            </div>
          ) : null}
          {update.data ? (
            <div className="rounded border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
              Saved. Status is now {update.data.status}.
            </div>
          ) : null}

          <button
            type="button"
            disabled={!reasonValid || !capacityValid || update.isPending}
            onClick={() =>
              update.mutate({
                status,
                name: name.trim() === '' ? null : name.trim(),
                maxPlayers: capacity,
                reason,
              })
            }
            className="w-full rounded bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            Save changes
          </button>
        </div>
      </aside>
    </div>
  );
}
