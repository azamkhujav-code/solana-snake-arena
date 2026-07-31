'use client';

import { nonceResponseSchema, sessionResponseSchema } from '@arena/protocol';
import { useWallet } from '@solana/wallet-adapter-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import bs58 from 'bs58';
import { useCallback } from 'react';

import { apiRequest, setAccessToken } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-client';
import { useSessionStore } from '@/stores/session-store';
import { useWalletStore } from '@/stores/wallet-store';

export interface UseAuthResult {
  status: 'anonymous' | 'authenticating' | 'authenticated';
  wallet: string | null;
  signIn: () => Promise<void>;
  signOut: () => void;
  error: Error | null;
}

/**
 * Wallet sign-in.
 *
 * Flow: request a nonce -> Phantom signs the exact message the server will
 * rebuild -> POST the signature -> hold the access token in memory.
 *
 * `signMessage` rather than a throwaway transaction: it costs nothing, needs no
 * RPC round-trip, and cannot be replayed as an on-chain action.
 *
 * The client signs the exact string the server returned; it never composes the
 * message itself. The gateway rebuilds that string from its own stored nonce
 * before verifying, so a client-composed message would fail anyway — and the
 * two would eventually differ by a newline, which is a miserable bug to chase.
 */
export function useAuth(): UseAuthResult {
  const { publicKey, signMessage, connected } = useWallet();
  const status = useSessionStore((state) => state.status);
  const beginAuth = useSessionStore((state) => state.beginAuth);
  const completeAuth = useSessionStore((state) => state.completeAuth);
  const signOutStore = useSessionStore((state) => state.signOut);
  const setLastWallet = useWalletStore((state) => state.setLastWallet);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      if (!connected || !publicKey) {
        throw new Error('Connect a wallet before signing in');
      }
      if (!signMessage) {
        throw new Error('This wallet cannot sign messages');
      }

      const wallet = publicKey.toBase58();
      beginAuth();

      const nonce = await apiRequest('/v1/auth/nonce', {
        method: 'POST',
        body: { wallet },
        schema: nonceResponseSchema,
      });

      // The server sends the exact string to sign. Signing anything else — or
      // rebuilding it slightly differently here — fails verification.
      const signature = await signMessage(new TextEncoder().encode(nonce.message));

      const session = await apiRequest('/v1/auth/verify', {
        method: 'POST',
        body: {
          wallet,
          signature: bs58.encode(signature),
          nonce: nonce.nonce,
        },
        schema: sessionResponseSchema,
      });

      return session;
    },
    onSuccess: (session) => {
      setAccessToken(session.tokens.accessToken);
      completeAuth({
        wallet: session.player.wallet,
        playerId: session.player.id,
        accessToken: session.tokens.accessToken,
      });
      setLastWallet(session.player.wallet);
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    },
    onError: () => {
      setAccessToken(null);
      signOutStore();
    },
  });

  const signIn = useCallback(async () => {
    await mutation.mutateAsync();
  }, [mutation]);

  const signOut = useCallback(() => {
    setAccessToken(null);
    signOutStore();
    // Anything scoped to the signed-in player is now wrong, not merely stale.
    queryClient.removeQueries({ queryKey: queryKeys.session });
  }, [queryClient, signOutStore]);

  return {
    status: mutation.isPending ? 'authenticating' : status,
    wallet: publicKey?.toBase58() ?? null,
    signIn,
    signOut,
    error: mutation.error,
  };
}
