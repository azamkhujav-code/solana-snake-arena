import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';

import { AppError } from '../lib/errors.js';

/**
 * Single error shape for the whole API, matching `apiErrorSchema` in
 * @arena/protocol. Every response carries the request id so a user-reported
 * failure can be traced to a log line.
 */
async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error: unknown, request, reply) => {
    const requestId = request.id;

    /**
     * Request validation.
     *
     * Two shapes, because they arrive by different routes. A bare `ZodError`
     * comes from code calling `.parse()` directly; `hasZodFastifySchemaValidationErrors`
     * covers what the type provider throws when a *route schema* rejects.
     *
     * Only checking the first was a real bug: every schema rejection escaped to
     * the generic branch below and came back as `FST_ERR_VALIDATION` with no
     * `details`, so a client was told its request was invalid but not which
     * field. Caught by an integration test, because both halves typecheck and
     * only a real request reveals that they disagree.
     */
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.info({ err: error, requestId }, 'request validation failed');
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request failed validation',
          details: error.validation,
          requestId,
        },
      });
    }

    if (error instanceof ZodError) {
      request.log.info({ err: error, requestId }, 'request validation failed');
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request failed validation',
          details: error.issues,
          requestId,
        },
      });
    }

    /**
     * Response serialisation.
     *
     * The server built a payload its own schema rejects — always a server bug,
     * never the caller's fault, so it is a 500. Reported separately because the
     * generic branch would hide the offending field, and that field is the
     * entire diagnosis.
     */
    if (isResponseSerializationError(error)) {
      request.log.error(
        { err: error, requestId, route: error.method, url: error.url },
        'response failed its own schema',
      );
      return reply.status(500).send({
        error: {
          code: 'RESPONSE_INVALID',
          message: 'Internal server error',
          requestId,
        },
      });
    }

    if (error instanceof AppError) {
      const level = error.statusCode >= 500 ? 'error' : 'info';
      request.log[level]({ err: error, requestId }, error.message);
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.expose ? error.message : 'Internal server error',
          ...(error.details === undefined ? {} : { details: error.details }),
          requestId,
        },
      });
    }

    // Anything else is either a Fastify error (validation, 404, plugin) or an
    // unexpected throw. Both are normalised into the same envelope.
    const fastifyError = error as Partial<FastifyError>;
    const statusCode = fastifyError.statusCode ?? 500;
    const message = fastifyError.message ?? 'Internal server error';

    request.log[statusCode >= 500 ? 'error' : 'info']({ err: error, requestId }, message);

    return reply.status(statusCode).send({
      error: {
        code: fastifyError.code ?? 'INTERNAL',
        // 5xx messages are withheld; they leak internals.
        message: statusCode >= 500 ? 'Internal server error' : message,
        requestId,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        requestId: request.id,
      },
    });
  });
}

export default fp(errorHandlerPlugin, { name: 'error-handler' });
