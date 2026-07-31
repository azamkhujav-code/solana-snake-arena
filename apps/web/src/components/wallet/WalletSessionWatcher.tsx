'use client';

import { useSessionRestore } from '@/hooks/use-session-restore';
import { useWalletSession } from '@/hooks/use-wallet-session';

/**
 * Mounts the wallet/session reconciliation effects once, near the root.
 *
 * Renders nothing. It exists as a component because the logic lives in a hook
 * and hooks need a mount point — putting it in `Providers` directly would force
 * that whole subtree to re-render on every wallet state change.
 */
export function WalletSessionWatcher() {
  useWalletSession();
  // Exchanges the httpOnly refresh cookie for an access token on load, so a
  // page reload does not ask the wallet for another signature.
  useSessionRestore();
  return null;
}
