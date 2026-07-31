import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeAll, describe, expect, it } from 'vitest';

import { registerRoutes } from '../routes/index.js';
import swaggerPlugin, { API_TAGS, errorResponsesFor } from './swagger.js';

/**
 * Generating the document is the assertion.
 *
 * Every route schema is a Zod object that has to survive conversion to JSON
 * Schema. A schema Zod accepts but the converter chokes on throws at *boot*,
 * which means the failure is a crashed deploy rather than a bad response — and
 * nothing else in the suite would catch it, because the routes themselves are
 * exercised through Fastify's validator, not through the converter.
 *
 * The app is assembled without a database, Redis or an RPC connection: the
 * decorators are stubs, because building the OpenAPI document only reads route
 * *schemas*, never invokes a handler.
 */
async function buildDocumentedApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);

  // Only the shape matters — nothing here is called.
  const noop = async (): Promise<void> => {};
  app.decorate('authenticate', noop);
  app.decorate('requireRole', () => noop);
  app.decorate('prisma', {} as never);
  app.decorate('redis', {} as never);
  app.decorate('solana', {} as never);
  app.decorate('acquireLock', noop as never);
  app.decorate('withdrawalFeeBps', 0);

  await app.register(swaggerPlugin);
  await registerRoutes(app);
  await app.ready();

  return app;
}

describe('errorResponsesFor', () => {
  const codes = (schema: Record<string, unknown>) =>
    Object.keys(errorResponsesFor(schema)).map(Number).sort();

  it('always documents rate limiting and unexpected failure', () => {
    expect(codes({})).toEqual([429, 500]);
  });

  it('adds 400 only where there is input to reject', () => {
    expect(codes({ body: {} })).toContain(400);
    expect(codes({ querystring: {} })).toContain(400);
    expect(codes({})).not.toContain(400);
  });

  it('adds 401 only to guarded routes', () => {
    expect(codes({ security: [{ bearerAuth: [] }] })).toContain(401);
    // An empty array is not a guard — treating it as one would document a 401
    // on public endpoints and send integrators hunting for a token they do not
    // need.
    expect(codes({ security: [] })).not.toContain(401);
    expect(codes({})).not.toContain(401);
  });

  it('adds 404 for a named resource but not for a collection', () => {
    expect(codes({ params: {} })).toContain(404);
    // A list endpoint with filters returns an empty array, never a 404.
    expect(codes({ querystring: {} })).not.toContain(404);
  });
});

describe('gateway OpenAPI document', () => {
  let document: {
    openapi: string;
    paths: Record<string, Record<string, { tags?: string[]; summary?: string }>>;
    tags?: { name: string }[];
  };

  beforeAll(async () => {
    const app = await buildDocumentedApp();
    document = app.swagger() as typeof document;
    await app.close();
  });

  it('emits an OpenAPI 3.1 document', () => {
    expect(document.openapi).toBe('3.1.0');
  });

  it('covers every endpoint group the API promises', () => {
    // Named explicitly rather than snapshotted: a snapshot silently absorbs a
    // deleted route when someone runs it with -u.
    const paths = Object.keys(document.paths);

    for (const path of [
      '/v1/wallet/balance',
      '/v1/wallet/deposits',
      '/v1/wallet/deposits/confirm',
      '/v1/wallet/withdrawals',
      '/v1/wallet/withdrawals/confirm',
      '/v1/wallet/transactions',
      '/v1/rooms',
      '/v1/rooms/{roomId}',
      '/v1/games',
      '/v1/games/{gameId}',
      '/v1/history',
      '/v1/rewards',
      '/v1/rewards/{rewardId}/claim',
      '/v1/leaderboard',
      '/v1/leaderboard/me',
    ]) {
      expect(paths, `missing ${path}`).toContain(path);
    }
  });

  it('keeps operational endpoints out of the contract', () => {
    // Health and metrics are for the orchestrator, not for clients. Left in,
    // a generator emits client stubs for them.
    const paths = Object.keys(document.paths);

    expect(paths).not.toContain('/health/live');
    expect(paths).not.toContain('/health/ready');
    expect(paths).not.toContain('/metrics');
    expect(paths).not.toContain('/openapi.json');
  });

  it('tags and summarises every operation', () => {
    const declared = new Set(API_TAGS.map((tag) => tag.name));
    const untagged: string[] = [];

    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const label = `${method.toUpperCase()} ${path}`;

        if (!operation.tags?.length || !operation.summary) {
          untagged.push(label);
          continue;
        }
        // A tag not declared at the top level renders as an ungrouped section
        // at the bottom of the docs, which is how endpoints get overlooked.
        for (const tag of operation.tags) {
          expect(declared, `${label} uses undeclared tag "${tag}"`).toContain(tag);
        }
      }
    }

    expect(untagged).toEqual([]);
  });

  it('marks authenticated operations as requiring a bearer token', () => {
    // Documenting an endpoint as public when it is not sends integrators
    // chasing a 401 they were told not to expect.
    const balance = document.paths['/v1/wallet/balance']?.get as { security?: unknown[] };
    expect(balance?.security).toEqual([{ bearerAuth: [] }]);
  });

  it('gives every response a description', () => {
    // "Default Response" is @fastify/swagger's placeholder; in the rendered
    // docs it reads as though the payload were unspecified.
    const placeholders: string[] = [];

    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(
        methods as Record<string, { responses: Record<string, { description?: string }> }>,
      )) {
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!response.description || response.description === 'Default Response') {
            placeholders.push(`${method.toUpperCase()} ${path} ${status}`);
          }
        }
      }
    }

    expect(placeholders).toEqual([]);
  });

  it('describes lamport amounts as strings, never numbers', () => {
    // The single most consequential contract detail: a client that parses these
    // as JSON numbers silently corrupts balances above 2^53.
    const deposit = document.paths['/v1/wallet/deposits'] as unknown as {
      post: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { properties: Record<string, { type?: string }> };
              };
            };
          };
        };
      };
    };

    const properties = deposit.post.responses['200'].content['application/json'].schema.properties;
    expect(properties.amount?.type).toBe('string');
  });
});
