/**
 * Application errors carry an HTTP status and a stable machine-readable code so
 * the client can branch on `code` rather than parsing prose.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { details?: unknown; expose?: boolean } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    // 5xx messages are hidden from clients; they leak internals.
    this.expose = options.expose ?? statusCode < 500;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, { details });

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Not permitted') => new AppError(403, 'FORBIDDEN', message);

export const notFound = (resource: string) =>
  new AppError(404, 'NOT_FOUND', `${resource} not found`);

export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

export const tooManyRequests = (message = 'Rate limit exceeded') =>
  new AppError(429, 'RATE_LIMITED', message);

export const internal = (message = 'Internal server error') =>
  new AppError(500, 'INTERNAL', message, { expose: false });
