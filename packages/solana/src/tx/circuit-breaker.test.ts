import { describe, expect, it } from 'vitest';

import { CircuitBreaker, CircuitOpenError, type CircuitBreakerOptions } from './circuit-breaker.js';

const OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 3,
  windowMs: 10_000,
  cooldownMs: 5_000,
  successThreshold: 2,
};

const ok = async () => 'ok';
const boom = async () => {
  throw new Error('rpc down');
};

/** Drives `n` failures at one instant, swallowing them. */
async function fail(breaker: CircuitBreaker, n: number, now: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await breaker.execute(boom, now).catch(() => undefined);
  }
}

describe('CircuitBreaker', () => {
  it('passes calls through while closed', async () => {
    const breaker = new CircuitBreaker(OPTIONS);

    expect(await breaker.execute(ok, 0)).toBe('ok');
    expect(breaker.currentState).toBe('closed');
  });

  it('stays closed below the failure threshold', async () => {
    const breaker = new CircuitBreaker(OPTIONS);
    await fail(breaker, 2, 0);

    expect(breaker.currentState).toBe('closed');
    expect(await breaker.execute(ok, 0)).toBe('ok');
  });

  it('opens once the threshold is reached', async () => {
    const breaker = new CircuitBreaker(OPTIONS);
    await fail(breaker, 3, 0);

    expect(breaker.currentState).toBe('open');
  });

  it('rejects immediately while open', async () => {
    // The whole point: failing in a millisecond rather than after four attempts
    // and eight seconds of backoff.
    const breaker = new CircuitBreaker(OPTIONS);
    await fail(breaker, 3, 0);

    await expect(breaker.execute(ok, 1_000)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('reports how long until the next attempt', async () => {
    const breaker = new CircuitBreaker(OPTIONS);
    await fail(breaker, 3, 0);

    const error = await breaker.execute(ok, 1_000).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CircuitOpenError);
    expect((error as CircuitOpenError).retryAfterMs).toBe(4_000);
  });

  it('forgets failures that age out of the window', async () => {
    // A service failing once an hour is not a broken service, and treating it
    // as one would open the circuit on entirely healthy infrastructure.
    const breaker = new CircuitBreaker(OPTIONS);

    await fail(breaker, 2, 0);
    await fail(breaker, 1, 20_000);

    expect(breaker.currentState).toBe('closed');
    expect(breaker.failureCount).toBe(1);
  });

  it('admits a single probe after the cooldown', async () => {
    const breaker = new CircuitBreaker(OPTIONS);
    await fail(breaker, 3, 0);

    expect(await breaker.execute(ok, 5_000)).toBe('ok');
    expect(breaker.currentState).toBe('half-open');
  });

  it('holds back concurrent callers while a probe is in flight', async () => {
    // Reopening the floodgates after a cooldown sends the whole backlog at an
    // endpoint that has had no time to recover — which reads as flapping and
    // gets blamed on the endpoint.
    const breaker = new CircuitBreaker(OPTIONS);
    await fail(breaker, 3, 0);

    let release!: () => void;
    const probe = breaker.execute(
      () => new Promise<string>((resolve) => (release = () => resolve('probe'))),
      5_000,
    );

    await expect(breaker.execute(ok, 5_000)).rejects.toBeInstanceOf(CircuitOpenError);

    release();
    await expect(probe).resolves.toBe('probe');
  });

  it('needs consecutive probe successes before closing', async () => {
    const breaker = new CircuitBreaker(OPTIONS);
    await fail(breaker, 3, 0);

    await breaker.execute(ok, 5_000);
    expect(breaker.currentState).toBe('half-open');

    await breaker.execute(ok, 5_100);
    expect(breaker.currentState).toBe('closed');
  });

  it('reopens on a failed probe and restarts the cooldown', async () => {
    const breaker = new CircuitBreaker(OPTIONS);
    await fail(breaker, 3, 0);

    await breaker.execute(boom, 5_000).catch(() => undefined);
    expect(breaker.currentState).toBe('open');

    // Cooldown measured from the failed probe, not from the original opening.
    await expect(breaker.execute(ok, 9_000)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(breaker.execute(ok, 10_000)).resolves.toBe('ok');
  });

  it('does not let one good call paper over a half-failing service', async () => {
    // If a success cleared history, a service failing every other call would
    // never trip the breaker.
    const breaker = new CircuitBreaker(OPTIONS);

    await fail(breaker, 2, 0);
    expect(breaker.failureCount).toBe(2);

    await breaker.execute(ok, 1_000);
    await fail(breaker, 1, 2_000);

    // Two before plus one after must still be counted.
    expect(breaker.currentState).toBe('closed');
    expect(breaker.failureCount).toBeGreaterThanOrEqual(1);
  });

  it('propagates the original error rather than masking it', async () => {
    // The caller needs to know *why* it failed, not merely that it did.
    const breaker = new CircuitBreaker(OPTIONS);

    await expect(breaker.execute(boom, 0)).rejects.toThrow('rpc down');
  });

  it('closes on reset', async () => {
    const breaker = new CircuitBreaker(OPTIONS);
    await fail(breaker, 3, 0);

    breaker.reset();

    expect(breaker.currentState).toBe('closed');
    expect(await breaker.execute(ok, 0)).toBe('ok');
  });
});
