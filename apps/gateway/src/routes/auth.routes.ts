import {
  connectRequestSchema,
  nonceRequestSchema,
  nonceResponseSchema,
  refreshRequestSchema,
  sessionResponseSchema,
  verifySignatureRequestSchema,
} from '@arena/protocol';
import { redisKeys } from '@arena/redis';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { config } from '../config.js';
import {
  clearRefreshCookie,
  isAllowedOrigin,
  REFRESH_COOKIE,
  setRefreshCookie,
} from '../lib/refresh-cookie.js';
import { tooManyRequests, unauthorized } from '../lib/errors.js';
import {
  type AuthDeps,
  connectWallet,
  issueNonce,
  logout,
  NONCE_TTL_SECONDS,
  rotateRefreshToken,
  verifyWalletSignature,
} from '../services/auth.service.js';

/**
 * Wallet authentication.
 *
 * Flow: client requests a nonce -> the wallet signs the exact message the
 * server returned -> the gateway rebuilds that message from its own stored
 * nonce, verifies the ed25519 signature, and issues a token pair.
 *
 * The client never composes the message itself. If it did, the two sides would
 * eventually differ by a newline and the failure — "valid signature rejected"
 * — is miserable to chase.
 */

/**
 * Consecutive signature failures before a wallet is locked out briefly.
 *
 * Signature forgery is not brute-forceable, so this is not about the crypto. It
 * exists to stop an attacker burning nonce issuance and database lookups for a
 * wallet they do not own — cheap for them, not for us.
 */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_SECONDS = 900;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  const deps = (): AuthDeps => ({
    prisma: app.prisma,
    redis: app.redis,
    jwtSign: (payload, options) => app.jwt.sign(payload, options),
    accessTtlSeconds: config.JWT_ACCESS_TTL_SECONDS,
    domain: config.AUTH_DOMAIN,
  });

  /** Progressive backoff, counted per wallet rather than per IP. */
  async function assertNotLockedOut(wallet: string): Promise<void> {
    const failures = await app.redis.get(redisKeys.authFailures(wallet));
    if (failures !== null && Number.parseInt(failures, 10) >= MAX_FAILURES) {
      throw tooManyRequests('Too many failed attempts for this wallet. Try again later.');
    }
  }

  async function recordFailure(wallet: string): Promise<void> {
    const key = redisKeys.authFailures(wallet);
    const count = await app.redis.incr(key);
    // Only the first increment sets the TTL, so the window is fixed from the
    // first failure rather than sliding forward on every subsequent one — which
    // would let a slow attacker stay locked out forever by accident.
    if (count === 1) await app.redis.expire(key, FAILURE_WINDOW_SECONDS);
  }

  api.post(
    '/auth/nonce',
    {
      schema: {
        tags: ['auth'],
        summary: 'Request a nonce to sign',
        description: [
          'Returns a single-use message for the wallet to sign. Sign it exactly',
          'as returned — the server rebuilds the same string from its own stored',
          'nonce and will reject anything else.',
          '',
          'Requesting a second nonce invalidates the first, which bounds an',
          'attacker to one outstanding challenge per wallet rather than letting',
          'them farm a pile of valid ones.',
        ].join('\n'),
        body: nonceRequestSchema,
        response: { 200: nonceResponseSchema },
      },
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    },
    async (request) => {
      await assertNotLockedOut(request.body.wallet);

      const issued = await issueNonce(deps(), request.body.wallet);

      return {
        nonce: issued.nonce,
        message: issued.message,
        expiresAt: Math.floor(new Date(issued.expiresAt).getTime() / 1000),
      };
    },
  );

  api.post(
    '/auth/verify',
    {
      schema: {
        tags: ['auth'],
        summary: 'Exchange a signed nonce for tokens',
        description: [
          'Verifies the ed25519 signature against the wallet public key — on',
          'Solana the address *is* the key, so no lookup is needed.',
          '',
          'The nonce is consumed before the signature is checked, so a failed',
          'attempt burns it. Rate limited harder than the rest of the API.',
        ].join('\n'),
        body: verifySignatureRequestSchema,
        response: { 200: sessionResponseSchema },
      },
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const { wallet, signature, nonce } = request.body;
      await assertNotLockedOut(wallet);

      try {
        const session = await verifyWalletSignature(deps(), {
          wallet,
          signature,
          nonce,
          userAgent: request.headers['user-agent'],
          ip: request.ip,
          ipSalt: config.JWT_SECRET,
        });

        // Clear the counter on success so an honest user who fat-fingered a
        // few attempts is not still throttled afterwards.
        await app.redis.del(redisKeys.authFailures(wallet));

        // Also as an httpOnly cookie, which is what lets a page reload restore
        // the session without asking for another signature. The body copy stays
        // for non-browser clients, which have nowhere to put a cookie.
        setRefreshCookie(reply, session.tokens.refreshToken);

        return session;
      } catch (error) {
        await recordFailure(wallet);
        throw error;
      }
    },
  );

  api.post(
    '/auth/connect',
    {
      schema: {
        tags: ['auth'],
        summary: 'Start a session from a connected wallet',
        description: [
          'Takes a wallet address and a nickname and returns a session. No',
          'signature is required — the game asks for a nickname and a wallet',
          'connection, then drops the player into the room list.',
          '',
          'This does **not** prove the caller controls the wallet. It does not',
          'need to: every lamport that moves is moved by a transaction the',
          'wallet signs, and prizes are paid to the address recorded on chain',
          'rather than to whoever holds a session. The exposure is',
          'impersonation, not theft.',
          '',
          'Use `/auth/nonce` + `/auth/verify` where proof of ownership matters.',
        ].join('\n'),
        body: connectRequestSchema,
        response: { 200: sessionResponseSchema },
      },
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const session = await connectWallet(deps(), {
        wallet: request.body.wallet,
        nickname: request.body.nickname,
        userAgent: request.headers['user-agent'],
        ip: request.ip,
        ipSalt: config.JWT_SECRET,
      });

      setRefreshCookie(reply, session.tokens.refreshToken);
      return session;
    },
  );

  api.post(
    '/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Rotate a refresh token',
        description: [
          'Refresh tokens are single-use. Presenting one that has already been',
          'rotated means two parties hold it, and there is no way to tell which',
          'is the owner — so the whole family is revoked and both must sign in',
          'again. Logging a user out is a cheaper mistake than leaving a thief',
          'with a live session.',
        ].join('\n'),
        // `nullish`, not `optional`: a request with no body arrives as `null`
        // rather than `undefined`, and a browser doing a cookie-only refresh
        // sends exactly that.
        body: refreshRequestSchema.partial().nullish(),
        response: { 200: sessionResponseSchema },
      },
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      // The cookie is `SameSite=None` so it survives the cross-site hop from
      // the web app to this API, which means the browser will also attach it to
      // a request a hostile page makes. That page cannot read the reply through
      // CORS, but spending the single-use token would still end the player's
      // session, so an unrecognised Origin is refused before anything rotates.
      if (!isAllowedOrigin(request.headers.origin)) {
        throw unauthorized('Refresh is not allowed from this origin');
      }

      // The cookie is the browser's copy; the body is for clients that cannot
      // hold one. Body wins when both are present so an explicit token is never
      // silently overridden by a stale cookie.
      const token = request.body?.refreshToken ?? request.cookies[REFRESH_COOKIE];

      if (!token) throw unauthorized('No refresh token supplied');

      const session = await rotateRefreshToken(deps(), {
        refreshToken: token,
        userAgent: request.headers['user-agent'],
        ip: request.ip,
        ipSalt: config.JWT_SECRET,
      });

      // Rotation issues a new token, so the cookie has to follow or the next
      // reload presents a spent one — which the theft check would then treat as
      // a stolen token and revoke the whole family.
      setRefreshCookie(reply, session.tokens.refreshToken);

      return session;
    },
  );

  api.post(
    '/auth/logout',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['auth'],
        summary: 'Revoke the current session',
        description:
          'Revokes every refresh token for the caller and denylists the presented access token until its natural expiry, so the logout takes effect immediately rather than whenever the token would have lapsed.',
        security: [{ bearerAuth: [] }],
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      // `exp` is set by the signer and validated before this handler runs.
      const claims = request.user as unknown as { exp?: number };

      await logout(deps(), {
        userId: request.user.sub,
        jti: request.user.jti,
        accessTokenExp: claims.exp ?? Math.floor(Date.now() / 1000),
      });

      clearRefreshCookie(reply);
      void reply.status(204);
      return null;
    },
  );

  api.get(
    '/auth/me',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['auth'],
        summary: 'Identify the bearer of the current token',
        description:
          'Cheap token introspection — returns only what is already in the JWT claims, with no database read. For the full profile use `/v1/players/{playerId}`.',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            playerId: z.uuid(),
            wallet: z.string(),
            role: z.enum(['PLAYER', 'MODERATOR', 'ADMIN']),
            nonceTtlSeconds: z.number().int(),
          }),
        },
      },
    },
    async (request) => ({
      playerId: request.user.sub,
      wallet: request.user.wallet,
      role: request.user.role,
      nonceTtlSeconds: NONCE_TTL_SECONDS,
    }),
  );
}
