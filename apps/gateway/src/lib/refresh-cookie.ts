import type { FastifyReply } from 'fastify';

import { config } from '../config.js';

/**
 * The refresh token's browser home.
 *
 * `httpOnly` is the whole point: JavaScript cannot read it, so an XSS that
 * would happily lift a token out of `localStorage` gets nothing. That is also
 * why the access token stays in memory and is never persisted anywhere — the
 * two together mean a script injection can act only for as long as the page is
 * open, rather than walking away with a 30-day credential.
 *
 * The cost is that a page reload has no access token, which is exactly what
 * this cookie fixes: the client silently exchanges it for a fresh one on boot
 * instead of asking the wallet for another signature.
 */
export const REFRESH_COOKIE = 'arena_rt';

/** Scoped to the refresh endpoint so it is not attached to every API call. */
const COOKIE_PATH = '/v1/auth';

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    // `strict` would drop the cookie on any cross-site navigation into the app,
    // which breaks a link from a wallet's in-app browser. `lax` still refuses
    // to send it on cross-site subrequests, which is the CSRF case that matters.
    sameSite: 'lax',
    // Localhost is served over plain HTTP; forcing `secure` there means the
    // cookie is set and never sent back, which looks exactly like a broken
    // session and is miserable to diagnose.
    secure: config.NODE_ENV === 'production',
    path: COOKIE_PATH,
    maxAge: config.JWT_REFRESH_TTL_SECONDS,
    signed: false,
  });
}

/**
 * Clears it on logout.
 *
 * The attributes must match what was set — a cookie is identified by name,
 * path and domain, so clearing with a different path leaves the original in
 * place and the user stays logged in after asking not to be.
 */
export function clearRefreshCookie(reply: FastifyReply): void {
  void reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    path: COOKIE_PATH,
  });
}
