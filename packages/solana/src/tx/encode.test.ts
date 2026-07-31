import { sha256 } from '@noble/hashes/sha2.js';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  accountDiscriminator,
  encodeBool,
  encodeFixedBytes,
  encodeInstruction,
  encodeOption,
  encodePubkey,
  encodeU16,
  encodeU32,
  encodeU64,
  encodeVec,
  instructionDiscriminator,
} from './encode.js';

// @noble/hashes v2 accepts bytes only.
const digest = (label: string) => Buffer.from(sha256(new TextEncoder().encode(label)).slice(0, 8));

describe('instructionDiscriminator', () => {
  it('is the first 8 bytes of sha256("global:<name>")', () => {
    const expected = digest('global:deposit');
    expect(instructionDiscriminator('deposit')).toEqual(expected);
    expect(instructionDiscriminator('deposit')).toHaveLength(8);
  });

  it('is stable across calls and distinct per instruction', () => {
    expect(instructionDiscriminator('deposit')).toEqual(instructionDiscriminator('deposit'));
    expect(instructionDiscriminator('deposit')).not.toEqual(instructionDiscriminator('withdraw'));
  });

  it('uses the snake_case name the program declares', () => {
    // Anchor derives the discriminator from the Rust fn name. Passing camelCase
    // silently produces a valid-looking but wrong 8 bytes.
    expect(instructionDiscriminator('lock_entry_fee')).not.toEqual(
      instructionDiscriminator('lockEntryFee'),
    );
  });

  it('uses a different namespace for accounts', () => {
    expect(accountDiscriminator('Room')).not.toEqual(instructionDiscriminator('Room'));
    expect(accountDiscriminator('Room')).toEqual(digest('account:Room'));
  });
});

describe('scalar encoding', () => {
  it('encodes u64 little-endian', () => {
    expect([...encodeU64(1n)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect([...encodeU64(256n)]).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
  });

  it('handles the full u64 range without precision loss', () => {
    const max = 0xffff_ffff_ffff_ffffn;
    expect(encodeU64(max).readBigUInt64LE()).toBe(max);

    // 1 SOL beyond Number.MAX_SAFE_INTEGER — the exact case a `number`-based
    // implementation would silently corrupt.
    const large = 9_007_199_254_740_993n;
    expect(encodeU64(large).readBigUInt64LE()).toBe(large);
  });

  it('rejects out-of-range values rather than wrapping', () => {
    expect(() => encodeU64(-1n)).toThrow(RangeError);
    expect(() => encodeU64(2n ** 64n)).toThrow(RangeError);
    expect(() => encodeU16(65_536)).toThrow(RangeError);
    expect(() => encodeU32(-1)).toThrow(RangeError);
    expect(() => encodeU16(1.5)).toThrow(RangeError);
  });

  it('encodes u16 and u32 little-endian', () => {
    expect([...encodeU16(500)]).toEqual([0xf4, 0x01]);
    expect([...encodeU32(1)]).toEqual([1, 0, 0, 0]);
  });

  it('encodes bool as a single byte', () => {
    expect([...encodeBool(true)]).toEqual([1]);
    expect([...encodeBool(false)]).toEqual([0]);
  });

  it('encodes a pubkey as its raw 32 bytes', () => {
    const key = PublicKey.default;
    expect(encodePubkey(key)).toHaveLength(32);
    expect([...encodePubkey(key)]).toEqual([...key.toBytes()]);
  });
});

describe('composite encoding', () => {
  it('encodes Option as a presence byte plus the value', () => {
    expect([...encodeOption(null, encodeU16)]).toEqual([0]);
    expect([...encodeOption(500, encodeU16)]).toEqual([1, 0xf4, 0x01]);
    // `None` still costs a byte — omitting it would shift every later field.
    expect(encodeOption(undefined, encodeU16)).toHaveLength(1);
  });

  it('encodes Vec with a u32 length prefix', () => {
    const encoded = encodeVec([1n, 2n], encodeU64);
    expect(encoded).toHaveLength(4 + 16);
    expect(encoded.readUInt32LE(0)).toBe(2);
    expect(encoded.readBigUInt64LE(4)).toBe(1n);
    expect(encoded.readBigUInt64LE(12)).toBe(2n);
  });

  it('encodes an empty Vec as just the length', () => {
    expect([...encodeVec([], encodeU64)]).toEqual([0, 0, 0, 0]);
  });

  it('encodes fixed byte arrays raw, with no length prefix', () => {
    const bytes = new Uint8Array(16).fill(7);
    expect(encodeFixedBytes(bytes, 16)).toHaveLength(16);
    expect(() => encodeFixedBytes(bytes, 8)).toThrow(RangeError);
  });
});

describe('encodeInstruction', () => {
  it('prefixes the discriminator before the arguments', () => {
    const data = encodeInstruction('deposit', encodeU64(1_000_000n));
    expect(data).toHaveLength(8 + 8);
    expect(data.subarray(0, 8)).toEqual(instructionDiscriminator('deposit'));
    expect(data.readBigUInt64LE(8)).toBe(1_000_000n);
  });

  it('produces just the discriminator for a no-arg instruction', () => {
    expect(encodeInstruction('join_room')).toHaveLength(8);
  });
});
