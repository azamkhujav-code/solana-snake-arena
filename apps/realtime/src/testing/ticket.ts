import { createHmac } from 'node:crypto';

/**
 * Mints join tickets, for tests only.
 *
 * Production minting lives in the matchmaker; this node only verifies. The
 * format is duplicated here rather than importing across two independently
 * deployable services — and the duplication is safe because the HMAC covers the
 * whole payload, so a format drift fails verification loudly rather than
 * silently accepting the wrong shape. That is the property
 * `io/middleware/authenticate.ts` claims, and these tests are what check it.
 */

export interface TicketClaims {
  playerId: string;
  wallet: string;
  roomId: string;
  nodeId: string;
  nickname: string;
  issuedAt: number;
  expiresAt: number;
}

export const TICKET_TTL_MS = 30_000;

export function mintTicket(claims: TicketClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function buildTicketClaims(params: {
  playerId: string;
  wallet: string;
  roomId: string;
  nodeId: string;
  nickname: string;
  now?: number;
  ttlMs?: number;
}): TicketClaims {
  const issuedAt = params.now ?? Date.now();

  return {
    playerId: params.playerId,
    wallet: params.wallet,
    roomId: params.roomId,
    nodeId: params.nodeId,
    nickname: params.nickname,
    issuedAt,
    expiresAt: issuedAt + (params.ttlMs ?? TICKET_TTL_MS),
  };
}
