import { PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

import { WalletError } from './errors.js';

/**
 * Phantom wallet integration.
 *
 * Browser-only. The backend never touches this module — it only ever *verifies*
 * signatures produced here (see `auth/verify.ts`).
 */

export interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: { toBytes(): Uint8Array } | null;
  isConnected: boolean;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBytes(): Uint8Array } }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[],
  ): Promise<T[]>;
  on(event: 'connect' | 'disconnect' | 'accountChanged', handler: (...args: never[]) => void): void;
  off(
    event: 'connect' | 'disconnect' | 'accountChanged',
    handler: (...args: never[]) => void,
  ): void;
}

interface PhantomWindow {
  phantom?: { solana?: PhantomProvider };
  solana?: PhantomProvider;
}

/**
 * Locates the injected provider.
 *
 * Prefers `window.phantom.solana` over the legacy `window.solana`: several
 * wallets claim the latter, and `isPhantom` alone is spoofable.
 */
export function getPhantomProvider(): PhantomProvider | null {
  if (typeof window === 'undefined') return null;

  const w = window as unknown as PhantomWindow;
  const provider = w.phantom?.solana ?? w.solana;

  return provider?.isPhantom ? provider : null;
}

export function requirePhantomProvider(): PhantomProvider {
  const provider = getPhantomProvider();
  if (!provider) {
    throw new WalletError('not-found', 'Phantom wallet not detected. Install it from phantom.app.');
  }
  return provider;
}

/** Phantom's user-rejection code. */
const USER_REJECTED = 4001;

function toWalletError(error: unknown, fallback: string): WalletError {
  const code = (error as { code?: number } | undefined)?.code;
  if (code === USER_REJECTED) {
    return new WalletError('rejected', 'Request rejected in wallet', error);
  }
  const message = error instanceof Error ? error.message : fallback;
  return new WalletError('unknown', message, error);
}

/**
 * Connects to Phantom.
 *
 * `onlyIfTrusted` reconnects a previously approved wallet without a popup — the
 * right call on page load. It cannot silently connect a wallet the user has
 * never approved.
 */
export async function connectPhantom(
  options: { onlyIfTrusted?: boolean } = {},
): Promise<PublicKey> {
  const provider = requirePhantomProvider();

  try {
    const result = await provider.connect(options);
    return new PublicKey(result.publicKey.toBytes());
  } catch (error) {
    throw toWalletError(error, 'Failed to connect to Phantom');
  }
}

export async function disconnectPhantom(): Promise<void> {
  const provider = getPhantomProvider();
  if (!provider) return;
  try {
    await provider.disconnect();
  } catch {
    // Disconnect failing is not worth surfacing; the session is gone either way.
  }
}

/**
 * Signs a UTF-8 message and returns a base58 signature.
 *
 * Used for sign-in. Costs nothing, needs no RPC round-trip, and — unlike a
 * throwaway transaction — cannot be replayed as an on-chain action.
 */
export async function signMessageWithPhantom(message: string): Promise<{
  signature: string;
  wallet: string;
}> {
  const provider = requirePhantomProvider();

  if (!provider.isConnected || !provider.publicKey) {
    throw new WalletError('not-connected', 'Connect the wallet before signing');
  }

  try {
    const encoded = new TextEncoder().encode(message);
    const { signature } = await provider.signMessage(encoded, 'utf8');

    return {
      signature: bs58.encode(signature),
      wallet: new PublicKey(provider.publicKey.toBytes()).toBase58(),
    };
  } catch (error) {
    throw toWalletError(error, 'Failed to sign message');
  }
}

/** Signs a transaction without sending it. */
export async function signTransactionWithPhantom<T extends Transaction | VersionedTransaction>(
  transaction: T,
): Promise<T> {
  const provider = requirePhantomProvider();

  if (!provider.isConnected) {
    throw new WalletError('not-connected', 'Connect the wallet before signing');
  }

  try {
    return await provider.signTransaction(transaction);
  } catch (error) {
    throw toWalletError(error, 'Failed to sign transaction');
  }
}
