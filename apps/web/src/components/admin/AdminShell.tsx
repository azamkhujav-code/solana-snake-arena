'use client';

import { cn } from '@arena/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { useSessionStore } from '@/stores/session-store';

const NAV = [
  { href: '/admin', label: 'Statistics' },
  { href: '/admin/treasury', label: 'Treasury' },
  { href: '/admin/pool-accounts', label: 'Pool Accounts' },
  { href: '/admin/transactions', label: 'Transactions' },
  { href: '/admin/players', label: 'Players' },
  { href: '/admin/games', label: 'Games' },
  { href: '/admin/rooms', label: 'Rooms' },
  { href: '/admin/logs', label: 'Logs' },
] as const;

/**
 * The admin shell.
 *
 * The role check here is **presentation only**. It hides navigation a
 * non-admin cannot use, which is a courtesy, not a control — the browser is
 * the attacker's computer and any client-side gate can be stepped over with
 * devtools. Authorisation is enforced by the scope hook in the gateway's
 * `routes/admin/index.ts`, and that is the only place it counts.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const status = useSessionStore((state) => state.status);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <header className="border-b border-slate-800 bg-slate-900/60">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <Link href="/admin" className="text-sm font-semibold tracking-tight text-slate-100">
            Arena <span className="text-slate-500">Admin</span>
          </Link>

          <nav className="flex flex-wrap items-center gap-1">
            {NAV.map((item) => {
              // Exact match for the index so it does not stay lit on every page.
              const active =
                item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                    active
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-xs">
            {status === 'authenticated' ? (
              <span className="text-slate-500">Signed in</span>
            ) : (
              <Link href="/" className="text-amber-400 hover:underline">
                Not signed in
              </Link>
            )}
            <Link href="/" className="text-slate-500 hover:text-slate-300">
              Back to game
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-6 py-6">
        {status === 'authenticated' ? children : <SignInPrompt />}
      </main>
    </div>
  );
}

function SignInPrompt() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-8 text-center">
      <h1 className="text-lg font-semibold text-slate-100">Sign in required</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
        The admin API authenticates with the same wallet session as the game. Connect and sign in
        from the main site, then return here.
      </p>
      <Link
        href="/"
        className="mt-4 inline-block rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
      >
        Go to sign in
      </Link>
    </div>
  );
}

/**
 * Renders the API's own refusal rather than a generic error.
 *
 * A 403 here means the session is valid but under-privileged, and saying so
 * plainly saves the reader from trying to fix it by signing in again — which
 * fails identically, because signing in was never the problem.
 */
export function AdminError({ error }: { error: Error & { status?: number } }) {
  const forbidden = error.status === 403;

  return (
    <div className="rounded-lg border border-rose-900/60 bg-rose-950/30 p-6">
      <h2 className="text-sm font-semibold text-rose-300">
        {forbidden ? 'Not permitted' : 'Request failed'}
      </h2>
      <p className="mt-2 text-sm text-rose-200/70">
        {forbidden
          ? 'Your account does not hold the role this page requires. Signing in again will not change that — ask an administrator to grant it.'
          : error.message}
      </p>
    </div>
  );
}
