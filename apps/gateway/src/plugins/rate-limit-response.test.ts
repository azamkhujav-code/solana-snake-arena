import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import errorHandlerPlugin from './error-handler.js';
import jsonBodyPlugin from './json-body.js';

/**
 * What a client actually receives when it hits the rate limit.
 *
 * Written after finding that it received a 500. `@fastify/rate-limit` *throws*
 * whatever `errorResponseBuilder` returns rather than sending it, so a builder
 * returning a plain response body produces an error with no `statusCode`, and
 * the error handler defaults that to 500.
 *
 * Nothing caught it because no test had ever exceeded a limit — the suite
 * asserted the limiter was configured, not what it does when it fires. The
 * symptom only appears under exactly the traffic the limiter exists for, which
 * is the worst possible time to learn that clients are being told to retry a
 * broken server instead of backing off.
 *
 * This deliberately drives the limit rather than mocking it, because the bug
 * lived in the seam between two libraries and a mock of either would have
 * reproduced the assumption instead of the behaviour.
 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();

  await app.register(jsonBodyPlugin);
  await app.register(sensible);
  await app.register(errorHandlerPlugin);

  await app.register(rateLimit, {
    max: 2,
    timeWindow: 60_000,
    keyGenerator: (request) => request.ip,
    addHeaders: { 'retry-after': true, 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
    // The same builder the real gateway uses; see plugins/security.ts.
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error(`Rate limit exceeded. Retry in ${Math.ceil(context.ttl / 1000)}s.`), {
        statusCode: 429,
        code: 'RATE_LIMITED',
      }),
  });

  app.get('/limited', async () => ({ ok: true }));

  await app.ready();
  return app;
}

describe('rate limit response', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers an exceeded limit with 429, not 500', async () => {
    for (const _ of [1, 2]) {
      const allowed = await app.inject({ method: 'GET', url: '/limited' });
      expect(allowed.statusCode).toBe(200);
    }

    const limited = await app.inject({ method: 'GET', url: '/limited' });
    expect(limited.statusCode).toBe(429);
  });

  it('uses the API error envelope so one client path parses every failure', async () => {
    const limited = await app.inject({ method: 'GET', url: '/limited' });
    const body = limited.json<{ error: { code: string; message: string; requestId: string } }>();

    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.requestId).toBeTruthy();
  });

  it('tells the client how long to wait', async () => {
    // The whole point of a 429 over a 500: a well-behaved client backs off by
    // this much instead of retrying immediately and making the load worse.
    const limited = await app.inject({ method: 'GET', url: '/limited' });

    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json<{ error: { message: string } }>().error.message).toMatch(
      /retry in \d+s/i,
    );
  });

  it('does not withhold the message as if it were a server fault', async () => {
    // 5xx messages are suppressed because they leak internals. Being throttled
    // is the client's business and must survive that rule.
    const limited = await app.inject({ method: 'GET', url: '/limited' });

    expect(limited.json<{ error: { message: string } }>().error.message).not.toBe(
      'Internal server error',
    );
  });
});
