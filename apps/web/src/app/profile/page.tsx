import { Panel } from '@arena/ui';

import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Profile' };

export default function ProfilePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="mb-6 text-2xl font-bold">Profile</h1>
      <Panel title="Stats">
        {/* TODO: nickname editor, skin picker, match history. */}
        <p className="text-sm text-slate-400">Not implemented yet.</p>
      </Panel>
    </main>
  );
}
