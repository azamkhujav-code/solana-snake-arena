import bs58 from 'bs58';
import nacl from 'tweetnacl';

import { SignatureVerificationError } from '../errors.js';
import { buildAuthMessage, type AuthMessageParams } from './message.js';

export interface VerifySignatureParams {
  /** The exact message that was signed. */
  message: string;
  /** base58-encoded ed25519 signature. */
  signature: string;
  /** base58-encoded wallet address, which is also the ed25519 public key. */
  wallet: string;
}

/**
 * Verifies an ed25519 signature over a UTF-8 message.
 *
 * On Solana the wallet address *is* the ed25519 public key, so no key lookup is
 * needed — decoding the address gives the verifier directly.
 *
 * Returns a boolean rather than throwing so the caller can decide between a
 * 401 and an audit-log entry; `assertValidSignature` throws for convenience.
 */
export function verifySignature({ message, signature, wallet }: VerifySignatureParams): boolean {
  let publicKeyBytes: Uint8Array;
  let signatureBytes: Uint8Array;

  try {
    publicKeyBytes = bs58.decode(wallet);
  } catch {
    return false;
  }
  try {
    signatureBytes = bs58.decode(signature);
  } catch {
    return false;
  }

  // Length checks first: tweetnacl throws on a wrong-sized input, and a throw
  // here would turn a malformed request into a 500.
  if (publicKeyBytes.length !== 32) return false;
  if (signatureBytes.length !== 64) return false;

  const messageBytes = new TextEncoder().encode(message);

  try {
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

/** Throwing variant, with a reason attached. */
export function assertValidSignature(params: VerifySignatureParams): void {
  if (!verifySignature(params)) {
    throw new SignatureVerificationError(`signature does not match wallet ${params.wallet}`);
  }
}

export interface VerifyAuthParams extends AuthMessageParams {
  signature: string;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Full sign-in verification: rebuilds the expected message from server-held
 * values, checks expiry, then verifies the signature.
 *
 * Rebuilding rather than accepting a client-supplied message is the important
 * part — otherwise a caller could sign any string they liked and present it.
 */
export function verifyAuthSignature(params: VerifyAuthParams): void {
  const now = params.now ?? new Date();
  const expiresAt = new Date(params.expiresAt);

  if (Number.isNaN(expiresAt.getTime())) {
    throw new SignatureVerificationError('expiresAt is not a valid date');
  }
  if (now > expiresAt) {
    throw new SignatureVerificationError('nonce has expired');
  }

  const message = buildAuthMessage(params);
  assertValidSignature({
    message,
    signature: params.signature,
    wallet: params.wallet,
  });
}
