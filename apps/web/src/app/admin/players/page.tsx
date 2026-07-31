import type { Metadata } from 'next';
import { Suspense } from 'react';

import { PlayersView } from '@/components/admin/PlayersView';

export const metadata: Metadata = { title: 'Players' };

export default function AdminPlayersPage() {
  // `useSearchParams` opts the route into client-side rendering; without a
  // boundary Next fails the build rather than silently deopting the whole page.
  return (
    <Suspense fallback={<div className="py-16 text-center text-sm text-slate-500">Loading…</div>}>
      <PlayersView />
    </Suspense>
  );
}
