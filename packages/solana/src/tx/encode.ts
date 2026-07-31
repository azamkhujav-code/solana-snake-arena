import { sha256 } from '@noble/hashes/sha2.js';
import type { PublicKey } from '@solana/web3.js';

/**
 * Anchor instruction encoding, done by hand.
 *
 * Building instruction data directly rather than through a generated client
 * means the backend does not depend on `anchor build` output being present at
 * runtime. The encoding is small, stable and fully covered by tests.
 */

// @noble/hashes v2 hashes bytes only, so the label is encoded explicitly.
const utf8 = new TextEncoder();

/**
 * Anchor's 8-byte instruction discriminator: the first 8 bytes of
 * `sha256("global:<snake_case_name>")`.
 */
export function instructionDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(utf8.encode(`global:${name}`)).slice(0, 8));
}

/** Account discriminator, used when decoding fetched accounts. */
export function accountDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(utf8.encode(`account:${name}`)).slice(0, 8));
}

/** Borsh u64: 8 bytes, little-endian. */
export function encodeU64(value: bigint | number): Buffer {
  const asBigInt = BigInt(value);
  if (asBigInt < 0n || asBigInt > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`u64 out of range: ${asBigInt}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(asBigInt);
  return buf;
}

/** Borsh u16. */
export function encodeU16(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`u16 out of range: ${value}`);
  }
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
}

/** Borsh u32. */
export function encodeU32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`u32 out of range: ${value}`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

/** Borsh bool: a single byte. */
export function encodeBool(value: boolean): Buffer {
  return Buffer.from([value ? 1 : 0]);
}

export function encodePubkey(value: PublicKey): Buffer {
  return Buffer.from(value.toBytes());
}

/**
 * Borsh `Option<T>`: a presence byte followed by the value when present.
 *
 * Note this is NOT the same as omitting the field — `None` still costs a byte,
 * and getting that wrong shifts every subsequent field.
 */
export function encodeOption<T>(
  value: T | null | undefined,
  encoder: (inner: T) => Buffer,
): Buffer {
  if (value === null || value === undefined) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), encoder(value)]);
}

/** Borsh `Vec<T>`: u32 length prefix, then the elements. */
export function encodeVec<T>(values: readonly T[], encoder: (item: T) => Buffer): Buffer {
  return Buffer.concat([encodeU32(values.length), ...values.map(encoder)]);
}

/** Borsh fixed-size byte array: written raw, with no length prefix. */
export function encodeFixedBytes(value: Uint8Array, length: number): Buffer {
  if (value.length !== length) {
    throw new RangeError(`Expected exactly ${length} bytes, got ${value.length}`);
  }
  return Buffer.from(value);
}

/** Concatenates a discriminator with its encoded arguments. */
export function encodeInstruction(name: string, ...args: Buffer[]): Buffer {
  return Buffer.concat([instructionDiscriminator(name), ...args]);
}
