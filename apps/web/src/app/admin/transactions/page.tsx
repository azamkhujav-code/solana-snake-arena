import type { Metadata } from 'next';
import { Suspense } from 'react';

import { TransactionsView } from '@/components/admin/TransactionsView';

export const metadata: Metadata = { title: 'Transactions' };

export default function AdminTransactionsPage() {
  // `useSearchParams` opts the route into client-side rendering; without a
  // boundary Next fails the build rather than silently deopting the whole page.
  return (
    <Suspense fallback={<div className="py-16 text-center text-sm text-slate-500">Loading…</div>}>
      <TransactionsView />
    </Suspense>
  );
}
