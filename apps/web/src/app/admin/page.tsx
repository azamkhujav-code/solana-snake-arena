import type { Metadata } from 'next';

import { StatisticsView } from '@/components/admin/StatisticsView';

export const metadata: Metadata = { title: 'Statistics' };

export default function AdminStatisticsPage() {
  return <StatisticsView />;
}
