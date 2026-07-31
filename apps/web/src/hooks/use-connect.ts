'use client';

import { sessionResponseSchema } from '@arena/protocol';
import { useWallet } from '@solana/wallet-adapter-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { apiRequest, setAccessToken } from '@/lib/api-client';
import { useSessionStore } from '@/stores/session-store';

/**
 * Starts a session from a connected wallet and a nickname.
 *
 * Replaces the sign-in flow, which asked the wallet to sign a server-issued
 * nonce. That proved ownership before issuing anything, and it cost a signature
 * prompt at the exact moment a new player has been given no reason to approve
 * anything — they wanted to play a snake game and were handed a cryptographic
 * consent dialog.
 *
 * Nothing about the money relies on this session. The entry fee leaves the
 * player's wallet under their own signature, and the prize is paid to the
 * address recorded on chain when they entered. A session that lied about its
 * wallet would be funding someone else's game and handing them the winnings.
 */
export function useConnect() {
  const { publicKey } = useWallet();
  const completeAuth = useSessionStore((state) => state.completeAuth);
  const setNickname = useSessionStore((state) => state.setNickname);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (nickname: string) => {
      if (!publicKey) throw new Error('Connect a wallet first');

      return apiRequest('/v1/auth/connect', {
        method: 'POST',
        body: { wallet: publicKey.toBase58(), nickname },
        schema: sessionResponseSchema,
      });
    },
    onSuccess: (session) => {
      setAccessToken(session.tokens.accessToken);
      completeAuth({
        wallet: session.player.wallet,
        playerId: session.player.id,
        accessToken: session.tokens.accessToken,
      });
      if (session.player.nickname) setNickname(session.player.nickname);

      // Anything fetched while anonymous was fetched without a token.
      void queryClient.invalidateQueries();
    },
  });

  // Depends on `mutateAsync`, not on `mutation`. React Query returns a fresh
  // mutation object every render, so depending on the whole thing would give
  // `connect` a new identity each time and re-run every effect that lists it.
  // `mutateAsync` is stable across renders.
  const { mutateAsync } = mutation;

  const connect = useCallback(
    async (nickname: string) => {
      await mutateAsync(nickname);
    },
    [mutateAsync],
  );

  return {
    connect,
    connecting: mutation.isPending,
    error: mutation.error,
  };
}
