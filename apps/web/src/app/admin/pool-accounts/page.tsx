import type { Metadata } from 'next';

import { PoolAccountsView } from '@/components/admin/PoolAccountsView';

export const metadata: Metadata = { title: 'Pool Accounts' };

export default function AdminPoolAccountsPage() {
  return <PoolAccountsView />;
}
