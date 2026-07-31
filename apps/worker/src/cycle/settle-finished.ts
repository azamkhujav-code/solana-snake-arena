import { GameStatus, SettlementStatus, type PrismaClient } from '@arena/db';
import type { Logger } from '@arena/logger';
import type { RedisClient } from '@arena/redis';
import type { ArenaService } from '@arena/solana';

import { resultKey, settleGame } from '../settlement/settle.js';

export interface SettleFinishedDeps {
  prisma: PrismaClient;
  redis: RedisClient;
  solana: ArenaService;
  log: Logger;
  now: () => number;
  feeDestination: string;
}

/**
 * Pays out a match as soon as it is decided, rather than when the clock says so.
 *
 * A match ends when one snake is left standing, which is usually long before
 * the cycle's `end-match` stage runs at nine minutes. Settlement waited for
 * that stage anyway, so a player who won in the second minute watched their
 * "being sent to your wallet" message for seven more — with nothing wrong, and
 * no way to tell that from something being broken.
 *
 * Driven off the games the database says are running rather than by scanning
 * Redis for result keys: the set is small, bounded by the number of tiers, and
 * asking "which matches are unfinished" is the question that actually needs
 * answering. A result key with no game behind it is not this loop's business.
 *
 * `end-match` still runs. `settleGame` returns `already-settled` on a game that
 * has been paid, so the two cannot pay twice — and leaving the stage in place
 * means a match this loop somehow misses is still caught by the schedule.
 */
export function createFinishedMatchSettler(deps: SettleFinishedDeps): () => Promise<void> {
  return async function settleFinished(): Promise<void> {
    const running = await deps.prisma.game.findMany({
      where: {
        status: GameStatus.RUNNING,
        settlementStatus: { in: [SettlementStatus.PENDING, SettlementStatus.NOT_REQUIRED] },
      },
      select: { id: true },
      // A guard against a backlog turning one tick into a long transaction,
      // not a policy: anything skipped is picked up on the next pass.
      take: 20,
    });

    for (const game of running) {
      // Cheap and decisive: no report means the match is still being played,
      // and there is nothing to settle until the node says otherwise.
      if ((await deps.redis.get(resultKey(game.id))) === null) continue;

      try {
        const outcome = await settleGame(deps, game.id);

        if (outcome.status === 'settled') {
          deps.log.info({ gameId: game.id }, 'settled a finished match early');
        } else if (outcome.status === 'rejected') {
          deps.log.error(
            { gameId: game.id, reasons: outcome.reasons },
            'settlement rejected; leaving it for the cycle to cancel and refund',
          );
        }
      } catch (error) {
        // Swallowed deliberately. `end-match` retries this game on the cycle
        // with a proper attempt budget, and a failure here must not stop the
        // other finished matches in this pass from being paid.
        deps.log.warn({ err: error, gameId: game.id }, 'early settlement attempt failed');
      }
    }
  };
}
