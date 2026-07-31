import type { Metadata } from 'next';

import { RoomsView } from '@/components/admin/RoomsView';

export const metadata: Metadata = { title: 'Rooms' };

export default function AdminRoomsPage() {
  return <RoomsView />;
}
