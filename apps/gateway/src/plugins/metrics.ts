import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    metrics: Registry;
  }
}

/**
 * Prometheus metrics.
 *
 * Route label uses the matched route pattern, never the raw URL — path
 * parameters would otherwise create unbounded cardinality and take down the
 * metrics backend before the API itself.
 */
async function metricsPlugin(app: FastifyInstance): Promise<void> {
  const registry = new Registry();
  registry.setDefaultLabels({ service: config.SERVICE_NAME, region: config.DEPLOY_REGION });

  if (config.METRICS_ENABLED) {
    collectDefaultMetrics({ register: registry });
  }

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  app.decorate('metrics', registry);

  app.addHook('onResponse', async (request, reply) => {
    httpDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  app.get('/metrics', { logLevel: 'silent', schema: { hide: true } }, async (_request, reply) => {
    void reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
}

export default fp(metricsPlugin, { name: 'metrics' });
