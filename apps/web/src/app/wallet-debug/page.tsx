import type { Metadata } from 'next';

import { WalletDebug } from '@/components/wallet/WalletDebug';

export const metadata: Metadata = { title: 'Wallet debug', robots: { index: false } };

export default function WalletDebugPage() {
  return <WalletDebug />;
}
