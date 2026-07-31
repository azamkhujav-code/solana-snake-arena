'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { SolanaWalletProvider } from '@/components/wallet/WalletProvider';
import { WalletSessionWatcher } from '@/components/wallet/WalletSessionWatcher';
import { createQueryClient } from '@/lib/query-client';

export function Providers({ children }: { children: ReactNode }) {
  // Created in state, not at module scope: a module-level client would be
  // shared across requests on the server and leak one user's cache into
  // another's response.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <SolanaWalletProvider>
        <WalletSessionWatcher />
        {children}
      </SolanaWalletProvider>
    </QueryClientProvider>
  );
}
