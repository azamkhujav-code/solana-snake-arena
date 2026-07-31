import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { SignatureVerificationError } from '../errors.js';
import { buildAuthMessage, parseAuthMessage } from './message.js';
import { verifyAuthSignature, verifySignature } from './verify.js';

function makeWallet() {
  const keypair = nacl.sign.keyPair();
  return {
    wallet: bs58.encode(keypair.publicKey),
    sign: (message: string) =>
      bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey)),
  };
}

const params = {
  domain: 'localhost:3000',
  nonce: 'abcdef0123456789abcdef0123456789',
  issuedAt: '2026-07-30T12:00:00.000Z',
  expiresAt: '2026-07-30T12:05:00.000Z',
};

describe('buildAuthMessage', () => {
  it('round-trips through the parser', () => {
    const { wallet } = makeWallet();
    const message = buildAuthMessage({ ...params, wallet });
    const parsed = parseAuthMessage(message);

    expect(parsed.domain).toBe(params.domain);
    expect(parsed.wallet).toBe(wallet);
    expect(parsed.nonce).toBe(params.nonce);
    expect(parsed.expiresAt).toBe(params.expiresAt);
  });

  it('is byte-for-byte deterministic', () => {
    const { wallet } = makeWallet();
    expect(buildAuthMessage({ ...params, wallet })).toBe(buildAuthMessage({ ...params, wallet }));
  });

  it('changes when any field changes', () => {
    const { wallet } = makeWallet();
    const base = buildAuthMessage({ ...params, wallet });
    expect(buildAuthMessage({ ...params, wallet, nonce: 'different' })).not.toBe(base);
    expect(buildAuthMessage({ ...params, wallet, domain: 'evil.com' })).not.toBe(base);
  });
});

describe('verifySignature', () => {
  it('accepts a genuine signature', () => {
    const { wallet, sign } = makeWallet();
    const message = buildAuthMessage({ ...params, wallet });
    expect(verifySignature({ message, signature: sign(message), wallet })).toBe(true);
  });

  it('rejects a signature over a different message', () => {
    const { wallet, sign } = makeWallet();
    const message = buildAuthMessage({ ...params, wallet });
    const other = buildAuthMessage({ ...params, wallet, nonce: 'other-nonce-value-here' });

    expect(verifySignature({ message, signature: sign(other), wallet })).toBe(false);
  });

  it('rejects a valid signature presented under another wallet', () => {
    const alice = makeWallet();
    const bob = makeWallet();
    const message = buildAuthMessage({ ...params, wallet: alice.wallet });

    // Alice's signature must not authenticate Bob.
    expect(verifySignature({ message, signature: alice.sign(message), wallet: bob.wallet })).toBe(
      false,
    );
  });

  it('returns false rather than throwing on malformed input', () => {
    const { wallet, sign } = makeWallet();
    const message = buildAuthMessage({ ...params, wallet });

    // A throw here would turn a bad request into a 500.
    expect(verifySignature({ message, signature: 'not-base58!!', wallet })).toBe(false);
    expect(verifySignature({ message, signature: sign(message), wallet: 'nope' })).toBe(false);
    expect(verifySignature({ message, signature: bs58.encode(new Uint8Array(10)), wallet })).toBe(
      false,
    );
    expect(
      verifySignature({
        message,
        signature: sign(message),
        wallet: bs58.encode(new Uint8Array(31)),
      }),
    ).toBe(false);
  });

  it('rejects a truncated or bit-flipped signature', () => {
    const { wallet, sign } = makeWallet();
    const message = buildAuthMessage({ ...params, wallet });
    const raw = bs58.decode(sign(message));

    const flipped = Uint8Array.from(raw);
    flipped[0] = (flipped[0]! ^ 0x01) & 0xff;

    expect(verifySignature({ message, signature: bs58.encode(flipped), wallet })).toBe(false);
    expect(verifySignature({ message, signature: bs58.encode(raw.slice(0, 63)), wallet })).toBe(
      false,
    );
  });
});

describe('verifyAuthSignature', () => {
  it('accepts a fresh, correctly signed challenge', () => {
    const { wallet, sign } = makeWallet();
    const message = buildAuthMessage({ ...params, wallet });

    expect(() =>
      verifyAuthSignature({
        ...params,
        wallet,
        signature: sign(message),
        now: new Date('2026-07-30T12:01:00.000Z'),
      }),
    ).not.toThrow();
  });

  it('rejects an expired challenge even when the signature is valid', () => {
    const { wallet, sign } = makeWallet();
    const message = buildAuthMessage({ ...params, wallet });

    expect(() =>
      verifyAuthSignature({
        ...params,
        wallet,
        signature: sign(message),
        now: new Date('2026-07-30T12:06:00.000Z'),
      }),
    ).toThrow(SignatureVerificationError);
  });

  it('rejects an unparseable expiry rather than treating it as valid', () => {
    const { wallet, sign } = makeWallet();
    const message = buildAuthMessage({ ...params, wallet });

    expect(() =>
      verifyAuthSignature({
        ...params,
        expiresAt: 'not-a-date',
        wallet,
        signature: sign(message),
      }),
    ).toThrow(SignatureVerificationError);
  });

  it('rebuilds the message server-side, so a forged message is ignored', () => {
    const { wallet, sign } = makeWallet();
    // The attacker signs a message of their own choosing...
    const forged = 'give me everything';

    // ...but the server verifies against the message it rebuilds from its own
    // stored nonce, so the signature does not match.
    expect(() =>
      verifyAuthSignature({
        ...params,
        wallet,
        signature: sign(forged),
        now: new Date('2026-07-30T12:01:00.000Z'),
      }),
    ).toThrow(SignatureVerificationError);
  });
});
