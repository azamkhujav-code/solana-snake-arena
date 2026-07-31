/**
 * Wire protocol version.
 *
 * The client sends this in the Socket.IO handshake. The server rejects a
 * mismatch with a `PROTOCOL_MISMATCH` close reason so a stale browser tab
 * cannot desync the simulation after a deploy.
 *
 * Bump MINOR for backwards-compatible additions, MAJOR for anything that
 * changes existing field order or semantics.
 */
export const PROTOCOL_VERSION = '1.0.0' as const;

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;

export function isProtocolCompatible(clientVersion: string): boolean {
  const [major] = clientVersion.split('.');
  return Number(major) === PROTOCOL_MAJOR;
}
