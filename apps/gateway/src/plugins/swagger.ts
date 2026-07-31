import { apiErrorSchema } from '@arena/protocol';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

import { config } from '../config.js';

/**
 * OpenAPI, generated from the Zod schemas the routes already validate with.
 *
 * Generated rather than hand-written: a hand-maintained spec drifts from the
 * code the first time someone adds a field, and a drifted spec is worse than
 * none because clients trust it. `jsonSchemaTransform` reads the same schemas
 * Fastify uses at runtime, so the document cannot describe a contract the
 * server does not actually enforce.
 */

export const API_TAGS = [
  { name: 'auth', description: 'Wallet-signature authentication.' },
  { name: 'wallet', description: 'Custody balance and the ledger behind it.' },
  { name: 'deposits', description: 'Moving SOL from a player’s wallet into custody.' },
  { name: 'withdrawals', description: 'Moving SOL from custody back out to a wallet.' },
  { name: 'rooms', description: 'Arena configurations and their recent activity.' },
  { name: 'games', description: 'Completed and in-progress matches.' },
  { name: 'history', description: 'A player’s own match history.' },
  { name: 'rewards', description: 'Prize payouts, bonuses and promotional credit.' },
  { name: 'leaderboard', description: 'Rankings across rolling windows.' },
  { name: 'players', description: 'Profiles and aggregate statistics.' },
  {
    name: 'admin',
    description:
      'Operator dashboard. Requires MODERATOR (read) or ADMIN (write); every mutation is written to the audit trail.',
  },
  { name: 'internal', description: 'Service-to-service. Not exposed at the edge.' },
] as const;

/**
 * Every failure the API can produce shares one envelope, so the error responses
 * are attached centrally rather than repeated on ~30 routes — repeated, they
 * would be copied inconsistently and the copies would rot.
 *
 * Which codes apply is derived from the route itself: a route with no input
 * schema cannot fail validation, and a route with no `security` cannot 401.
 * Listing codes an endpoint can never return is its own kind of wrong — it
 * sends integrators writing handlers for branches that never execute.
 */
export function errorResponsesFor(schema: Record<string, unknown>): Record<number, unknown> {
  // `.describe()` supplies the OpenAPI response description; without it every
  // error renders as "Default Response", which tells a reader nothing.
  const error = (description: string) => apiErrorSchema.describe(description);

  const responses: Record<number, unknown> = {
    // Rate limiting is global, and any process can fail unexpectedly.
    429: error('Rate limit exceeded. Back off and retry; `Retry-After` says when.'),
    500: error('Unexpected server error. The message is withheld — quote `requestId`.'),
  };

  if (
    schema.body !== undefined ||
    schema.querystring !== undefined ||
    schema.params !== undefined
  ) {
    responses[400] = error('Request failed validation. `details` lists the offending fields.');
  }
  if (Array.isArray(schema.security) && schema.security.length > 0) {
    responses[401] = error('Missing, malformed or expired access token.');
  }
  // A path parameter means the client names a resource, and a named resource
  // can be absent. Collection endpoints return an empty list instead.
  if (schema.params !== undefined) {
    responses[404] = error('No such resource — or one the caller may not see.');
  }

  return responses;
}

/**
 * Gives an undescribed success schema a description.
 *
 * Without one @fastify/swagger labels the response "Default Response", which
 * reads in the docs as though the endpoint returns something unspecified. The
 * route's own `.describe()` always wins where the author wrote one.
 */
function described(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  const schema = value as { description?: unknown; describe?: (text: string) => unknown };
  if (typeof schema.describe !== 'function' || typeof schema.description === 'string') return value;

  return schema.describe('Success');
}

/**
 * Wraps the Zod transform so error responses are injected *before* conversion,
 * letting them go through the same Zod -> JSON Schema path as everything else.
 *
 * The route's own schema object is copied, not mutated: Fastify holds a
 * reference to it for the runtime serializer, and a status code added here
 * would otherwise change how real responses are serialised.
 */
const transform: typeof jsonSchemaTransform = ({ schema, url, ...rest }) => {
  if (!schema) return jsonSchemaTransform({ schema, url, ...rest });

  const declared = (schema.response ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    ...errorResponsesFor(schema as unknown as Record<string, unknown>),
    // A route that documents its own 404 or 409 wins — the shared defaults are
    // a floor, not an override.
    ...Object.fromEntries(
      Object.entries(declared).map(([status, value]) => [status, described(value)]),
    ),
  };

  return jsonSchemaTransform({ ...rest, url, schema: { ...schema, response: merged } });
};

async function swaggerPlugin(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Slither Arena Gateway API',
        version: config.GIT_SHA === 'unknown' ? '0.1.0' : config.GIT_SHA,
        description: [
          'REST API for wallet custody, match history, rewards and leaderboards.',
          '',
          '**Live lobby operations — browsing rooms, joining and leaving a queue —',
          'are served by the matchmaker service, not this one.** They are split',
          'because they scale differently: the matchmaker holds volatile queue',
          'state in Redis and is polled hard, while this service is database-bound.',
          'See the matchmaker’s own `/docs` for those endpoints.',
          '',
          '### Amounts',
          'Every lamport value crosses the wire as a **decimal string**, never a',
          'number. Values exceed `Number.MAX_SAFE_INTEGER` above roughly 9M SOL,',
          'and JSON has no bigint — a string survives the round trip exactly.',
          '',
          '### Pagination',
          'List endpoints use keyset pagination. Pass the `nextCursor` from a',
          'response as `cursor` on the next request. `OFFSET` is not supported;',
          'it degrades badly on the ledger and match tables.',
          '',
          '### Admin',
          'Everything under `/v1/admin` requires MODERATOR (read) or ADMIN',
          '(write) and is not part of the player-facing contract. Every mutation',
          'is written to the audit trail in the same transaction as the change.',
          '',
          '### Errors',
          'Every failure returns the same envelope: `{ error: { code, message,',
          'details?, requestId } }`. Branch on `code` — it is stable, while',
          '`message` is prose and may be reworded. Quote `requestId` in a support',
          'request; it is what ties a report to a log line.',
        ].join('\n'),
        license: { name: 'MIT' },
      },
      servers: [
        { url: 'http://localhost:4000', description: 'Local development' },
        { url: '/api', description: 'Behind the edge proxy' },
      ],
      tags: [...API_TAGS],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Access token from `POST /v1/auth/verify`. Short-lived; refresh with `POST /v1/auth/refresh`.',
          },
        },
      },
    },
    transform,
  });

  // The UI is dev-only. In production the JSON is still served for client
  // generation, but shipping an interactive console against a live money API
  // is an invitation nobody needs.
  if (config.NODE_ENV !== 'production') {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
    });
  }

  app.get('/openapi.json', { schema: { hide: true }, logLevel: 'silent' }, async () =>
    app.swagger(),
  );
}

export default fp(swaggerPlugin, { name: 'swagger' });
