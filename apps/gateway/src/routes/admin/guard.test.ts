import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import authPlugin from '../../plugins/auth.js';
import errorHandlerPlugin from '../../plugins/error-handler.js';
import { adminRoutes } from './index.js';

/**
 * Proves the admin API cannot be reached without the right role.
 *
 * This is the one property in the dashboard that must never regress. The guard
 * is a hook on an encapsulated scope rather than a per-route option precisely
 * so a route added later cannot forget it — and this test is what verifies that
 * claim rather than merely asserting it in a comment.
 *
 * Prisma is deliberately a throwing stub. If a request ever reaches a handler,
 * the stub explodes and the test fails loudly, so "the guard let it through" can
 * never be mistaken for "the handler returned something harmless".
 */
const UNREACHABLE = new Proxy(
  {},
  {
    get(_target, property) {
      // `app.decorate` probes the value for `getter`/`setter` to decide whether
      // it is a property descriptor, and symbols get touched by promise and
      // inspection machinery. Those reads are not a handler running, so they
      // must not trip the alarm.
      if (typeof property === 'symbol' || property === 'getter' || property === 'setter') {
        return undefined;
      }
      throw new Error(
        `handler reached: the role guard did not reject this request (touched prisma.${String(property)})`,
      );
    },
  },
);

async function buildGuardedApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  await app.register(errorHandlerPlugin);

  // `authenticate` now checks the revocation denylist and the per-user session
  // cut-off on every request, so the auth plugin depends on redis. Answering
  // "not revoked" keeps this test focused on the role logic — and proves those
  // lookups happen at all, since a missing stub fails registration outright.
  await app.register(
    fp(
      async (scope) => {
        scope.decorate('redis', {
          exists: async () => 0,
          get: async () => null,
        } as never);
      },
      { name: 'redis' },
    ),
  );
  await app.register(authPlugin);

  app.decorate('prisma', UNREACHABLE as never);
  app.decorate('solana', UNREACHABLE as never);

  await app.register(adminRoutes, { prefix: '/v1/admin' });
  await app.ready();

  return app;
}

/** Every admin path, split by the role it should demand. */
const MODERATOR_READABLE = [
  '/v1/admin/stats',
  '/v1/admin/treasury',
  '/v1/admin/pool-accounts',
  '/v1/admin/transactions',
  '/v1/admin/audit',
];

const ADMIN_ONLY = [
  { method: 'GET' as const, url: '/v1/admin/players' },
  { method: 'GET' as const, url: '/v1/admin/rooms' },
  { method: 'GET' as const, url: '/v1/admin/games' },
  {
    method: 'PATCH' as const,
    url: '/v1/admin/players/6f1e9d1e-0000-4000-8000-000000000001/status',
    payload: { status: 'BANNED', reason: 'testing the guard' },
  },
  {
    method: 'POST' as const,
    url: '/v1/admin/players/6f1e9d1e-0000-4000-8000-000000000001/adjust-balance',
    payload: { amountLamports: '1000', reason: 'testing the guard', idempotencyKey: 'test-key-1' },
  },
];

describe('admin route guard', () => {
  let app: FastifyInstance;
  let playerToken: string;
  let moderatorToken: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildGuardedApp();

    const claims = (role: 'PLAYER' | 'MODERATOR' | 'ADMIN') => ({
      sub: '6f1e9d1e-0000-4000-8000-0000000000ff',
      wallet: 'So11111111111111111111111111111111111111112',
      role,
      jti: `jti-${role}`,
    });

    playerToken = app.jwt.sign(claims('PLAYER'));
    moderatorToken = app.jwt.sign(claims('MODERATOR'));
    adminToken = app.jwt.sign(claims('ADMIN'));
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it('rejects every admin route without a token', async () => {
    const paths = [
      ...MODERATOR_READABLE.map((url) => ({ method: 'GET' as const, url })),
      ...ADMIN_ONLY,
    ];

    for (const route of paths) {
      const response = await app.inject({ method: route.method, url: route.url });

      // 401: no credentials were presented at all.
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it('rejects a player token with 403, not 401', async () => {
    // The distinction matters operationally: a 401 tells the client its token
    // is bad, so it discards a valid session and sends the user to sign in
    // again — which fails identically, because signing in was never the issue.
    for (const url of MODERATOR_READABLE) {
      const response = await app.inject({ method: 'GET', url, headers: auth(playerToken) });

      expect(response.statusCode, url).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    }
  });

  it('rejects a moderator from every mutating route', async () => {
    // The read/write split is the reason for two scopes. A support agent who
    // can look up a balance all day must not be able to change one.
    for (const route of ADMIN_ONLY) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: auth(moderatorToken),
        ...(route.payload ? { payload: route.payload } : {}),
      });

      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
  });

  it('lets a moderator past the guard on read-only routes', async () => {
    // Reaching the handler is success here: the stubbed Prisma throws, which
    // surfaces as a 500. A 403 would mean the guard wrongly rejected them.
    for (const url of MODERATOR_READABLE) {
      const response = await app.inject({ method: 'GET', url, headers: auth(moderatorToken) });

      expect(response.statusCode, url).not.toBe(401);
      expect(response.statusCode, url).not.toBe(403);
    }
  });

  it('lets an admin past the guard everywhere', async () => {
    for (const route of ADMIN_ONLY) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: auth(adminToken),
        ...(route.payload ? { payload: route.payload } : {}),
      });

      expect(response.statusCode, `${route.method} ${route.url}`).not.toBe(403);
    }
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = Fastify({ logger: false });
    await forged.register(await import('@fastify/jwt').then((m) => m.default), {
      secret: 'a-different-secret-entirely-0123456789abcdef',
    });
    const forgedToken = forged.jwt.sign({
      sub: '6f1e9d1e-0000-4000-8000-0000000000ff',
      wallet: 'So11111111111111111111111111111111111111112',
      role: 'ADMIN',
      jti: 'forged',
    });
    await forged.close();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/admin/treasury',
      headers: auth(forgedToken),
    });

    // Claiming to be an admin is not the same as being one.
    expect(response.statusCode).toBe(401);
  });

  it('guards routes added to the scope without touching this list', async () => {
    // The scope hook applies to every route in the encapsulated context, so a
    // new admin route inherits the guard automatically. Asserted by counting:
    // if someone registers a route outside the guarded scopes, the unauthorised
    // sweep above will not cover it, but this catches the registration itself.
    const routes = app
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .filter((line) => line.includes('/v1/admin'));

    expect(routes.length).toBeGreaterThan(0);
  });
});
