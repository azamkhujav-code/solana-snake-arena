/**
 * Drives worker cycle stages directly, skipping only the clock.
 *
 * The real scheduler spreads these across nine minutes. Everything else — the
 * handlers, the database, Redis, the lobby service — is the production code
 * path, so a bug in stage ordering, or in the names stages use to find each
 * other's rows, still shows up here.
 *
 * Imported from `dist` by path because `@arena/worker` is an application and
 * publishes no exports map. Importing the built output rather than the source
 * is deliberate: it is the artifact the running worker executes.
 */
import { createLogger } from '@arena/logger';
import { createRedisClient, waitForRedis } from '@arena/redis';
import { ArenaService } from '@arena/solana';
import { LobbyService, RedisLobbyStore } from '@arena/lobby';

const { STAGE_HANDLERS } = await import('../dist/cycle/stages.js');
const { settleGame, resultKey } = await import('../dist/settlement/settle.js');

const log = createLogger({ service: 'match-flow', level: 'error', pretty: false });

async function buildContext(prisma) {
  const redis = createRedisClient({
    url: process.env.REDIS_URL,
    keyPrefix: process.env.REDIS_KEY_PREFIX,
    role: 'worker',
    onError: () => undefined,
  });
  await waitForRedis(redis);

  const solana = new ArenaService({
    programId: process.env.ARENA_PROGRAM_ID,
    endpoints: [{ http: process.env.SOLANA_RPC_URL, weight: 10, label: 'primary' }],
    commitment: 'confirmed',
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });

  const lobbies = new LobbyService({
    store: new RedisLobbyStore(redis),
    launch: async () => {
      throw new Error('the cycle drives launches');
    },
    onError: () => undefined,
  });

  return { prisma, solana, redis, lobbies, log, now: () => Date.now() };
}

/**
 * Runs the named stages in order, threading each stage's patch into the next
 * exactly as the queue does. Returns the accumulated job data, which can be
 * passed back as `carry` to continue the same cycle.
 */
export async function runStages(prisma, tierId, stages, carry = {}) {
  const ctx = await buildContext(prisma);
  // `carry` threads a previous call's patch back in, so a run split around the
  // joins continues with the same game rather than creating a second one.
  let data = {
    cycleId: carry.cycleId ?? `flow-${Date.now()}`,
    tierId,
    stage: stages[0],
    cycleStartedAt: carry.cycleStartedAt ?? Date.now(),
    ...carry,
  };

  try {
    for (const stage of stages) {
      const result = await STAGE_HANDLERS[stage]({ ...data, stage }, ctx);
      if (result.abort) throw new Error(`stage ${stage} aborted: ${result.abort.reason}`);
      data = { ...data, ...(result.patch ?? {}) };
    }
    return data;
  } finally {
    await ctx.redis.quit().catch(() => undefined);
  }
}

/**
 * Publishes a match result in which `loser` was eliminated and `winner` survived,
 * then settles it.
 *
 * The report is built by hand in the realtime node's own shape, because
 * validating that shape is half of what settlement does. Running an actual
 * match to produce it would put the assertion on the physics rather than on
 * the money.
 */
export async function settleWithWinner(prisma, gameId, { winner, loser }) {
  const ctx = await buildContext(prisma);

  try {
    const game = await prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { id: true, nodeId: true, roomId: true },
    });

    const report = {
      gameId,
      roomId: game.roomId,
      nodeId: game.nodeId,
      endedAtMs: Date.now(),
      // Placement 1 is the last snake standing. Note the loser scored *more* —
      // if the payout followed score rather than survival, this is the case
      // that would catch it.
      standings: [
        { playerId: winner.userId, placement: 1, score: 500, kills: 1, survivedMs: 120_000 },
        { playerId: loser.userId, placement: 2, score: 900, kills: 0, survivedMs: 40_000 },
      ],
    };

    await ctx.redis.set(resultKey(gameId), JSON.stringify(report));

    return await settleGame(ctx, gameId);
  } finally {
    await ctx.redis.quit().catch(() => undefined);
  }
}
