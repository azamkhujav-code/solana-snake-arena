import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
  /** Merged into every line; use for nodeId, region, release. */
  base?: Record<string, unknown>;
}

/**
 * Paths scrubbed from every log line.
 *
 * Wallet auth means signatures and nonces flow through request bodies, and a
 * leaked JWT is a full account takeover, so redaction is centralised here
 * rather than left to each call site.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'signature',
  'secretKey',
  'privateKey',
  'keypair',
  'token',
  'accessToken',
  'refreshToken',
  '*.password',
  '*.signature',
  '*.secretKey',
  '*.privateKey',
  '*.accessToken',
  '*.refreshToken',
] as const;

export function createLogger({
  service,
  level = process.env.LOG_LEVEL ?? 'info',
  pretty = process.env.LOG_PRETTY === 'true',
  base = {},
}: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level,
    base: {
      service,
      env: process.env.NODE_ENV ?? 'development',
      release: process.env.GIT_SHA ?? 'unknown',
      region: process.env.DEPLOY_REGION ?? 'local',
      ...base,
    },
    redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
    // Emit epoch millis; the log pipeline renders human time, not the service.
    timestamp: pino.stdTimeFunctions.epochTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (pretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(options);
}

/**
 * Per-request/per-room child logger. Keeping correlation ids on a child means
 * they are attached once instead of threaded through every call.
 */
export function childLogger(parent: Logger, bindings: Record<string, unknown>): Logger {
  return parent.child(bindings);
}

/**
 * Rate-limited logger for hot paths (tick loop, per-packet handlers) where an
 * unbounded error log would itself become the outage.
 *
 * TODO: implement token-bucket suppression and a periodic "suppressed N" line.
 */
export function throttledLogger(_parent: Logger, _perSecond: number): Logger {
  throw new Error('Not implemented');
}
