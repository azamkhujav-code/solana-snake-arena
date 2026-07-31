import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import authPlugin from '../plugins/auth.js';
import errorHandlerPlugin from '../plugins/error-handler.js';
import { registerRoutes } from './index.js';

/**
 * HTTP integration tests.
 *
 * These drive the real Fastify app through `inject` — real routing, real Zod
 * validation, real auth hooks, real error serialisation. Only the two things
 * that need a network are substituted: Postgres and Redis.
 *
 * What this catches that unit tests do not: a route registered under the wrong
 * prefix, a schema that validates in isolation but rejects a realistic payload,
 * a guard applied in the wrong order, and an error that escapes as a stack
 * trace instead of the API's envelope. Every one of those is invisible until a
 * request actually travels the whole path.
 */

/** Minimal in-memory Redis covering the commands the request path uses. */
function createRedisStub() {
  const store = new Map<string, string>();

  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    getdel: async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    exists: async (key: string) => (store.has(key) ? 1 : 0),
    incr: async (key: string) => {
      const next = Number.parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, String(next));
      return next;
    },
    expire: async () => 1,
    ping: async () => 'PONG',
  };
}

/**
 * Prisma stub returning empty result sets.
 *
 * Deliberately not a full fake: these tests are about the HTTP layer. A query
 * that is never reached returns nothing; a route that *does* reach the database
 * gets an empty list, which is a legitimate state and exercises the empty-case
 * serialisation that a populated fixture would skip.
 */
function createPrismaStub() {
  // A zero-balance custody account, so routes that read one exercise their real
  // serialisation path instead of throwing on an undefined field.
  const custodyAccount = {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'USER_CUSTODY',
    name: 'custody:test',
    balanceLamports: 0n,
    reservedLamports: 0n,
    version: 0,
  };

  const emptyModel = {
    findMany: async () => [],
    findUnique: async () => custodyAccount,
    findFirst: async () => custodyAccount,
    count: async () => 0,
    aggregate: async () => ({ _sum: {} }),
    groupBy: async () => [],
    create: async () => custodyAccount,
    update: async () => custodyAccount,
    updateMany: async () => ({ count: 0 }),
    createMany: async () => ({ count: 0 }),
  };

  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === '$transaction') {
          return async (arg: unknown) =>
            typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(createPrismaStub()) : arg;
        }
        if (typeof property === 'symbol') return undefined;
        return emptyModel;
      },
    },
  );
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  await app.register(errorHandlerPlugin);

  await app.register(
    fp(
      async (scope) => {
        scope.decorate('redis', createRedisStub() as never);
      },
      { name: 'redis' },
    ),
  );

  await app.register(authPlugin);

  app.decorate('prisma', createPrismaStub() as never);
  app.decorate('solana', {
    getVaultBalances: async () => ({ pool: 0n, treasury: 0n }),
  } as never);
  app.decorate('acquireLock', (async () => async () => undefined) as never);
  app.decorate('withdrawalFeeBps', 50);

  await registerRoutes(app);
  await app.ready();

  return app;
}

describe('gateway HTTP integration', () => {
  let app: FastifyInstance;
  let playerToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    playerToken = app.jwt.sign({
      sub: '11111111-1111-4111-8111-111111111111',
      wallet: 'So11111111111111111111111111111111111111112',
      role: 'PLAYER',
      jti: 'test-jti',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  /** Built lazily: the describe body runs before `beforeAll`, so reading
   *  `playerToken` at declaration time captures `undefined`. */
  const auth = () => ({ authorization: `Bearer ${playerToken}` });

  describe('routing', () => {
    it('serves every public list endpoint under /v1', async () => {
      // A route registered under the wrong prefix typechecks perfectly and
      // 404s at runtime — only an actual request finds it.
      for (const url of ['/v1/rooms', '/v1/games', '/v1/leaderboard']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(200);
      }
    });

    it('404s an unknown path with the API error envelope', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/nope' });

      expect(response.statusCode).toBe(404);
      // Not Fastify's default shape: a client parsing errors must not need a
      // special case for routes that do not exist.
      const body = response.json<{ error: { code: string; requestId: string } }>();
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.requestId).toBeTruthy();
    });

    it('keeps health out of /v1 and unauthenticated', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('validation', () => {
    it('rejects a malformed uuid path parameter with 400, not 500', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/games/not-a-uuid' });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an out-of-range limit', async () => {
      // The cap exists so one request cannot ask for the whole table.
      const response = await app.inject({ method: 'GET', url: '/v1/games?limit=100000' });
      expect(response.statusCode).toBe(400);
    });

    it('coerces a numeric query string rather than rejecting it', async () => {
      // Query values arrive as strings; without coercion every paginated
      // endpoint would 400 on its own documented example.
      const response = await app.inject({ method: 'GET', url: '/v1/games?limit=5' });
      expect(response.statusCode).toBe(200);
    });

    it('rejects an unknown enum value', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/rooms?mode=NONSENSE' });
      expect(response.statusCode).toBe(400);
    });

    it('applies schema defaults when a filter is omitted', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/leaderboard' });

      expect(response.statusCode).toBe(200);
      // `window` defaults to daily, and `periodKey` proves the default reached
      // the handler rather than being undefined.
      const body = response.json<{ window: string; periodKey: string }>();
      expect(body.window).toBe('daily');
      expect(body.periodKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('rejects a body that is not an object', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/nonce',
        payload: '"just a string"',
        headers: { 'content-type': 'application/json' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a wallet address that is not base58', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/nonce',
        payload: { wallet: 'not-a-wallet-0OIl' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('authentication', () => {
    it('401s a protected route with no token', async () => {
      for (const url of ['/v1/wallet/balance', '/v1/history', '/v1/rewards']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(401);
      }
    });

    it('401s a token signed with another secret', async () => {
      const forged = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: 'x', role: 'ADMIN' })).toString('base64url'),
        'forged-signature',
      ].join('.');

      const response = await app.inject({
        method: 'GET',
        url: '/v1/wallet/balance',
        headers: { authorization: `Bearer ${forged}` },
      });

      expect(response.statusCode).toBe(401);
    });

    it('accepts a validly signed token', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth() });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ role: string }>().role).toBe('PLAYER');
    });

    it('403s a player reaching an admin route', async () => {
      // 403 not 401 — the distinction the client relies on to decide whether
      // re-authenticating could possibly help.
      const response = await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: auth() });

      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    });

    it('honours the revocation denylist mid-session', async () => {
      // The token is valid and unexpired; only the denylist stands between it
      // and the handler. This is what makes a logout take effect immediately.
      const redis = app.redis as unknown as { store: Map<string, string> };
      redis.store.set('auth:revoked:test-jti', '1');

      const response = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth() });
      expect(response.statusCode).toBe(401);

      redis.store.delete('auth:revoked:test-jti');
    });
  });

  describe('auth flow', () => {
    const wallet = 'So11111111111111111111111111111111111111112';

    it('issues a nonce and the exact message to sign', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/nonce',
        payload: { wallet },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ nonce: string; message: string; expiresAt: number }>();

      expect(body.message).toContain(wallet);
      expect(body.message).toContain(body.nonce);
      expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('rejects a signature that does not match the nonce', async () => {
      await app.inject({ method: 'POST', url: '/v1/auth/nonce', payload: { wallet } });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/verify',
        payload: {
          wallet,
          signature: 'z'.repeat(88),
          nonce: 'a-nonce-that-was-never-issued',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('burns the nonce even on a failed attempt', async () => {
      // Otherwise an attacker with a captured message brute-forces against a
      // nonce that stays alive for its full five minutes.
      const issued = await app.inject({
        method: 'POST',
        url: '/v1/auth/nonce',
        payload: { wallet },
      });
      const { nonce } = issued.json<{ nonce: string }>();

      await app.inject({
        method: 'POST',
        url: '/v1/auth/verify',
        payload: { wallet, signature: 'z'.repeat(88), nonce },
      });

      const replay = await app.inject({
        method: 'POST',
        url: '/v1/auth/verify',
        payload: { wallet, signature: 'z'.repeat(88), nonce },
      });

      expect(replay.statusCode).toBe(401);
      expect(replay.json<{ error: { message: string } }>().error.message).toMatch(
        /unknown, expired or already used/i,
      );
    });
  });

  describe('error envelope', () => {
    it('uses one shape for every failure', async () => {
      const cases = [
        { url: '/v1/nope', expected: 404 },
        { url: '/v1/games/not-a-uuid', expected: 400 },
        { url: '/v1/wallet/balance', expected: 401 },
      ];

      for (const { url, expected } of cases) {
        const response = await app.inject({ method: 'GET', url });
        const body = response.json<{ error?: { code?: string; message?: string } }>();

        expect(response.statusCode, url).toBe(expected);
        // A client should never need to branch on which endpoint failed to
        // find out how to read the failure.
        expect(body.error?.code, url).toBeTruthy();
        expect(body.error?.message, url).toBeTruthy();
      }
    });

    it('never leaks a stack trace', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/games/not-a-uuid' });

      expect(response.body).not.toContain('at Object.');
      expect(response.body).not.toContain('node_modules');
    });
  });

  describe('response contracts', () => {
    it('serialises lamport amounts as strings', async () => {
      // The contract that stops a client corrupting balances above 2^53. A
      // number here would pass every type check and fail only in production.
      const response = await app.inject({
        method: 'GET',
        url: '/v1/wallet/balance',
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ balance: unknown; spendable: unknown }>();
      expect(typeof body.balance).toBe('string');
      expect(typeof body.spendable).toBe('string');
    });

    it('returns a null cursor on the last page rather than omitting it', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/games' });

      const body = response.json<{ games: unknown[]; nextCursor: unknown }>();
      expect(body.games).toEqual([]);
      // `null` and "absent" are different to a client checking whether to page.
      expect(body.nextCursor).toBeNull();
    });

    it('sets cache headers on the endpoints designed to be polled', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/leaderboard' });
      expect(response.headers['cache-control']).toMatch(/max-age/);
    });
  });
});
