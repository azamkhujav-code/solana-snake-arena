import type { Metadata } from 'next';

import { LeaderboardTable } from '@/components/leaderboard/LeaderboardTable';

export const metadata: Metadata = { title: 'Leaderboard' };

export default function LeaderboardPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="mb-6 text-2xl font-bold">Leaderboard</h1>
      <LeaderboardTable />
    </main>
  );
}
