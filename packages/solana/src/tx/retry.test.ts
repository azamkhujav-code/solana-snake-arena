import { describe, expect, it, vi } from 'vitest';

import { ProgramError, RpcError, SolanaServiceError } from '../errors.js';
import { computeBackoff, withRetry } from './retry.js';

const noSleep = async (): Promise<void> => {};

describe('computeBackoff', () => {
  it('grows exponentially', () => {
    const opts = { initialDelayMs: 100, factor: 2, jitter: 0, maxDelayMs: 100_000 };
    expect(computeBackoff(1, opts)).toBe(100);
    expect(computeBackoff(2, opts)).toBe(200);
    expect(computeBackoff(3, opts)).toBe(400);
    expect(computeBackoff(4, opts)).toBe(800);
  });

  it('clamps to maxDelayMs', () => {
    const opts = { initialDelayMs: 100, factor: 10, jitter: 0, maxDelayMs: 5_000 };
    expect(computeBackoff(10, opts)).toBe(5_000);
  });

  it('applies jitter centred on the exponential value', () => {
    const base = { initialDelayMs: 1_000, factor: 2, jitter: 0.5, maxDelayMs: 100_000 };

    // random() = 0 -> lower bound, 1 -> upper bound, 0.5 -> exactly on centre.
    expect(computeBackoff(1, { ...base, random: () => 0 })).toBe(750);
    expect(computeBackoff(1, { ...base, random: () => 1 })).toBe(1_250);
    expect(computeBackoff(1, { ...base, random: () => 0.5 })).toBe(1_000);
  });

  it('never returns a negative delay', () => {
    const opts = { initialDelayMs: 10, factor: 2, jitter: 2, maxDelayMs: 1_000, random: () => 0 };
    expect(computeBackoff(1, opts)).toBeGreaterThanOrEqual(0);
  });
});

describe('withRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RpcError('BlockhashNotFound', true))
      .mockRejectedValueOnce(new RpcError('BlockhashNotFound', true))
      .mockResolvedValue('ok');

    await expect(withRetry(fn, { sleep: noSleep, maxAttempts: 4 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a program error', async () => {
    // Program errors are deterministic — retrying burns rate limit for nothing.
    const fn = vi.fn().mockRejectedValue(new ProgramError(6033));

    await expect(withRetry(fn, { sleep: noSleep, maxAttempts: 5 })).rejects.toBeInstanceOf(
      ProgramError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts', async () => {
    const fn = vi.fn().mockRejectedValue(new RpcError('ETIMEDOUT', true));

    await expect(withRetry(fn, { sleep: noSleep, maxAttempts: 3 })).rejects.toBeInstanceOf(
      SolanaServiceError,
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('classifies raw RPC messages as retryable', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('failed to get recent blockhash: 429 Too Many Requests'))
      .mockResolvedValue('ok');

    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unrecognised error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('some deterministic bug'));

    await expect(withRetry(fn, { sleep: noSleep, maxAttempts: 5 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports each retry with its delay', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RpcError('ECONNRESET', true))
      .mockResolvedValue('ok');

    await withRetry(fn, { sleep: noSleep, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toBe(1);
    expect(typeof onRetry.mock.calls[0]?.[1]).toBe('number');
  });

  it('honours an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(
      withRetry(fn, { sleep: noSleep, signal: controller.signal }),
    ).rejects.toBeInstanceOf(SolanaServiceError);
    expect(fn).not.toHaveBeenCalled();
  });
});
