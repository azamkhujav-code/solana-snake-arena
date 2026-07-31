import type { Metadata } from 'next';

import { GamesView } from '@/components/admin/GamesView';

export const metadata: Metadata = { title: 'Games' };

export default function AdminGamesPage() {
  return <GamesView />;
}
