'use client';

import { Button } from '@arena/ui';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // TODO: forward to Sentry once NEXT_PUBLIC_SENTRY_DSN is wired up.
    console.error(error);
  }, [error]);

  return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div>
        <h1 className="mb-2 text-2xl font-bold">Something broke</h1>
        <p className="mb-6 text-sm text-slate-400">
          {error.digest ? `Reference: ${error.digest}` : 'An unexpected error occurred.'}
        </p>
        <Button onClick={reset}>Try again</Button>
      </div>
    </main>
  );
}
