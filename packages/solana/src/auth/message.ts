/**
 * The exact string a wallet signs to prove ownership.
 *
 * Built by one shared function used by both the browser and the gateway. Two
 * separate implementations drift by a space or a line ending, and the failure
 * — "valid signature rejected" — is miserable to debug.
 */
export interface AuthMessageParams {
  domain: string;
  wallet: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  statement?: string;
}

const DEFAULT_STATEMENT =
  'Sign this message to authenticate. This request will not trigger a transaction or cost any fees.';

export function buildAuthMessage({
  domain,
  wallet,
  nonce,
  issuedAt,
  expiresAt,
  statement = DEFAULT_STATEMENT,
}: AuthMessageParams): string {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    wallet,
    '',
    statement,
    '',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expires At: ${expiresAt}`,
  ].join('\n');
}

/**
 * Parses a signed message back into its fields.
 *
 * The server rebuilds the expected message from its own stored nonce rather
 * than trusting this, but parsing is useful for diagnostics and for asserting
 * round-trip stability in tests.
 */
export function parseAuthMessage(message: string): Partial<AuthMessageParams> & {
  domain?: string;
} {
  const lines = message.split('\n');
  const result: Partial<AuthMessageParams> = {};

  const domainMatch = /^(.+) wants you to sign in with your Solana account:$/.exec(lines[0] ?? '');
  if (domainMatch?.[1]) result.domain = domainMatch[1];
  if (lines[1]) result.wallet = lines[1];

  for (const line of lines) {
    const nonce = /^Nonce: (.+)$/.exec(line);
    if (nonce?.[1]) result.nonce = nonce[1];

    const issued = /^Issued At: (.+)$/.exec(line);
    if (issued?.[1]) result.issuedAt = issued[1];

    const expires = /^Expires At: (.+)$/.exec(line);
    if (expires?.[1]) result.expiresAt = expires[1];
  }

  return result;
}
