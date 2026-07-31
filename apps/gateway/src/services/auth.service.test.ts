import { buildAuthMessage } from '@arena/solana';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumeNonce,
  hashIp,
  hashToken,
  isBeforeCutoff,
  issueNonce,
  type AuthDeps,
} from './auth.service.js';

/**
 * A Redis stand-in with real GETDEL semantics.
 *
 * The atomicity of GETDEL is the entire replay defence, so a stub that fakes it
 * as a read followed by a delete would test nothing. This one deletes on read
 * in a single synchronous step, matching the server.
 */
function createFakeRedis() {
  const store = new Map<string, string>();

  return {
    store,
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    incr: vi.fn(async (key: string) => {
      const next = Number.parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async () => 1),
  };
}

const WALLET_KEYPAIR = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const WALLET = bs58.encode(WALLET_KEYPAIR.publicKey);

function sign(message: string): string {
  return bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(message), WALLET_KEYPAIR.secretKey),
  );
}

describe('hashToken', () => {
  it('produces a stable 64-character hex digest', () => {
    const hash = hashToken('a-refresh-token');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('a-refresh-token')).toBe(hash);
  });

  it('never returns the token itself', () => {
    // A database dump must not yield usable credentials.
    expect(hashToken('a-refresh-token')).not.toContain('a-refresh-token');
  });

  it('separates tokens differing by one character', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
  });
});

describe('hashIp', () => {
  it('is stable for the same address and salt', () => {
    expect(hashIp('203.0.113.7', 'salt')).toBe(hashIp('203.0.113.7', 'salt'));
  });

  it('changes with the salt', () => {
    // Without a salt the IPv4 space is enumerable in seconds, which would make
    // the hash a reversible encoding rather than a protection.
    expect(hashIp('203.0.113.7', 'salt-a')).not.toBe(hashIp('203.0.113.7', 'salt-b'));
  });

  it('returns null when there is no address', () => {
    expect(hashIp(undefined, 'salt')).toBeNull();
  });
});

describe('isBeforeCutoff', () => {
  it('is false when no cut-off is set', () => {
    expect(isBeforeCutoff(1000, null)).toBe(false);
  });

  it('rejects a token issued before the cut-off', () => {
    expect(isBeforeCutoff(999, '1000')).toBe(true);
  });

  it('keeps a token issued exactly at the cut-off', () => {
    // JWT `iat` has one-second resolution. Rejecting on equality would log out
    // the very session the sign-in just created.
    expect(isBeforeCutoff(1000, '1000')).toBe(false);
  });

  it('keeps a token issued after the cut-off', () => {
    expect(isBeforeCutoff(1001, '1000')).toBe(false);
  });

  it('fails open on a malformed cut-off rather than locking everyone out', () => {
    // A corrupt Redis value must not become a platform-wide outage.
    expect(isBeforeCutoff(1000, 'not-a-number')).toBe(false);
  });

  it('is false when the token carries no iat', () => {
    expect(isBeforeCutoff(undefined, '1000')).toBe(false);
  });
});

describe('nonce lifecycle', () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let deps: AuthDeps;
  const now = new Date('2026-07-31T12:00:00.000Z');

  beforeEach(() => {
    redis = createFakeRedis();
    deps = {
      prisma: {} as never,
      redis: redis as never,
      jwtSign: () => 'token',
      accessTtlSeconds: 900,
      domain: 'arena.test',
      now: () => now,
    };
  });

  it('issues a message the wallet can sign and the server can rebuild', async () => {
    const issued = await issueNonce(deps, WALLET);

    // The exact string matters: the server rebuilds it from stored fields, so
    // any drift between issue and verify shows up as a rejected valid signature.
    expect(issued.message).toBe(
      buildAuthMessage({
        domain: 'arena.test',
        wallet: WALLET,
        nonce: issued.nonce,
        issuedAt: issued.issuedAt,
        expiresAt: issued.expiresAt,
      }),
    );
    expect(issued.message).toContain(WALLET);
    expect(issued.message).toContain(issued.nonce);
  });

  it('issues an unpredictable nonce', async () => {
    const seen = new Set<string>();

    for (let i = 0; i < 50; i += 1) {
      seen.add((await issueNonce(deps, WALLET)).nonce);
    }

    // A predictable nonce would let an attacker pre-compute a signing request
    // for a wallet they are phishing.
    expect(seen.size).toBe(50);
    expect([...seen][0]?.length).toBeGreaterThanOrEqual(40);
  });

  it('sets a TTL so an unsigned challenge cannot linger', async () => {
    await issueNonce(deps, WALLET);

    expect(redis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'EX', 300);
  });

  it('replaces the previous nonce for the same wallet', async () => {
    const first = await issueNonce(deps, WALLET);
    await issueNonce(deps, WALLET);

    const consumed = await consumeNonce(deps, WALLET);

    // Only one challenge outstanding per wallet, so an attacker cannot farm a
    // pile of valid nonces to spend later.
    expect(consumed?.nonce).not.toBe(first.nonce);
  });

  it('consumes a nonce exactly once', async () => {
    await issueNonce(deps, WALLET);

    expect(await consumeNonce(deps, WALLET)).not.toBeNull();
    // The second read is the replay. It must find nothing.
    expect(await consumeNonce(deps, WALLET)).toBeNull();
  });

  it('serves only one of two concurrent consumers', async () => {
    // The race the whole GETDEL choice exists to prevent: a read-then-delete
    // pair would let both callers observe the nonce as unused.
    await issueNonce(deps, WALLET);

    const [a, b] = await Promise.all([consumeNonce(deps, WALLET), consumeNonce(deps, WALLET)]);
    const winners = [a, b].filter((result) => result !== null);

    expect(winners).toHaveLength(1);
  });

  it('returns null for a wallet with no outstanding challenge', async () => {
    expect(await consumeNonce(deps, WALLET)).toBeNull();
  });

  it('treats a corrupt stored value as absent', async () => {
    redis.store.set('auth:nonce:' + WALLET, '{not json');

    // Indistinguishable from tampering, and a throw here would turn a bad
    // Redis value into a 500 on the sign-in path.
    expect(await consumeNonce(deps, WALLET)).toBeNull();
  });
});

describe('signature verification inputs', () => {
  it('accepts a signature over the exact issued message', () => {
    const message = buildAuthMessage({
      domain: 'arena.test',
      wallet: WALLET,
      nonce: 'abc',
      issuedAt: '2026-07-31T12:00:00.000Z',
      expiresAt: '2026-07-31T12:05:00.000Z',
    });

    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(message),
        bs58.decode(sign(message)),
        WALLET_KEYPAIR.publicKey,
      ),
    ).toBe(true);
  });

  it('rejects a signature over a message differing by one character', () => {
    // Why the server rebuilds rather than trusting a client-supplied string: a
    // caller could otherwise sign anything and present it as proof.
    const message = buildAuthMessage({
      domain: 'arena.test',
      wallet: WALLET,
      nonce: 'abc',
      issuedAt: '2026-07-31T12:00:00.000Z',
      expiresAt: '2026-07-31T12:05:00.000Z',
    });
    const signature = sign(message);

    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(`${message} `),
        bs58.decode(signature),
        WALLET_KEYPAIR.publicKey,
      ),
    ).toBe(false);
  });
});
