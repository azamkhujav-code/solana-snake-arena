import { config } from '../config.js';

/**
 * Calls the gateway to reserve and release entry fees.
 *
 * The matchmaker deliberately has no database — it holds volatile queue state
 * in Redis, and money belongs to the gateway. Joining a paid room therefore
 * costs one internal HTTP hop rather than this service reaching into a table it
 * should not know about.
 *
 * The player's own bearer token is forwarded rather than a service credential.
 * The gateway then reserves against *that* player, so a bug here cannot stake
 * someone else's balance — the blast radius is bounded by the caller's own
 * authority instead of by a token that can act as anyone.
 */

export class StakeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StakeError';
  }
}

interface StakeResponse {
  tierId: string;
  reservedLamports: string;
  spendableLamports: string;
  alreadyStaked: boolean;
}

async function call<T>(path: string, token: string, body: unknown): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${config.GATEWAY_INTERNAL_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      // A join should fail fast rather than hold the request open. The player
      // can retry; a hung lobby cannot.
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new StakeError(
      503,
      'STAKE_UNAVAILABLE',
      `Could not reach the wallet service: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    { error?: { code?: string; message?: string } } | T | null;

  if (!response.ok) {
    const failure = payload as { error?: { code?: string; message?: string } } | null;
    throw new StakeError(
      response.status,
      failure?.error?.code ?? 'STAKE_FAILED',
      failure?.error?.message ?? 'Could not reserve the entry fee',
    );
  }

  return payload as T;
}

/** Reserves the tier's entry fee. The amount is decided by the gateway. */
export async function reserveStake(tierId: string, token: string): Promise<StakeResponse> {
  return call<StakeResponse>('/v1/wallet/stake', token, { tierId });
}

export interface AffordResponse {
  tierId: string;
  requiredLamports: string;
  walletLamports: string;
  sufficient: boolean;
}

/**
 * Asks whether the caller's own wallet can cover a room's entry fee.
 *
 * The replacement for `reserveStake` on the join path. Nothing is reserved and
 * nothing moves: the fee is taken from the wallet when the match actually
 * starts, so a player who queues for a room that never fills pays nothing —
 * and there is no reservation left behind to release.
 */
export async function canAfford(tierId: string, token: string): Promise<AffordResponse> {
  return call<AffordResponse>('/v1/wallet/can-afford', token, { tierId });
}

/**
 * Whether the caller's entry fee has actually reached this match's vault.
 *
 * Asked of the chain, through the gateway, because a staked match must not
 * start until every entrant has paid — and "I have paid" is exactly the claim
 * an unpaid client would make. Readiness in a paid room means this and nothing
 * else, so the ready flag cannot be used to enter a match for free.
 */
export async function hasPaid(gameId: string, token: string): Promise<boolean> {
  const result = await call<{ gameId: string; paid: boolean }>('/v1/wallet/has-paid', token, {
    gameId,
  });
  return result.paid;
}

/**
 * Releases a reservation.
 *
 * Failures are swallowed by the caller on the leave path: a player must always
 * be able to leave a lobby, and a stranded reservation is recoverable by the
 * reconciler while a lobby you cannot exit is not.
 */
export async function releaseStake(
  tierId: string,
  token: string,
): Promise<{ releasedLamports: string }> {
  return call<{ releasedLamports: string }>('/v1/wallet/stake/release', token, { tierId });
}
