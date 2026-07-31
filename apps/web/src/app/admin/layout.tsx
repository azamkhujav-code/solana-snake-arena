import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Arena Admin' },
  // Keep the operator console out of search results. Not a security control —
  // the gateway's role guard is — but there is no reason to advertise it.
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
