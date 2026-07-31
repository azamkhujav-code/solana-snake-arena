import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeAll, describe, expect, it } from 'vitest';

import { lobbyRoutes } from '../routes/lobby.routes.js';
import { matchmakingRoutes } from '../routes/match.routes.js';
import swaggerPlugin from './swagger.js';

/**
 * As in the gateway: building the document is the assertion. A route schema
 * that Zod accepts but the JSON Schema converter rejects fails at boot, and
 * nothing else exercises the converter.
 *
 * Assembled without Redis — producing the document reads route schemas only and
 * never reaches a handler.
 */
async function buildDocumentedApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);

  const noop = async (): Promise<void> => {};
  app.decorate('authenticate', noop);
  app.decorate('requireRole', () => noop);
  app.decorate('redis', {} as never);
  app.decorate('lobbies', {} as never);

  await app.register(swaggerPlugin);
  await app.register(matchmakingRoutes, { prefix: '/v1' });
  await app.register(lobbyRoutes, { prefix: '/v1' });
  await app.ready();

  return app;
}

describe('matchmaker OpenAPI document', () => {
  let document: {
    openapi: string;
    paths: Record<string, Record<string, { tags?: string[]; summary?: string }>>;
  };

  beforeAll(async () => {
    const app = await buildDocumentedApp();
    document = app.swagger() as typeof document;
    await app.close();
  });

  it('documents the lobby operations the gateway spec defers here', () => {
    // The gateway's description tells integrators that join/leave live in this
    // service. If these paths ever move, that cross-reference becomes a lie.
    const paths = Object.keys(document.paths);

    for (const path of [
      '/v1/lobbies',
      '/v1/lobbies/{tierId}',
      '/v1/lobbies/join',
      '/v1/lobbies/leave',
      '/v1/lobbies/ready',
      '/v1/matchmake',
    ]) {
      expect(paths, `missing ${path}`).toContain(path);
    }
  });

  it('tags and summarises every operation', () => {
    const incomplete: string[] = [];

    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!operation.tags?.length || !operation.summary) {
          incomplete.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(incomplete).toEqual([]);
  });

  it('keeps health and metrics out of the contract', () => {
    const paths = Object.keys(document.paths);

    expect(paths).not.toContain('/health/live');
    expect(paths).not.toContain('/metrics');
  });
});
