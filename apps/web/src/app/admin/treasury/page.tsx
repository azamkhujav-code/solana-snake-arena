import type { Metadata } from 'next';

import { TreasuryView } from '@/components/admin/TreasuryView';

export const metadata: Metadata = { title: 'Treasury' };

export default function AdminTreasuryPage() {
  return <TreasuryView />;
}
