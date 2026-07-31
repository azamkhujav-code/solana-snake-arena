import { describe, expect, it } from 'vitest';

import { clientAddress, ConnectionGuard, type ConnectionGuardOptions } from './connection-guard.js';

const OPTIONS: ConnectionGuardOptions = { ratePerSecond: 2, burst: 5, idleTtlMs: 10_000 };

describe('ConnectionGuard', () => {
  it('allows a burst of reconnects', () => {
    // A page reload legitimately reconnects fast; a burst allowance is what
    // keeps a refresh from looking like an attack.
    const guard = new ConnectionGuard(OPTIONS);

    for (let i = 0; i < 5; i += 1) {
      expect(guard.tryConsume('1.2.3.4', 1000)).toBe(true);
    }
  });

  it('refuses once the burst is spent', () => {
    const guard = new ConnectionGuard(OPTIONS);

    for (let i = 0; i < 5; i += 1) guard.tryConsume('1.2.3.4', 1000);

    expect(guard.tryConsume('1.2.3.4', 1000)).toBe(false);
  });

  it('refills over time at the configured rate', () => {
    const guard = new ConnectionGuard(OPTIONS);
    for (let i = 0; i < 5; i += 1) guard.tryConsume('1.2.3.4', 1000);

    // One second at 2/s buys two attempts, not three.
    expect(guard.tryConsume('1.2.3.4', 2000)).toBe(true);
    expect(guard.tryConsume('1.2.3.4', 2000)).toBe(true);
    expect(guard.tryConsume('1.2.3.4', 2000)).toBe(false);
  });

  it('never refills beyond the burst ceiling', () => {
    const guard = new ConnectionGuard(OPTIONS);
    guard.tryConsume('1.2.3.4', 1000);

    // An hour idle must not bank an hour's worth of credit.
    for (let i = 0; i < 5; i += 1) {
      expect(guard.tryConsume('1.2.3.4', 3_601_000)).toBe(true);
    }
    expect(guard.tryConsume('1.2.3.4', 3_601_000)).toBe(false);
  });

  it('keeps addresses independent', () => {
    const guard = new ConnectionGuard(OPTIONS);
    for (let i = 0; i < 5; i += 1) guard.tryConsume('1.2.3.4', 1000);

    expect(guard.tryConsume('5.6.7.8', 1000)).toBe(true);
  });

  it('evicts idle buckets so the map cannot grow forever', () => {
    // Without this, an attacker cycling source addresses turns the limiter into
    // the memory leak that takes the node down.
    const guard = new ConnectionGuard(OPTIONS);

    for (let i = 0; i < 100; i += 1) guard.tryConsume(`10.0.0.${i}`, 1000);
    expect(guard.size).toBe(100);

    expect(guard.sweep(1000 + 20_000)).toBe(100);
    expect(guard.size).toBe(0);
  });

  it('does not evict a bucket that is still throttled', () => {
    // Evicting mid-throttle would hand the attacker a fresh burst for free —
    // the limiter cancelling itself.
    const guard = new ConnectionGuard({ ratePerSecond: 0.01, burst: 5, idleTtlMs: 1_000 });
    for (let i = 0; i < 5; i += 1) guard.tryConsume('1.2.3.4', 0);

    guard.sweep(2_000);

    expect(guard.size).toBe(1);
    expect(guard.tryConsume('1.2.3.4', 2_000)).toBe(false);
  });
});

describe('clientAddress', () => {
  const handshake = (address: string, forwarded?: string) => ({
    address,
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  });

  it('uses the socket address when not behind a proxy', () => {
    // Trusting the header without a proxy lets a client claim any address it
    // likes and never be limited.
    expect(clientAddress(handshake('9.9.9.9', '1.1.1.1'), false)).toBe('9.9.9.9');
  });

  it('takes the left-most forwarded entry behind a proxy', () => {
    expect(clientAddress(handshake('10.0.0.1', '1.1.1.1, 10.0.0.5'), true)).toBe('1.1.1.1');
  });

  it('trims whitespace in the forwarded chain', () => {
    expect(clientAddress(handshake('10.0.0.1', '  1.1.1.1 , 10.0.0.5'), true)).toBe('1.1.1.1');
  });

  it('falls back to the socket address when the header is absent', () => {
    expect(clientAddress(handshake('10.0.0.1'), true)).toBe('10.0.0.1');
  });

  it('falls back when the header is empty rather than returning a blank key', () => {
    // A blank key would put every such client in one shared bucket.
    expect(clientAddress(handshake('10.0.0.1', ''), true)).toBe('10.0.0.1');
  });
});
