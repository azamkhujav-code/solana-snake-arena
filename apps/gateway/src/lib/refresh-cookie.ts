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

/**
 * Whether the browser will treat a call to this API as cross-site.
 *
 * `lax` was chosen on the assumption that the app and the API are the same
 * site, and in development they are — both localhost. In production they are
 * not, and not by a margin the eTLD+1 rule forgives: `up.railway.app` is on the
 * Public Suffix List, so `web-…up.railway.app` and `gateway-…up.railway.app`
 * are separate registrable domains. `lax` therefore refused to send the cookie
 * on every single API call, `/v1/auth/refresh` failed with no token to read,
 * and each page reload dumped the player back to the sign-in screen.
 *
 * `none` is what a cookie for a cross-site API has to be, and it requires
 * `secure` — which production already is. The CSRF that `lax` was buying
 * protection against is closed explicitly instead, by checking the request's
 * Origin at the refresh endpoint: a forged cross-site POST cannot read the
 * response through CORS, but it could still spend the single-use token and log
 * the player out, which is worth refusing outright.
 */
const crossSite = config.NODE_ENV === 'production';

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: crossSite ? 'none' : 'lax',
    // Localhost is served over plain HTTP; forcing `secure` there means the
    // cookie is set and never sent back, which looks exactly like a broken
    // session and is miserable to diagnose. `none` also *requires* `secure`, so
    // the two must move together.
    secure: crossSite,
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
    sameSite: crossSite ? 'none' : 'lax',
    secure: crossSite,
    path: COOKIE_PATH,
  });
}

/**
 * Whether a request may spend the refresh cookie.
 *
 * The cookie is `SameSite=None` in production, so the browser attaches it to
 * cross-site requests too — including one a hostile page makes on the player's
 * behalf. CORS stops the attacker reading the reply, so this is not a takeover,
 * but refresh tokens are single-use and rotating one the player never asked to
 * rotate ends their session. Refusing an unrecognised Origin costs nothing and
 * closes it.
 *
 * A missing Origin is allowed: browsers always send it on a cross-origin POST,
 * so its absence means a non-browser caller, which is not the CSRF case.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return config.CORS_ORIGINS.includes(origin);
}
