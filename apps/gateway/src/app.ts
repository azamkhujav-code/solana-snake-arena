import { createLogger } from '@arena/logger';
import sensible from '@fastify/sensible';
import underPressure from '@fastify/under-pressure';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { config } from './config.js';
import authPlugin from './plugins/auth.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import feesPlugin from './plugins/fees.js';
import jsonBodyPlugin from './plugins/json-body.js';
import metricsPlugin from './plugins/metrics.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import securityPlugin from './plugins/security.js';
import swaggerPlugin from './plugins/swagger.js';
import solanaPlugin from './plugins/solana.js';
import { registerRoutes } from './routes/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  // Annotated as FastifyBaseLogger so Fastify does not narrow its logger type
  // parameter to pino's concrete Logger. That narrowing is invariant and makes
  // the instance incompatible with every plugin typed against the default.
  const loggerInstance: FastifyBaseLogger = createLogger({
    service: config.SERVICE_NAME,
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
  });

  const app = Fastify({
    loggerInstance,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.BODY_LIMIT_BYTES,
    requestTimeout: config.REQUEST_TIMEOUT_MS,
    // Correlates a client-reported failure with server logs across replicas.
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
  });

  // Zod schemas drive both validation and response serialisation. The type
  // provider is applied per route module rather than to this instance, so
  // third-party plugins typed against the default provider still register.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(jsonBodyPlugin);
  await app.register(sensible);
  await app.register(errorHandlerPlugin);
  await app.register(metricsPlugin);
  await app.register(redisPlugin);
  await app.register(prismaPlugin);
  await app.register(securityPlugin);
  await app.register(authPlugin);
  await app.register(solanaPlugin);
  await app.register(feesPlugin);
  await app.register(swaggerPlugin);

  /**
   * Sheds load before the event loop collapses. Under a thundering-herd login
   * spike it is better to return 503 quickly — the client backs off — than to
   * queue every request until timeouts cascade.
   */
  await app.register(underPressure, {
    maxEventLoopDelay: 1_000,
    maxHeapUsedBytes: 1_024 * 1_024 * 1_024,
    maxEventLoopUtilization: 0.95,
    retryAfter: 5,
    exposeStatusRoute: false,
  });

  await registerRoutes(app);

  return app;
}
