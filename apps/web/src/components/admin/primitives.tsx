'use client';

import { cn } from '@arena/ui';
import type { ReactNode } from 'react';

import { formatLamports, formatSol, isNonZero } from '@/lib/lamports';

/**
 * Shared building blocks for the admin tables.
 *
 * Density is the design goal: an operator scanning for the row that is wrong
 * needs many rows on screen at once, and every pixel of padding is a row they
 * have to scroll to find. This is the opposite of the game UI, which is why
 * these do not reuse the player-facing card styles.
 */

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-300">
            {title}
          </h2>
          {description ? <p className="mt-1 text-xs text-slate-500">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A headline number. `tone` is for figures that mean something is wrong. */
export function StatCard({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const toneClass = {
    neutral: 'text-slate-100',
    good: 'text-emerald-400',
    warn: 'text-amber-400',
    bad: 'text-rose-400',
  }[tone];

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className={cn('mt-1 font-mono text-xl tabular-nums', toneClass)}>{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

/**
 * A SOL amount.
 *
 * Monospaced and tabular so a column of figures aligns on the decimal point —
 * without that, spotting the number an order of magnitude out of place means
 * reading every row instead of noticing the one that is wider.
 *
 * The exact lamport count goes in the `title` attribute, because the rounded
 * display is for scanning and the exact figure is for the incident report.
 */
export function Sol({
  lamports,
  sign = false,
  emphasiseNonZero = false,
  decimals = 4,
}: {
  lamports: string | null | undefined;
  sign?: boolean;
  /** Styles a non-zero value as a problem. For drift and unaccounted figures. */
  emphasiseNonZero?: boolean;
  decimals?: number;
}) {
  const problem = emphasiseNonZero && isNonZero(lamports);

  return (
    <span
      title={lamports ? `${formatLamports(lamports)} lamports` : undefined}
      className={cn(
        'font-mono tabular-nums',
        problem ? 'font-semibold text-rose-400' : 'text-slate-200',
      )}
    >
      {formatSol(lamports, { maxDecimals: decimals, sign })}
    </span>
  );
}

const BADGE_TONES: Record<string, string> = {
  // Healthy / terminal-good
  ACTIVE: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  CONFIRMED: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  COMPLETED: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  POSTED: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  SURVIVED: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  // In flight
  RUNNING: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  PENDING: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  SUBMITTED: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  DRAINING: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  PLAYING: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  // Bad
  FAILED: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  BANNED: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  REVERSED: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  CRITICAL: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  SHADOWBANNED: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  WARN: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  // Privilege — deliberately loud. Spotting an unexpected ADMIN in a list is
  // the point of colouring it at all.
  ADMIN: 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30',
  MODERATOR: 'bg-indigo-500/15 text-indigo-300 ring-indigo-500/30',
};

export function Badge({ value }: { value: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset',
        BADGE_TONES[value] ?? 'bg-slate-700/40 text-slate-300 ring-slate-600/40',
      )}
    >
      {value.replace(/_/g, ' ')}
    </span>
  );
}

/** Truncated id with the full value one hover away, and click-to-copy. */
export function Id({ value, href }: { value: string | null; href?: string }) {
  if (!value) return <span className="text-slate-600">—</span>;

  const short = value.length > 12 ? `${value.slice(0, 8)}…` : value;
  const body = (
    <span title={value} className="font-mono text-xs text-slate-400">
      {short}
    </span>
  );

  return href ? (
    <a href={href} className="hover:text-sky-400 hover:underline">
      {body}
    </a>
  ) : (
    body
  );
}

/* ---- Table ------------------------------------------------------------- */

export function Table({ children }: { children: ReactNode }) {
  // The horizontal scroll lives on the table's own container, not the page:
  // a dashboard whose body scrolls sideways is unusable on a laptop.
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full min-w-[720px] border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = 'left',
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={cn(
        'whitespace-nowrap border-b border-slate-800 bg-slate-900/80 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className,
  title,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  /** Full value for a cell whose display is truncated. */
  title?: string;
}) {
  return (
    <td
      title={title}
      className={cn(
        'whitespace-nowrap border-b border-slate-800/60 px-3 py-2 text-slate-300',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  );
}

/**
 * The three states every table has, in one place.
 *
 * Empty and error are distinct on purpose: "no rows matched" and "we could not
 * find out" look identical if both render a blank table, and an operator acting
 * on the first when it was really the second draws exactly the wrong conclusion.
 */
export function TableState({
  isLoading,
  error,
  isEmpty,
  columns,
  emptyMessage = 'Nothing matches these filters.',
}: {
  isLoading: boolean;
  error: Error | null;
  isEmpty: boolean;
  columns: number;
  emptyMessage?: string;
}) {
  if (!isLoading && !error && !isEmpty) return null;

  return (
    <tr>
      <td colSpan={columns} className="px-3 py-10 text-center text-sm">
        {isLoading ? (
          <span className="text-slate-500">Loading…</span>
        ) : error ? (
          <span className="text-rose-400">Could not load: {error.message}</span>
        ) : (
          <span className="text-slate-600">{emptyMessage}</span>
        )}
      </td>
    </tr>
  );
}

export function Pager({
  onNext,
  onReset,
  hasNext,
  atStart,
}: {
  onNext: () => void;
  onReset: () => void;
  hasNext: boolean;
  atStart: boolean;
}) {
  if (!hasNext && atStart) return null;

  return (
    <div className="mt-3 flex items-center gap-2">
      <button
        type="button"
        onClick={onReset}
        disabled={atStart}
        className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-300 disabled:opacity-40"
      >
        First page
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={!hasNext}
        className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-300 disabled:opacity-40"
      >
        Next
      </button>
      {/* Keyset paging has no page numbers by design — see docs/API.md. */}
      <span className="text-[11px] text-slate-600">Keyset paging: forward only</span>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  'rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none';
