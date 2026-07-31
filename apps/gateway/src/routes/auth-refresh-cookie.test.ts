import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from '../lib/refresh-cookie.js';
import errorHandlerPlugin from '../plugins/error-handler.js';
import jsonBodyPlugin from '../plugins/json-body.js';

/**
 * The cookie-only session restore, exercised over real HTTP.
 *
 * This exists because of a bug that no unit test could have caught. The refresh
 * token is read from an httpOnly cookie so a page reload does not demand another
 * wallet signature — and the restore failed twice over, both times *before* the
 * handler ran:
 *
 *  1. The default JSON parser rejected a body-less request that still carried a
 *     JSON content type.
 *  2. A missing body reaches the handler as `null`, and the schema was
 *     `.optional()`, which admits `undefined` and not `null`.
 *
 * Neither is visible from inside the route: both return before any route code
 * executes. So the assertions below are deliberately about the *transport* —
 * that a request shaped the way a browser shapes it survives the whole chain of
 * parser, cookie plugin and schema and arrives at the handler.
 *
 * The route is a stand-in rather than the real one, which would drag in Prisma,
 * Redis and JWT signing. Everything those bugs touched is real: the same parser
 * plugin the app registers, the same cookie helpers, the same schema idiom.
 */

const REFRESH_TOKEN = 'a-refresh-token-value';

/** Mirrors the real route's body schema and its cookie-or-body precedence. */
async function buildTestApp(): Promise<FastifyInstance> {
  const { z } = await import('zod');
  const app = Fastify();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(jsonBodyPlugin);
  await app.register(sensible);
  await app.register(errorHandlerPlugin);
  await app.register(cookie, { secret: 'test-secret-at-least-32-characters-long' });

  // Same per-route type provider the real auth routes use, so the schema is
  // interpreted exactly as it is in production rather than through a
  // test-only compiler.
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.post(
    '/v1/auth/refresh',
    { schema: { body: z.object({ refreshToken: z.string() }).partial().nullish() } },
    async (request, reply) => {
      const token = request.body?.refreshToken ?? request.cookies[REFRESH_COOKIE];
      if (token === undefined) return reply.status(401).send({ source: 'none' });

      setRefreshCookie(reply, `${token}-rotated`);
      return { source: request.body?.refreshToken === undefined ? 'cookie' : 'body', token };
    },
  );

  app.post('/v1/auth/verify', async (_request, reply) => {
    setRefreshCookie(reply, REFRESH_TOKEN);
    return { ok: true };
  });

  app.post('/v1/auth/logout', async (_request, reply) => {
    clearRefreshCookie(reply);
    return reply.status(204).send();
  });

  await app.ready();
  return app;
}

describe('cookie-backed session restore', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets the refresh token as an httpOnly cookie on sign-in', () => {
    // `httpOnly` is the entire security argument for this design: script cannot
    // read it, so an XSS that would drain `localStorage` gets nothing.
    return app.inject({ method: 'POST', url: '/v1/auth/verify' }).then((response) => {
      const header = response.headers['set-cookie'];
      const raw = Array.isArray(header) ? header.join('\n') : (header ?? '');

      expect(raw).toContain(`${REFRESH_COOKIE}=`);
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Lax/i);
      // Scoped so it is not attached to every unrelated API call.
      expect(raw).toMatch(/Path=\/v1\/auth/i);
    });
  });

  it('restores from the cookie when the request has no body at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: REFRESH_TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ source: string; token: string }>()).toEqual({
      source: 'cookie',
      token: REFRESH_TOKEN,
    });
  });

  it('restores when a JSON content type is declared but the body is empty', async () => {
    // The exact shape a `fetch` with no body but a habitual content-type header
    // produces. This was a 400 at the parser.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'content-type': 'application/json' },
      payload: '',
      cookies: { [REFRESH_COOKIE]: REFRESH_TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ source: string }>().source).toBe('cookie');
  });

  it('re-sets the cookie after rotation', async () => {
    // Refresh tokens are single-use. If the cookie kept the spent value, the
    // next reload would present it and theft detection would revoke the family
    // — logging out a user who did nothing wrong.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: REFRESH_TOKEN },
    });

    const header = response.headers['set-cookie'];
    const raw = Array.isArray(header) ? header.join('\n') : (header ?? '');
    expect(raw).toContain(`${REFRESH_COOKIE}=${REFRESH_TOKEN}-rotated`);
  });

  it('prefers an explicit body token over the cookie', async () => {
    // Non-browser clients hold the token themselves. An explicit token must
    // never be silently overridden by a stale cookie from another session.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'explicit-token' },
      cookies: { [REFRESH_COOKIE]: REFRESH_TOKEN },
    });

    expect(response.json<{ source: string; token: string }>()).toEqual({
      source: 'body',
      token: 'explicit-token',
    });
  });

  it('is unauthenticated when neither cookie nor body carries a token', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/auth/refresh' });
    expect(response.statusCode).toBe(401);
  });

  it('clears the cookie with attributes that match how it was set', async () => {
    // A cookie is keyed by name *and* path. Clearing on a different path leaves
    // the original in place, and the user stays signed in after asking not to.
    const response = await app.inject({ method: 'POST', url: '/v1/auth/logout' });
    const header = response.headers['set-cookie'];
    const raw = Array.isArray(header) ? header.join('\n') : (header ?? '');

    expect(raw).toContain(`${REFRESH_COOKIE}=`);
    expect(raw).toMatch(/Path=\/v1\/auth/i);
    expect(raw).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });

  it('still rejects genuinely malformed JSON', async () => {
    // Tolerating an empty body must not have turned the parser into one that
    // accepts anything.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { 'content-type': 'application/json' },
      payload: '{"refreshToken":',
    });

    expect(response.statusCode).toBe(400);
  });
});
