import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { config } from '../config.js';

/**
 * CORS, security headers, rate limiting and the cheap half of DDoS defence.
 *
 * "Cheap half" is the honest framing: a volumetric flood is absorbed upstream
 * by the CDN and the load balancer, because by the time packets reach Node the
 * bandwidth has already been paid for. What this layer can do is stop a single
 * client making the service expensive for everyone else — the attack that needs
 * no botnet, and therefore the one that actually happens.
 */

/**
 * Reads `sub` from a bearer token **without verifying it**.
 *
 * Deliberate, and safe only in this context: the value picks a rate-limit
 * bucket and nothing else. Forging it moves the attacker to a different bucket;
 * it does not raise the limit. Named to make the omission obvious at the call
 * site, because using this anywhere else would be a vulnerability.
 */
export function unverifiedSubject(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;

  const parts = authorization.slice(7).split('.');
  if (parts.length !== 3) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
      sub?: unknown;
    };
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * Rate-limit identity: the authenticated user where there is one, else the IP.
 *
 * Both failure modes of IP-only keying are real:
 *
 *  - Thousands of players behind one carrier NAT share a budget and throttle
 *    each other, which is indistinguishable from an outage on their side.
 *  - An attacker holding one token and a pool of addresses gets a fresh budget
 *    per address — precisely the case the limit was meant to cover.
 *
 * The limiter runs before the auth hook on most routes, so the claim is read
 * unverified. See `unverifiedSubject`.
 */
export function rateLimitKey(request: FastifyRequest): string {
  const subject = unverifiedSubject(request.headers.authorization);
  return subject === null ? `ip:${request.ip}` : `user:${subject}`;
}

async function securityPlugin(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: false, // API only; the web app sets its own CSP.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // The API is JSON over HTTPS and is never framed. These are free and close
    // off whole bug classes.
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
  });

  // Registered before the routes that set it. The refresh token lives here
  // rather than in localStorage, where any XSS could read it.
  await app.register(cookie, { secret: config.JWT_SECRET });

  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86_400,
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    // Redis-backed rather than in-process: with N replicas a per-process
    // counter hands an attacker N times the budget by spreading requests.
    redis: app.redis as never,
    nameSpace: 'gateway-rl:',
    keyGenerator: rateLimitKey,
    // The orchestrator polls these on a fixed schedule. A rate-limited liveness
    // probe restarts the pod, turning a traffic spike into an outage.
    allowList: (request) => request.url.startsWith('/health') || request.url === '/metrics',
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    /**
     * The 429.
     *
     * Returns an `Error` carrying `statusCode`, not a response body. The plugin
     * *throws* whatever this returns (`throw params.errorResponseBuilder(...)`),
     * so the value lands in the error handler rather than being sent — and a
     * plain object has no `statusCode`, which made the handler fall back to 500.
     * A rate-limited client was told the server was broken, and lost the
     * retry-after guidance that tells it how long to back off.
     *
     * The handler turns `code`/`message`/`statusCode` into the API's single
     * error envelope, so a 429 stays parseable by the same client code as every
     * other failure.
     *
     * `ban` is deliberately unset: blocking a shared NAT address outright is
     * worse than serving it slowly.
     */
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error(`Rate limit exceeded. Retry in ${Math.ceil(context.ttl / 1000)}s.`), {
        statusCode: 429,
        code: 'RATE_LIMITED',
      }),
  });

  /**
   * Connection-level limits.
   *
   * `bodyLimit` covers the body, but a request with megabytes of headers is
   * parsed before that applies, and a client that dribbles bytes holds a socket
   * open indefinitely unless the server insists the request finishes. Both are
   * cheap for an attacker and neither is addressed by rate limiting, which only
   * counts *completed* requests.
   */
  app.server.maxHeadersCount = 64;
  app.server.headersTimeout = 10_000;
  app.server.requestTimeout = config.REQUEST_TIMEOUT_MS;
  app.server.keepAliveTimeout = 30_000;
  app.server.maxConnections = config.MAX_CONNECTIONS;
}

export default fp(securityPlugin, { name: 'security', dependencies: ['redis'] });
