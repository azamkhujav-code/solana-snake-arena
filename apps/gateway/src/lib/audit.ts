import { type Prisma, Severity } from '@arena/db';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * The admin audit trail.
 *
 * Every mutating admin action writes one of these **inside the same database
 * transaction as the change it describes**. That is the whole point: if the
 * audit write fails the mutation rolls back, so there is no path that produces
 * a balance change nobody can account for. Logging after the fact would leave a
 * window where the two disagree, and that window is exactly where a hostile or
 * careless operator hides.
 *
 * This is separate from application logging. Pino writes request logs to stdout
 * for the log shipper; those answer "what did the process do?". This table
 * answers "who changed this player's money, when, and why?", which has to
 * outlive log retention and be queryable by user id.
 */

/**
 * Actions are a closed set so the audit log can be filtered and alerted on.
 *
 * A free-form string would drift into `player_ban`, `ban-player` and
 * `banPlayer`, at which point no query finds all the bans.
 */
export const AUDIT_ACTIONS = {
  playerStatusChanged: 'admin.player.status_changed',
  playerRoleChanged: 'admin.player.role_changed',
  balanceAdjusted: 'admin.player.balance_adjusted',
  roomUpdated: 'admin.room.updated',
  gameCancelled: 'admin.game.cancelled',
  settlementRetried: 'admin.game.settlement_retried',
  withdrawalReviewed: 'admin.withdrawal.reviewed',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditParams {
  action: AuditAction;
  /** The admin performing the action. */
  actorId: string;
  /** The player the action was performed on, where there is one. */
  userId?: string | null;
  severity?: Severity;
  /**
   * Context worth having at 3am: what changed, from what, to what, and why.
   * Include the operator's stated reason — a status change without one is
   * unreviewable.
   */
  metadata?: Prisma.InputJsonValue;
  /** Hashed, never raw. See `hashIp`. */
  ipHash?: string | null;
}

/**
 * Hashes a client IP for the audit trail.
 *
 * Storing the raw address would make this table a GDPR liability and a juicy
 * target, while the only question it needs to answer is "were these two actions
 * from the same place?" — which a hash answers just as well.
 *
 * The salt matters: without one, the space of IPv4 addresses is small enough to
 * enumerate in seconds, so an unsalted hash is a reversible encoding rather
 * than a protection.
 */
export function hashIp(ip: string | undefined, salt: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 64);
}

/**
 * Writes an audit row.
 *
 * Takes a transaction client rather than the root Prisma client so callers
 * cannot accidentally write the audit entry outside the transaction carrying
 * the change. The type makes the safe usage the easy one.
 */
export async function writeAudit(tx: Prisma.TransactionClient, params: AuditParams): Promise<void> {
  await tx.auditLog.create({
    data: {
      action: params.action,
      actorId: params.actorId,
      userId: params.userId ?? null,
      severity: params.severity ?? Severity.INFO,
      metadata: params.metadata ?? {},
      ipHash: params.ipHash ?? null,
    },
  });
}

/**
 * Pulls the audit context off a request.
 *
 * `request.ip` already honours `trustProxy`, so behind the edge proxy this is
 * the client address rather than the load balancer's.
 */
export function auditContext(
  request: FastifyRequest,
  salt: string,
): { actorId: string; ipHash: string | null } {
  return { actorId: request.user.sub, ipHash: hashIp(request.ip, salt) };
}
