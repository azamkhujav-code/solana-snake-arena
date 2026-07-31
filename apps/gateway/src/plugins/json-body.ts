import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

/**
 * JSON body parsing that tolerates an empty body.
 *
 * Fastify's default parser answers `content-type: application/json` with a zero
 * length body with a 400 — reasonable in isolation, since a client that
 * announces JSON and sends none has probably lost its payload.
 *
 * It is wrong for us. `POST /v1/auth/refresh` reads its token from an httpOnly
 * cookie, so a browser restoring a session legitimately has nothing to send;
 * and clients attach a JSON content type by habit whether or not there is a
 * body. The result was a session restore that failed at the parser, before any
 * route code ran — so no handler, schema or log made it visible.
 *
 * The empty body becomes `undefined` rather than `{}`. A route that requires a
 * field then fails validation on the field, which is the honest error, instead
 * of accepting a silently-invented object.
 */
async function jsonBodyPlugin(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body === '') {
        done(null, undefined);
        return;
      }

      try {
        done(null, JSON.parse(body));
      } catch {
        // Genuinely malformed JSON is still a 400 — only *absence* is excused.
        //
        // The status has to be attached explicitly. Fastify's built-in parser
        // does this for us; a bare `SyntaxError` from `JSON.parse` carries no
        // status, so the error handler treats a client's typo as a server fault
        // and returns 500. That misreports blame and pages the wrong people.
        const invalid = new Error('Body is not valid JSON') as Error & {
          statusCode: number;
          code: string;
        };
        invalid.statusCode = 400;
        invalid.code = 'FST_ERR_CTP_INVALID_JSON';
        done(invalid, undefined);
      }
    },
  );
}

export default fp(jsonBodyPlugin, { name: 'json-body' });
