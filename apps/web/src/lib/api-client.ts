import { apiErrorSchema } from '@arena/protocol';
import type { z } from 'zod';

import { env } from './env';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

let accessToken: string | null = null;

/** Set after wallet sign-in; kept in memory so it never lands in localStorage. */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export interface RequestOptions<TSchema extends z.ZodType> {
  /**
   * Response schema. Required on purpose — every response is parsed with the
   * same schema the server validates against, so contract drift surfaces at
   * the call site instead of as a render crash deep in a component.
   */
  schema: TSchema;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  baseUrl?: string;
  signal?: AbortSignal;
}

export async function apiRequest<TSchema extends z.ZodType>(
  path: string,
  options: RequestOptions<TSchema>,
): Promise<z.infer<TSchema>> {
  const { schema, method = 'GET', body, baseUrl = env.gatewayUrl, signal } = options;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      // Only when there is actually a body. Declaring a JSON content type on an
      // empty request makes Fastify reject it as malformed — which is correct
      // of Fastify, and was breaking cookie-only session restore.
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
    credentials: 'include',
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiRequestError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.requestId,
      );
    }
    throw new ApiRequestError(response.status, 'UNKNOWN', response.statusText);
  }

  return schema.parse(payload) as z.infer<TSchema>;
}
