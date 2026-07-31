'use client';

import { sessionResponseSchema } from '@arena/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { apiRequest, setAccessToken } from '@/lib/api-client';
import { useSessionStore } from '@/stores/session-store';

/**
 * Restores a session on page load, without asking the wallet to sign again.
 *
 * The access token is deliberately memory-only — anything in `localStorage` is
 * readable by any XSS on the page, and a stolen access token is a full account
 * takeover. So a reload always starts anonymous.
 *
 * That is correct and was also miserable: every refresh prompted for another
 * signature. The refresh token now lives in an `httpOnly` cookie, which script
 * cannot read but the browser still sends. Exchanging it for a fresh access
 * token restores the session invisibly, and the two properties hold together —
 * an injected script can act only while the page is open, rather than walking
 * off with a 30-day credential.
 *
 * Runs exactly once. Refresh tokens are single-use, so a double invocation
 * would rotate twice, and the second call would present a token the first had
 * already spent — which the theft check treats as a stolen token and answers by
 * revoking the whole family. React 18's development double-mount makes that a
 * real risk rather than a theoretical one.
 */
export function useSessionRestore(): { restoring: boolean } {
  const completeAuth = useSessionStore((state) => state.completeAuth);
  const [restoring, setRestoring] = useState(true);
  const queryClient = useQueryClient();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      try {
        const session = await apiRequest('/v1/auth/refresh', {
          method: 'POST',
          // No body: the cookie carries the token. Sending an empty object
          // would be indistinguishable from a client that meant to send one.
          schema: sessionResponseSchema,
        });

        setAccessToken(session.tokens.accessToken);
        completeAuth({
          wallet: session.player.wallet,
          playerId: session.player.id,
          accessToken: session.tokens.accessToken,
        });

        // Anything fetched while anonymous was fetched without a token.
        await queryClient.invalidateQueries();
      } catch {
        // No cookie, expired, or revoked. All three mean "sign in normally",
        // which is the state the app is already in — so there is nothing to
        // report and nothing to log.
      } finally {
        setRestoring(false);
      }
    })();
  }, [completeAuth, queryClient]);

  return { restoring };
}
