import { Connection, type Commitment, type ConnectionConfig } from '@solana/web3.js';

import { RpcError, isRetryable } from './errors.js';

export interface RpcEndpoint {
  http: string;
  ws?: string | undefined;
  /** Higher wins. Used to prefer a paid endpoint over a public fallback. */
  weight?: number;
  label?: string;
}

export interface RpcPoolOptions {
  endpoints: readonly RpcEndpoint[];
  commitment?: Commitment;
  /** Per-request timeout. Devnet public RPC stalls rather than erroring. */
  requestTimeoutMs?: number;
  onFailover?: (from: string, to: string, error: unknown) => void;
}

/**
 * A small RPC pool with failover.
 *
 * Solana RPC providers rate-limit aggressively and devnet in particular returns
 * 429s under any real load. A single `Connection` turns that into user-visible
 * failure, so requests fall through to the next endpoint by weight before
 * giving up.
 */
export class RpcPool {
  private readonly connections: { connection: Connection; endpoint: RpcEndpoint }[];
  private readonly onFailover: RpcPoolOptions['onFailover'];
  private index = 0;

  constructor(options: RpcPoolOptions) {
    if (options.endpoints.length === 0) {
      throw new RpcError('RpcPool requires at least one endpoint', false);
    }

    const commitment = options.commitment ?? 'confirmed';
    const sorted = [...options.endpoints].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

    this.connections = sorted.map((endpoint) => {
      const config: ConnectionConfig = {
        commitment,
        confirmTransactionInitialTimeout: options.requestTimeoutMs ?? 30_000,
        disableRetryOnRateLimit: true, // handled here, with backoff
        ...(endpoint.ws ? { wsEndpoint: endpoint.ws } : {}),
      };
      return { connection: new Connection(endpoint.http, config), endpoint };
    });

    this.onFailover = options.onFailover;
  }

  /** The current primary connection. */
  get current(): Connection {
    const entry = this.connections[this.index];
    if (!entry) throw new RpcError('RpcPool has no available connection', false);
    return entry.connection;
  }

  get endpointCount(): number {
    return this.connections.length;
  }

  get currentLabel(): string {
    const entry = this.connections[this.index];
    return entry?.endpoint.label ?? entry?.endpoint.http ?? 'unknown';
  }

  /**
   * Runs `fn` against the current endpoint, advancing to the next one on a
   * retryable failure. A non-retryable error (a program error, say) is
   * rethrown immediately — failing over would just produce the same result.
   */
  async withFailover<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.connections.length; attempt += 1) {
      const entry = this.connections[this.index];
      if (!entry) break;

      try {
        return await fn(entry.connection);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) throw error;

        const from = this.currentLabel;
        this.index = (this.index + 1) % this.connections.length;
        this.onFailover?.(from, this.currentLabel, error);
      }
    }

    throw new RpcError(`All ${this.connections.length} RPC endpoints failed`, true, lastError);
  }
}

/** Convenience for the common single-endpoint case. */
export function createConnection(options: {
  rpcUrl: string;
  wsUrl?: string | undefined;
  commitment?: Commitment;
}): Connection {
  return new Connection(options.rpcUrl, {
    commitment: options.commitment ?? 'confirmed',
    ...(options.wsUrl ? { wsEndpoint: options.wsUrl } : {}),
    confirmTransactionInitialTimeout: 30_000,
  });
}
