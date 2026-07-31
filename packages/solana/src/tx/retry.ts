import { isRetryable, SolanaServiceError, toServiceError } from '../errors.js';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each failure. */
  factor?: number;
  /**
   * Jitter ratio in [0, 1]. Without it, a fleet that fails together retries
   * together and reproduces the same thundering herd that caused the failure.
   */
  jitter?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  /** Overrides the default retryable classification. */
  isRetryable?: (error: unknown) => boolean;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Computes the delay before a given attempt: exponential backoff with
 * full-range jitter, clamped to `maxDelayMs`.
 *
 * Exported separately so the schedule can be asserted without waiting on
 * real timers.
 */
export function computeBackoff(
  attempt: number,
  options: Pick<RetryOptions, 'initialDelayMs' | 'maxDelayMs' | 'factor' | 'jitter'> & {
    random?: () => number;
  } = {},
): number {
  const initial = options.initialDelayMs ?? 300;
  const max = options.maxDelayMs ?? 8_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 0.3;
  const random = options.random ?? Math.random;

  const exponential = Math.min(initial * factor ** Math.max(0, attempt - 1), max);
  const spread = exponential * jitter;
  // Centre the jitter on the exponential value so the average is unchanged.
  const jittered = exponential - spread / 2 + random() * spread;

  return Math.max(0, Math.round(Math.min(jittered, max)));
}

/**
 * Retries `fn` while the failure looks transient.
 *
 * Deliberately does NOT retry program errors: those are deterministic, so a
 * retry produces the same rejection while consuming rate-limit budget.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.isRetryable ?? isRetryable;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new SolanaServiceError('Aborted before attempt', { retryable: false });
    }

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw toServiceError(error);
      }

      const delay = computeBackoff(attempt, {
        ...(options.initialDelayMs === undefined ? {} : { initialDelayMs: options.initialDelayMs }),
        ...(options.maxDelayMs === undefined ? {} : { maxDelayMs: options.maxDelayMs }),
        ...(options.factor === undefined ? {} : { factor: options.factor }),
        ...(options.jitter === undefined ? {} : { jitter: options.jitter }),
        ...(options.random === undefined ? {} : { random: options.random }),
      });

      options.onRetry?.(attempt, delay, error);
      await sleep(delay);
    }
  }

  throw toServiceError(lastError);
}
