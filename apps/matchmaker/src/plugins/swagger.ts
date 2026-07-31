import { apiErrorSchema } from '@arena/protocol';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

import { config } from '../config.js';

/**
 * Names an undescribed success schema, which @fastify/swagger would otherwise
 * label "Default Response" — reading as though the shape were unspecified.
 */
function described(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  const schema = value as { description?: unknown; describe?: (text: string) => unknown };
  if (typeof schema.describe !== 'function' || typeof schema.description === 'string') return value;

  return schema.describe('Success');
}

/**
 * Attaches the shared error envelope to every operation, on the same rules as
 * the gateway: 400 where there is input to validate, 401 where the route is
 * guarded, 404 where the client names a resource, plus 429/500 everywhere.
 *
 * Duplicated rather than shared with the gateway — a package existing only to
 * hold two dozen lines of doc-generation glue would couple two independently
 * deployable services for no operational benefit.
 */
const transform: typeof jsonSchemaTransform = ({ schema, url, ...rest }) => {
  if (!schema) return jsonSchemaTransform({ schema, url, ...rest });

  // `.describe()` supplies the response description; without it every error
  // renders as "Default Response".
  const error = (description: string) => apiErrorSchema.describe(description);

  const responses: Record<number, unknown> = {
    429: error('Rate limit exceeded. Back off and retry.'),
    500: error('Unexpected server error. Quote `requestId` when reporting it.'),
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
  if (schema.params !== undefined) responses[404] = error('No such room.');

  // Copied, not mutated: Fastify holds this object for the runtime serializer.
  const declared = (schema.response ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    ...responses,
    ...Object.fromEntries(
      Object.entries(declared).map(([status, value]) => [status, described(value)]),
    ),
  };
  return jsonSchemaTransform({ ...rest, url, schema: { ...schema, response: merged } });
};

/**
 * OpenAPI for the matchmaker.
 *
 * A separate document from the gateway's on purpose: they are separately
 * deployable services with different scaling characteristics, and merging their
 * specs would imply a single origin that does not exist. The gateway's
 * description points here for lobby operations.
 */
async function swaggerPlugin(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Slither Arena Matchmaker API',
        version: config.GIT_SHA === 'unknown' ? '0.1.0' : config.GIT_SHA,
        description: [
          'Live lobby state and player placement.',
          '',
          'Lobby state is held in Redis, not Postgres — a queue that changes on',
          'every join is the wrong shape for a database, and this service is',
          'polled hard by every browser sitting in the menu.',
          '',
          'Durable records (rooms, completed games, history, rewards) live in the',
          'gateway API.',
          '',
          '### Polling',
          '`GET /v1/lobbies` is designed to be polled every couple of seconds.',
          'Countdowns should be interpolated client-side between polls rather',
          'than by polling faster.',
        ].join('\n'),
        license: { name: 'MIT' },
      },
      servers: [{ url: 'http://localhost:4002', description: 'Local development' }],
      tags: [
        { name: 'lobbies', description: 'Browsing, joining and leaving room queues.' },
        { name: 'matchmaking', description: 'Placement onto a realtime node.' },
        { name: 'internal', description: 'Service-to-service. Not exposed at the edge.' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
    transform,
  });

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
