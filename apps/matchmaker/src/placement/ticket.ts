import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Join tickets.
 *
 * A ticket binds one player to one room on one node for a short window. It is
 * HMAC-signed so a realtime node can validate it with no network call, and it
 * is also registered in Redis so it can be consumed exactly once — a signature
 * alone would let the same ticket open unlimited sockets.
 *
 * Compact hand-rolled format rather than a JWT: this is an internal credential
 * with a 30-second life, and JWT brings an algorithm-negotiation surface
 * (`alg: none`, key confusion) that buys nothing here.
 */

export interface TicketClaims {
  playerId: string;
  wallet: string;
  roomId: string;
  nodeId: string;
  nickname: string;
  /** Epoch ms. */
  issuedAt: number;
  expiresAt: number;
}

export const TICKET_TTL_MS = 30_000;

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function sign(payload: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

export function mintTicket(claims: TicketClaims, secret: string): string {
  const payload = base64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${payload}.${sign(payload, secret)}`;
}

export class TicketError extends Error {
  constructor(
    readonly reason: 'malformed' | 'bad-signature' | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'TicketError';
  }
}

export function verifyTicket(
  ticket: string,
  secret: string,
  now: number = Date.now(),
): TicketClaims {
  const parts = ticket.split('.');
  if (parts.length !== 2) throw new TicketError('malformed', 'Ticket is malformed');

  const [payload, signature] = parts as [string, string];

  const expected = Buffer.from(sign(payload, secret));
  const provided = Buffer.from(signature);

  // Length must match before timingSafeEqual, which throws on a mismatch — and
  // the comparison itself is constant-time so a forged signature cannot be
  // discovered byte by byte.
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new TicketError('bad-signature', 'Ticket signature is invalid');
  }

  let claims: TicketClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TicketClaims;
  } catch {
    throw new TicketError('malformed', 'Ticket payload is not valid JSON');
  }

  // Expiry is checked after the signature: reading claims from an unverified
  // payload would mean acting on attacker-controlled data.
  if (typeof claims.expiresAt !== 'number' || now >= claims.expiresAt) {
    throw new TicketError('expired', 'Ticket has expired');
  }

  return claims;
}

export function buildTicketClaims(params: {
  playerId: string;
  wallet: string;
  roomId: string;
  nodeId: string;
  nickname: string;
  now?: number;
}): TicketClaims {
  const issuedAt = params.now ?? Date.now();
  return {
    playerId: params.playerId,
    wallet: params.wallet,
    roomId: params.roomId,
    nodeId: params.nodeId,
    nickname: params.nickname,
    issuedAt,
    expiresAt: issuedAt + TICKET_TTL_MS,
  };
}
