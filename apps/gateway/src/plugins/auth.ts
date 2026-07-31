import { redisKeys } from '@arena/redis';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { config } from '../config.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { isBeforeCutoff } from '../services/auth.service.js';

export interface AccessTokenClaims {
  sub: string;
  wallet: string;
  role: 'PLAYER' | 'MODERATOR' | 'ADMIN';
  jti: string;
  /**
   * The player's chosen name, for display in game.
   *
   * Carried in the token because the matchmaker mints realtime tickets and has
   * no database to look a name up in. Without it the ticket fell back to the
   * player's UUID, so the in-game leaderboard and kill feed listed everyone as
   * a fragment like `c8ea7d36-ac66-46`.
   */
  nickname?: string | undefined;
  /** Issued-at, in unix seconds. Set by the signer; used for ban cut-offs. */
  iat?: number;
  exp?: number;
}

export type AuthGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module 'fastify' {
  interface FastifyInstance {
    /** Rejects the request unless a valid, non-revoked access token is present. */
    authenticate: AuthGuard;
    /** Rejects unless the caller holds one of the given roles. */
    requireRole: (...roles: AccessTokenClaims['role'][]) => AuthGuard;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenClaims;
    user: AccessTokenClaims;
  }
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: {
      expiresIn: `${config.JWT_ACCESS_TTL_SECONDS}s`,
      // Pinning both stops a token minted for one service being replayed at
      // another, and stops a token from a staging environment working here.
      iss: config.AUTH_DOMAIN,
      aud: config.AUTH_DOMAIN,
    },
    verify: { allowedIss: config.AUTH_DOMAIN, allowedAud: config.AUTH_DOMAIN },
  });

  /**
   * Two revocation checks, because they answer different questions.
   *
   * The jti denylist handles "this specific token was logged out". The per-user
   * cut-off handles "every token this user holds is void" — needed for a ban,
   * because jti values are not stored anywhere and so cannot be enumerated.
   *
   * Both are Redis reads on every authenticated request. That is one round trip
   * against a token TTL measured in minutes, and the alternative is a banned
   * player who keeps playing until their token happens to lapse.
   */
  const authenticate: AuthGuard = async (request, _reply) => {
    try {
      await request.jwtVerify();
    } catch {
      throw unauthorized('Invalid or expired token');
    }

    const { jti, sub, iat } = request.user;

    const [revoked, cutoff] = await Promise.all([
      app.redis.exists(redisKeys.revokedToken(jti)),
      app.redis.get(redisKeys.sessionCutoff(sub)),
    ]);

    if (revoked === 1) {
      throw unauthorized('Token has been revoked');
    }
    if (isBeforeCutoff(iat, cutoff)) {
      throw unauthorized('Session was revoked; sign in again');
    }
  };

  const requireRole =
    (...roles: AccessTokenClaims['role'][]): AuthGuard =>
    async (request, _reply) => {
      if (!roles.includes(request.user.role)) {
        // 403, not 401: the caller proved who they are, they simply are not
        // allowed. A 401 tells the client its token is bad, so it discards a
        // perfectly good session and sends the user back to sign in again —
        // which fails identically, because signing in was never the problem.
        throw forbidden('Insufficient role');
      }
    };

  app.decorate('authenticate', authenticate);
  app.decorate('requireRole', requireRole);
}

export default fp(authPlugin, { name: 'auth', dependencies: ['redis'] });
