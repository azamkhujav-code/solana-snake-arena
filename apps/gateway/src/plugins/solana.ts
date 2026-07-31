import { ArenaService } from '@arena/solana';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';

import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    solana: ArenaService;
    /**
     * Distributed lock. Resolves to a release function, or null when the lock
     * is already held.
     */
    acquireLock: (key: string, ttlMs: number) => Promise<(() => Promise<void>) | null>;
  }
}

async function solanaPlugin(app: FastifyInstance): Promise<void> {
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
    logger: {
      info: (obj, msg) => app.log.info(obj as object, msg),
      warn: (obj, msg) => app.log.warn(obj as object, msg),
      error: (obj, msg) => app.log.error(obj as object, msg),
    },
  });

  app.decorate('solana', solana);

  /**
   * Redis SET NX PX lock.
   *
   * The release path compares the token before deleting, so a caller whose lock
   * already expired cannot delete a lock a different worker now holds — the
   * classic way a "distributed lock" ends up guarding nothing.
   */
  app.decorate('acquireLock', async (key: string, ttlMs: number) => {
    const token = randomUUID();
    const lockKey = `lock:${key}`;

    const acquired = await app.redis.set(lockKey, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') return null;

    return async () => {
      const current = await app.redis.get(lockKey);
      if (current === token) await app.redis.del(lockKey);
    };
  });
}

export default fp(solanaPlugin, { name: 'solana', dependencies: ['redis'] });
