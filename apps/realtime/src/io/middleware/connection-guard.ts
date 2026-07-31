/**
 * Connection-rate limiting at the socket handshake.
 *
 * Distinct from the input rate limiter, which polices an *established* socket.
 * This one polices the act of connecting, because that is where the asymmetry
 * is: a handshake costs the attacker one TCP connection and costs us a TLS
 * negotiation, a Redis GETDEL for the ticket, and a room lookup. Repeated fast
 * enough, a client never has to send a single game packet to hurt the node.
 *
 * In-process and per-IP. Not Redis-backed, on purpose — a round trip to check
 * whether we should accept a connection is work the flood was trying to make us
 * do. An attacker spread across N nodes gets N times the budget, which is the
 * accepted trade: the edge proxy is what handles distributed floods, and this
 * handles the single noisy client that never reaches it.
 */

export interface ConnectionAttempt {
  /** Token-bucket credit. */
  tokens: number;
  lastRefillMs: number;
}

export interface ConnectionGuardOptions {
  /** Sustained connections per second allowed from one address. */
  ratePerSecond: number;
  /** How many may arrive at once — a page reload legitimately reconnects fast. */
  burst: number;
  /** Entries idle this long are dropped, so the map cannot grow forever. */
  idleTtlMs: number;
}

export const DEFAULT_CONNECTION_GUARD: ConnectionGuardOptions = {
  ratePerSecond: 2,
  burst: 10,
  idleTtlMs: 60_000,
};

/**
 * Tracks connection attempts per address.
 *
 * The eviction sweep is the part worth attention: without it, an attacker
 * cycling source addresses turns the limiter itself into the memory leak that
 * takes the node down — the defence becoming the vulnerability.
 */
export class ConnectionGuard {
  private readonly buckets = new Map<string, ConnectionAttempt>();

  constructor(private readonly options: ConnectionGuardOptions = DEFAULT_CONNECTION_GUARD) {}

  get size(): number {
    return this.buckets.size;
  }

  /** True when the attempt is allowed; consumes a token if so. */
  tryConsume(address: string, now: number): boolean {
    let bucket = this.buckets.get(address);

    if (!bucket) {
      bucket = { tokens: this.options.burst, lastRefillMs: now };
      this.buckets.set(address, bucket);
    }

    const elapsed = Math.max(0, now - bucket.lastRefillMs);
    bucket.lastRefillMs = now;
    bucket.tokens = Math.min(
      this.options.burst,
      bucket.tokens + (elapsed / 1_000) * this.options.ratePerSecond,
    );

    if (bucket.tokens < 1) return false;

    bucket.tokens -= 1;
    return true;
  }

  /**
   * Drops idle entries.
   *
   * Only fully-refilled buckets are evicted. Evicting one mid-throttle would
   * hand the attacker a fresh burst allowance for free, which is the exact
   * opposite of what the limiter is for.
   */
  sweep(now: number): number {
    let removed = 0;

    for (const [address, bucket] of this.buckets) {
      const idle = now - bucket.lastRefillMs;
      const refilled = bucket.tokens + (idle / 1_000) * this.options.ratePerSecond;

      if (idle > this.options.idleTtlMs && refilled >= this.options.burst) {
        this.buckets.delete(address);
        removed += 1;
      }
    }

    return removed;
  }
}

/**
 * Extracts the client address from a handshake.
 *
 * Behind a proxy the socket address is the load balancer, so every player would
 * share one bucket and throttle each other into an outage. `trustProxy` must be
 * false when not actually behind one, or a client can simply claim whatever
 * address it likes in the header and never be limited.
 */
export function clientAddress(
  handshake: { address: string; headers: Record<string, unknown> },
  trustProxy: boolean,
): string {
  if (!trustProxy) return handshake.address;

  const forwarded = handshake.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;

  if (typeof raw !== 'string' || raw.length === 0) return handshake.address;

  // Left-most entry is the original client; the rest are the proxy chain.
  return raw.split(',')[0]?.trim() ?? handshake.address;
}
