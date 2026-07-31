import { getPrismaClient } from '@arena/db';
import { LobbyService, RedisLobbyStore } from '@arena/lobby';
import { createLogger } from '@arena/logger';
import { createRedisClient } from '@arena/redis';
import { ArenaService } from '@arena/solana';
import closeWithGrace from 'close-with-grace';

import { config } from './config.js';
import {
  createCycleQueue,
  createQueueConnection,
  registerScheduler,
  removeScheduler,
} from './cycle/queue.js';
import { createRoomEnsurer } from './cycle/ensure-rooms.js';
import { createCycleWorker } from './cycle/worker.js';
import { loadSettlementAuthority } from './lib/settlement-authority.js';

async function main(): Promise<void> {
  const log = createLogger({
    service: config.SERVICE_NAME,
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
  });

  const prisma = getPrismaClient({ datasourceUrl: config.DATABASE_URL });
  await prisma.$connect();

  const redis = createRedisClient({
    url: config.REDIS_URL,
    clusterNodes: config.REDIS_CLUSTER_NODES,
    tls: config.REDIS_TLS,
    keyPrefix: config.REDIS_KEY_PREFIX,
    role: 'worker',
    onError: (error, role) => log.error({ err: error, role }, 'redis connection error'),
  });

  /**
   * The key that signs every on-chain write: creating a room's vault, locking
   * the pot, releasing the prize.
   *
   * Optional, and its absence is a supported mode rather than an error — a
   * worker can legitimately run the match cycle with on-chain settlement turned
   * off. But it was previously never read at all, so `ArenaService` was built
   * without an authority no matter what the environment said, and every paid
   * tier died in `create-pool` with "requires a settlement authority keypair".
   * The env var existed; nothing consumed it.
   */
  const settlementAuthority = loadSettlementAuthority(config.SETTLEMENT_AUTHORITY_SECRET);

  if (settlementAuthority) {
    log.info(
      { authority: settlementAuthority.publicKey.toBase58() },
      'settlement authority loaded; on-chain settlement enabled',
    );
  } else {
    log.warn(
      'no SETTLEMENT_AUTHORITY_SECRET; running with on-chain settlement disabled. ' +
        'Match wallets are derived and tracked in the ledger, but hold no on-chain lamports.',
    );
  }

  const solana = new ArenaService({
    programId: config.ARENA_PROGRAM_ID,
    endpoints: [
      {
        http: config.SOLANA_RPC_URL,
        ...(config.SOLANA_WS_URL ? { ws: config.SOLANA_WS_URL } : {}),
        weight: 10,
        label: 'primary',
      },
    ],
    commitment: config.SOLANA_COMMITMENT,
    ...(settlementAuthority ? { settlementAuthority } : {}),
    logger: {
      info: (obj, msg) => log.info(obj as object, msg),
      warn: (obj, msg) => log.warn(obj as object, msg),
      error: (obj, msg) => log.error(obj as object, msg),
    },
  });

  const lobbies = new LobbyService({
    store: new RedisLobbyStore(redis),
    // The cycle drives launches, so the service's own launch path is never
    // reached here. It throws rather than silently doing nothing, so a code
    // path that does reach it is loud instead of mysterious.
    launch: async () => {
      throw new Error('The worker cycle drives launches; LobbyService.launch is not used here');
    },
    onError: (error, context) => log.error({ err: error, ...context }, 'lobby error'),
  });

  const connection = createQueueConnection();
  const queue = createCycleQueue(connection);

  const worker = createCycleWorker({
    prisma,
    solana,
    redis,
    lobbies,
    queue,
    connection,
    log,
    now: Date.now,
    // Defaults to the settlement authority so a single-key local setup works
    // out of the box. The program constrains this against
    // `Config.fee_destination` regardless, so a wrong value fails at simulation
    // rather than quietly paying the wrong person.
    feeDestination: config.FEE_DESTINATION ?? settlementAuthority?.publicKey.toBase58() ?? '',
  });

  /**
   * Opens rooms for tiers people are actually queued in.
   *
   * Runs far more often than the cycle because it is answering a different
   * question: the cycle asks "is it time for the next match", this asks "is
   * there anybody waiting who cannot pay yet". A player who joins between
   * cycles needs the second one answered in seconds, not on the next window.
   *
   * Cheap when idle — a Redis read per paid tier and nothing else until someone
   * queues — and `unref`ed so it never holds the process open at shutdown.
   */
  const ensureRooms = createRoomEnsurer({ solana, lobbies, log });
  const roomTimer = setInterval(() => {
    void ensureRooms().catch((err: unknown) => log.error({ err }, 'room ensurer failed'));
  }, 15_000);
  roomTimer.unref();

  if (config.WORKER_SCHEDULER_ENABLED) {
    await registerScheduler(queue);
    log.info('cycle scheduler registered (every 10 minutes)');
  } else {
    // Consuming-only mode: several workers, one scheduler.
    log.info('scheduler disabled; consuming stages only');
  }

  log.info({ concurrency: config.WORKER_CONCURRENCY }, 'cycle worker started');

  closeWithGrace({ delay: 30_000 }, async ({ err, signal }) => {
    if (err) log.error({ err }, 'shutting down after uncaught error');
    else log.info({ signal }, 'graceful shutdown started');

    // Deregister the schedule first so no new window opens mid-shutdown, then
    // let in-flight stages finish — killing a stage midway can leave a game
    // half-created.
    if (config.WORKER_SCHEDULER_ENABLED) {
      await removeScheduler(queue).catch(() => undefined);
    }
    await worker.close();
    await queue.close();
    await connection.quit();
    await redis.quit();
    await prisma.$disconnect();
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
