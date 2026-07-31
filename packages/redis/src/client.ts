import { Cluster, Redis, type ClusterNode, type RedisOptions } from 'ioredis';

export interface RedisFactoryOptions {
  url: string;
  clusterNodes?: readonly string[] | undefined;
  tls?: boolean;
  keyPrefix?: string;
  /** Label used in logs and metrics, e.g. "pubsub" or "data". */
  role?: string;
  /**
   * Connection-level error sink.
   *
   * ioredis prints "[ioredis] Unhandled error event" and can crash the process
   * if nothing listens on 'error'. A listener is always attached below; pass
   * this to route those errors into the service logger.
   */
  onError?: (error: Error, role: string) => void;
}

export type RedisClient = Redis | Cluster;

function baseOptions(options: RedisFactoryOptions): RedisOptions {
  return {
    keyPrefix: options.keyPrefix ?? '',
    // The Socket.IO adapter and any blocking command need this off.
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    // Fail fast rather than queueing commands during a partition; the caller
    // decides whether to degrade or reject.
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    ...(options.tls ? { tls: {} } : {}),
  };
}

/**
 * Creates a Redis connection, transparently switching to Cluster mode when
 * `clusterNodes` is populated. Production runs Cluster; local dev runs a single
 * node, and application code should not care which.
 */
export function createRedisClient(options: RedisFactoryOptions): RedisClient {
  const role = options.role ?? 'default';
  let client: RedisClient;

  if (options.clusterNodes && options.clusterNodes.length > 0) {
    const nodes: ClusterNode[] = options.clusterNodes.map((node) => {
      const [host, port] = node.split(':');
      return { host: host ?? '127.0.0.1', port: Number(port ?? 6379) };
    });

    client = new Cluster(nodes, {
      redisOptions: baseOptions(options),
      scaleReads: 'slave',
      clusterRetryStrategy: (attempt) => Math.min(attempt * 300, 5_000),
    });
  } else {
    client = new Redis(options.url, baseOptions(options));
  }

  // Always attached. Without a listener ioredis treats a connection error as an
  // unhandled 'error' event, which is noisy at best and fatal at worst.
  client.on('error', (error: Error) => {
    options.onError?.(error, role);
  });

  return client;
}

/**
 * Resolves once the client can accept commands.
 *
 * Necessary because `enableOfflineQueue` is false. That is the right default —
 * a queued command against a dead Redis looks like it succeeded and surfaces
 * minutes later as missing data — but it means any command issued during the
 * initial connect throws `Stream isn't writeable` instead of waiting.
 *
 * Services that only touch Redis per-request never notice, since the connection
 * is up long before the first request. A service that registers itself at
 * startup hits it every time, and the symptom is a crash-loop on boot that
 * looks like a Redis outage rather than a race.
 *
 * Rejects rather than hanging: a node that cannot reach Redis must fail its
 * startup loudly, not sit in a half-initialised state serving nothing.
 */
export async function waitForRedis(client: RedisClient, timeoutMs = 10_000): Promise<void> {
  if (client.status === 'ready') return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis was not ready within ${timeoutMs}ms (status: ${client.status})`));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      client.off('ready', onReady);
      client.off('error', onError);
    }

    function onReady(): void {
      cleanup();
      resolve();
    }

    // A connection error during startup is fatal; ioredis will keep retrying in
    // the background, but the caller asked whether it is usable *now*.
    function onError(error: Error): void {
      cleanup();
      reject(error);
    }

    client.once('ready', onReady);
    client.once('error', onError);
  });
}

/**
 * Socket.IO's Redis adapter needs a dedicated pub and sub pair; a subscriber
 * connection cannot issue normal commands.
 */
export function createPubSubPair(options: RedisFactoryOptions): {
  pub: RedisClient;
  sub: RedisClient;
} {
  const pub = createRedisClient({ ...options, role: 'pub' });
  // Subscriber connections must not carry a keyPrefix; channel names are global.
  const sub = createRedisClient({ ...options, role: 'sub', keyPrefix: '' });
  return { pub, sub };
}

export async function closeRedis(client: RedisClient): Promise<void> {
  await client.quit();
}
