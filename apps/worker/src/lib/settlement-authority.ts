import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Parses the settlement authority secret key from configuration.
 *
 * Two encodings are accepted because two are in circulation and picking one
 * guarantees somebody pastes the other:
 *
 *  - A JSON byte array — what `solana-keygen new --outfile` writes, so it is
 *    what anyone copying from a keypair file will have.
 *  - Base58 — what wallets export, and what the env var's name implies.
 *
 * Both decode to the same 64 bytes. Rejecting one of them would produce
 * "invalid secret key" against a key that is perfectly valid, which is a
 * miserable thing to debug against a file you can see is correct.
 *
 * Returns `undefined` when unset: a worker running without on-chain settlement
 * is a supported configuration, not a misconfiguration. An *invalid* value is a
 * different matter and throws — it means someone intended to enable settlement
 * and it silently would not have worked.
 */
export function loadSettlementAuthority(secret: string | undefined): Keypair | undefined {
  const trimmed = secret?.trim();
  if (!trimmed) return undefined;

  let bytes: Uint8Array;

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('SETTLEMENT_AUTHORITY_SECRET looks like JSON but does not parse');
    }

    if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === 'number')) {
      throw new Error('SETTLEMENT_AUTHORITY_SECRET must be an array of byte values');
    }

    bytes = Uint8Array.from(parsed as number[]);
  } else {
    try {
      bytes = bs58.decode(trimmed);
    } catch {
      throw new Error('SETTLEMENT_AUTHORITY_SECRET is neither valid base58 nor a JSON byte array');
    }
  }

  // Checked before handing to `fromSecretKey`, whose own error mentions neither
  // the variable nor the length it wanted.
  if (bytes.length !== 64) {
    throw new Error(
      `SETTLEMENT_AUTHORITY_SECRET must decode to 64 bytes, got ${bytes.length}. ` +
        'A 32-byte value is the seed, not the full secret key.',
    );
  }

  return Keypair.fromSecretKey(bytes);
}
