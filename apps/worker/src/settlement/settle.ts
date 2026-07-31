import type { PrismaClient } from '@arena/db';
import {
  GameStatus,
  LeaderboardWindow,
  RewardKind,
  RewardStatus,
  SettlementStatus,
  TransactionDirection,
  TransactionType,
} from '@arena/db';
import { redisChannels, type RedisClient } from '@arena/redis';
import { roomIdFromUuid, type ArenaService } from '@arena/solana';
import type { Logger } from '@arena/logger';
import { PublicKey } from '@solana/web3.js';
import { randomUUID } from 'node:crypto';

import { computePayouts, splitPot, totalPayout, withinTransactionLimit } from './payout.js';
import { describeFailure, detectWinner, verifyResult, type MatchResultReport } from './verify.js';

/** Where the realtime node publishes its final standings. */
export const resultKey = (gameId: string): string => `match:result:${gameId}`;

export interface SettleDeps {
  prisma: PrismaClient;
  redis: RedisClient;
  solana: ArenaService;
  log: Logger;
  now: () => number;
  /**
   * Wallet that receives the platform fee.
   *
   * Passed in rather than read from the chain because the program constrains it
   * anyway — `settle_to_winner` rejects any address that is not
   * `Config.fee_destination`, so a wrong value here fails loudly at simulation
   * rather than quietly paying the wrong person.
   */
  feeDestination: string;
}

export type SettleOutcome =
  | {
      status: 'settled';
      winnerId: string;
      prizePool: bigint;
      rake: bigint;
      signature: string | null;
    }
  | { status: 'no-result'; reason: string }
  | { status: 'rejected'; reasons: string[] }
  | { status: 'already-settled' };

/**
 * The post-game pipeline.
 *
 * Detect winner → verify → unlock the escrow → pay out → record → notify.
 *
 * Ordered so that nothing irreversible happens before verification, and so a
 * crash between any two steps leaves a state a retry can recover from. The
 * whole function is safe to re-run: every write is keyed on something stable.
 */
export async function settleGame(deps: SettleDeps, gameId: string): Promise<SettleOutcome> {
  const game = await deps.prisma.game.findUnique({
    where: { id: gameId },
    select: {
      id: true,
      status: true,
      nodeId: true,
      potLamports: true,
      settlementStatus: true,
      room: { select: { rakeBps: true, mode: true, region: true } },
      gamePlayers: { select: { userId: true, walletId: true, entryPaidLamports: true } },
    },
  });

  if (!game) return { status: 'no-result', reason: 'game not found' };
  if (game.settlementStatus === SettlementStatus.CONFIRMED) return { status: 'already-settled' };

  // A cancelled game has already had its entry fees returned, so its escrow is
  // empty. Settling one anyway would pay a prize out of an account with nothing
  // in it — the escrow would go negative and the winner would be credited
  // lamports no player ever staked.
  if (game.status === GameStatus.CANCELLED) {
    return { status: 'rejected', reasons: ['game was cancelled and its entry fees refunded'] };
  }

  // ---- 1. Detect winner --------------------------------------------------
  const raw = await deps.redis.get(resultKey(gameId));
  if (!raw) {
    return { status: 'no-result', reason: 'realtime node has not reported a result yet' };
  }

  let report: MatchResultReport;
  try {
    report = JSON.parse(raw) as MatchResultReport;
  } catch {
    return { status: 'rejected', reasons: ['result payload was not valid JSON'] };
  }

  // ---- 2. Verify ---------------------------------------------------------
  const verified = verifyResult(report, {
    gameId,
    entrants: game.gamePlayers.map((player) => player.userId),
    expectedNodeId: game.nodeId,
  });

  if (!verified.ok) {
    const reasons = verified.failures.map(describeFailure);
    // A failed verification is not retryable — the same report will fail the
    // same way — so the game is parked for a human rather than looping.
    await deps.prisma.game.update({
      where: { id: gameId },
      data: {
        settlementStatus: SettlementStatus.FAILED,
        settlementError: reasons.join('; '),
      },
    });
    deps.log.error({ gameId, reasons }, 'match result failed verification');
    return { status: 'rejected', reasons };
  }

  const winner = detectWinner(verified);
  if (!winner) return { status: 'rejected', reasons: ['no winner in a verified result'] };

  // ---- 3. Persist standings ---------------------------------------------
  // Written before any money moves, so a crash mid-payout still leaves the
  // authoritative result on record.
  for (const standing of verified.standings) {
    await deps.prisma.gamePlayer.updateMany({
      where: { gameId, userId: standing.playerId },
      data: {
        placement: standing.placement,
        score: standing.score,
        kills: standing.kills,
        survivedMs: standing.survivedMs,
        result: standing.placement === 1 ? 'SURVIVED' : 'ELIMINATED',
      },
    });
  }

  const { prizePool, rake } = splitPot(game.potLamports, game.room.rakeBps);
  const payouts = computePayouts(verified.standings, prizePool);

  // Free rooms have nothing to settle. Everything below this point is money.
  if (game.potLamports === 0n || payouts.length === 0) {
    await finishGame(deps, gameId, SettlementStatus.NOT_REQUIRED, null);
    await updateLeaderboard(deps, gameId, verified.standings, game.room.mode);
    await notifyPlayers(deps, gameId, winner.playerId, []);
    return {
      status: 'settled',
      winnerId: winner.playerId,
      prizePool: 0n,
      rake: 0n,
      signature: null,
    };
  }

  if (!withinTransactionLimit(payouts)) {
    return { status: 'rejected', reasons: ['payout list exceeds the per-transaction winner cap'] };
  }

  // The chain enforces this too and rejects a mismatch; asserting here turns a
  // confusing on-chain failure into a clear local one.
  if (totalPayout(payouts) !== prizePool) {
    return { status: 'rejected', reasons: ['payouts do not sum to the prize pool'] };
  }

  const onChainRoomId = roomIdFromUuid(gameId);

  /**
   * Whether the on-chain leg runs at all.
   *
   * The ledger payout below is what a player's balance is actually computed
   * from, and it must happen either way. Skipping the chain calls when they
   * cannot succeed is what stops a winner going unpaid because of a
   * misconfigured key — the failure mode that matters most here, since the
   * money is already sitting in escrow with nowhere else to go.
   */
  const onChain = deps.solana.canSignOnChain;

  // ---- 4. Unlock the PDA -------------------------------------------------
  // Commits the prize/rake split on chain before anything moves, so the target
  // cannot shift between a failed attempt and a retry.
  await deps.prisma.game.update({
    where: { id: gameId },
    data: { settlementStatus: SettlementStatus.PENDING, settlementAttempts: { increment: 1 } },
  });

  let signature: string | null = null;

  if (onChain) {
    try {
      await deps.solana.unlockPrize(onChainRoomId);
    } catch (error) {
      // Already unlocked is the desired end state, not a failure — a retry after
      // a timeout lands here routinely.
      if (!isAlreadyDone(error)) throw error;
      deps.log.info({ gameId }, 'prize already unlocked');
    }

    // ---- 5. Pay the winner ------------------------------------------------
    // Straight to their own wallet, out of this match's vault. The custodial
    // path credited a balance they then had to withdraw; with no custody
    // balance there is nothing to credit, and a player who has just won should
    // not need a second transaction to see the money.
    const walletByUser = await resolveWallets(deps, [winner.playerId]);
    const winnerWallet = walletByUser.get(winner.playerId);

    if (!winnerWallet) {
      // Refusing is the safe side: paying an address we cannot attribute to the
      // winner is worse than leaving the pot in escrow for a human to release.
      await deps.prisma.game.update({
        where: { id: gameId },
        data: {
          settlementStatus: SettlementStatus.FAILED,
          settlementError: 'winner has no wallet on record',
        },
      });
      return { status: 'rejected', reasons: ['a winner has no verified wallet on record'] };
    }

    try {
      const result = await deps.solana.settleToWinner({
        roomId: onChainRoomId,
        winner: new PublicKey(winnerWallet),
        feeDestination: new PublicKey(deps.feeDestination),
      });
      signature = result.signature;
    } catch (error) {
      if (!isAlreadyDone(error)) {
        await deps.prisma.game.update({
          where: { id: gameId },
          data: {
            settlementStatus: SettlementStatus.FAILED,
            settlementError: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
      deps.log.info({ gameId }, 'winnings already distributed');
    }
  } else {
    deps.log.warn(
      { gameId },
      'settling in the ledger only: no settlement authority, so no lamports move on chain',
    );
  }

  // ---- 6. Record rewards + ledger ---------------------------------------
  await recordRewards(deps, gameId, payouts, rake);

  // ---- 7. Leaderboard ----------------------------------------------------
  await updateLeaderboard(deps, gameId, verified.standings, game.room.mode);

  // ---- 8. Notify ---------------------------------------------------------
  // CONFIRMED either way: the players have been paid, which is what settlement
  // means here. A null `settlementSignature` on a confirmed game is the signal
  // that no on-chain transaction backs it — the distinction the admin views and
  // the reconciliation job read.
  await finishGame(deps, gameId, SettlementStatus.CONFIRMED, signature);
  await notifyPlayers(deps, gameId, winner.playerId, payouts);

  deps.log.info(
    { gameId, winnerId: winner.playerId, prizePool: prizePool.toString(), signature },
    'match settled',
  );

  return { status: 'settled', winnerId: winner.playerId, prizePool, rake, signature };
}

/**
 * Anchor rejects a repeated settlement with a state error rather than
 * succeeding silently, so a retry after a dropped response surfaces as one of
 * these. That is the desired end state, not a failure.
 */
function isAlreadyDone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('PrizeNotUnlocked') ||
    message.includes('RoomAlreadySettled') ||
    message.includes('already in use')
  );
}

async function resolveWallets(
  deps: SettleDeps,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const wallets = await deps.prisma.wallet.findMany({
    where: { userId: { in: [...userIds] }, verifiedAt: { not: null } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: { userId: true, address: true },
  });

  const map = new Map<string, string>();
  // `orderBy` puts the primary first, so the first write per user wins.
  for (const wallet of wallets) {
    if (!map.has(wallet.userId)) map.set(wallet.userId, wallet.address);
  }
  return map;
}

/**
 * Records each payout as a Reward and mirrors it into the ledger.
 *
 * Idempotent on `idempotencyKey`: a retry hits the unique constraint rather
 * than paying twice in the books.
 */
async function recordRewards(
  deps: SettleDeps,
  gameId: string,
  payouts: readonly { playerId: string; lamports: bigint; placement: number }[],
  rake: bigint,
): Promise<void> {
  for (const payout of payouts) {
    try {
      await deps.prisma.reward.create({
        data: {
          userId: payout.playerId,
          kind: RewardKind.TOURNAMENT,
          status: RewardStatus.GRANTED,
          amountLamports: payout.lamports,
          gameId,
          idempotencyKey: `payout:${gameId}:${payout.playerId}`,
          grantedAt: new Date(deps.now()),
          metadata: { placement: payout.placement },
        },
      });
    } catch (error) {
      // Unique violation: already recorded on a previous attempt.
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }

  await deps.prisma.game.update({
    where: { id: gameId },
    data: { payoutLamports: totalPayout(payouts), rakeLamports: rake },
  });

  await postSettlementLedger(deps, gameId, payouts, rake);
}

/**
 * Posts the double-entry legs for a settled match.
 *
 * The escrow account holds the pot; this empties it into the winner's custody
 * and the fee account. Every leg is written in one transaction, so the books
 * are never observed half-settled.
 *
 * Idempotent on `settle:{gameId}:*`. A retried settlement collides on the
 * unique index rather than paying the pot into the ledger twice — which would
 * be worse than the on-chain double-pay it mirrors, because nothing on chain
 * would contradict it.
 */
async function postSettlementLedger(
  deps: SettleDeps,
  gameId: string,
  payouts: readonly { playerId: string; lamports: bigint }[],
  rake: bigint,
): Promise<void> {
  const escrow = await deps.prisma.poolAccount.findUnique({
    where: { name: `escrow:${gameId}` },
  });

  // Free matches never created one. Nothing moved, so nothing to record.
  if (!escrow) return;

  const alreadyPosted = await deps.prisma.transaction.findFirst({
    where: { gameId, type: TransactionType.PAYOUT },
    select: { id: true },
  });
  if (alreadyPosted) {
    deps.log.info({ gameId }, 'settlement ledger already posted');
    return;
  }

  await deps.prisma.$transaction(async (tx) => {
    let escrowBalance = escrow.balanceLamports;

    for (const payout of payouts) {
      const custody = await tx.poolAccount.findFirst({
        where: { ownerUserId: payout.playerId },
      });
      if (!custody) continue;

      escrowBalance -= payout.lamports;
      const custodyAfter = custody.balanceLamports + payout.lamports;
      const entryGroupId = randomUUID();

      await tx.poolAccount.update({
        where: { id: custody.id, version: custody.version },
        data: { balanceLamports: custodyAfter, version: { increment: 1 } },
      });

      await tx.transaction.createMany({
        data: [
          {
            entryGroupId,
            type: TransactionType.PAYOUT,
            direction: TransactionDirection.DEBIT,
            amountLamports: payout.lamports,
            balanceAfterLamports: escrowBalance,
            poolAccountId: escrow.id,
            gameId,
            idempotencyKey: `settle:${gameId}:${payout.playerId}:escrow`,
            description: 'Prize pool payout',
          },
          {
            entryGroupId,
            type: TransactionType.PAYOUT,
            direction: TransactionDirection.CREDIT,
            amountLamports: payout.lamports,
            balanceAfterLamports: custodyAfter,
            userId: payout.playerId,
            poolAccountId: custody.id,
            gameId,
            idempotencyKey: `settle:${gameId}:${payout.playerId}`,
            description: 'Prize won',
          },
        ],
      });
    }

    // The platform fee. On chain it goes straight to the owner's wallet, so
    // the off-chain counter-account is RAKE — it records that the money left
    // the pot, not that the platform is still holding it.
    if (rake > 0n) {
      const rakeAccount = await tx.poolAccount.findUnique({ where: { name: 'rake' } });

      if (rakeAccount) {
        escrowBalance -= rake;
        const rakeAfter = rakeAccount.balanceLamports + rake;
        const entryGroupId = randomUUID();

        await tx.poolAccount.update({
          where: { id: rakeAccount.id, version: rakeAccount.version },
          data: { balanceLamports: rakeAfter, version: { increment: 1 } },
        });

        await tx.transaction.createMany({
          data: [
            {
              entryGroupId,
              type: TransactionType.RAKE,
              direction: TransactionDirection.DEBIT,
              amountLamports: rake,
              balanceAfterLamports: escrowBalance,
              poolAccountId: escrow.id,
              gameId,
              idempotencyKey: `settle:${gameId}:rake:escrow`,
              description: 'Platform fee',
            },
            {
              entryGroupId,
              type: TransactionType.RAKE,
              direction: TransactionDirection.CREDIT,
              amountLamports: rake,
              balanceAfterLamports: rakeAfter,
              poolAccountId: rakeAccount.id,
              gameId,
              idempotencyKey: `settle:${gameId}:rake`,
              description: 'Platform fee',
            },
          ],
        });
      }
    }

    await tx.poolAccount.update({
      where: { id: escrow.id, version: escrow.version },
      data: { balanceLamports: escrowBalance, version: { increment: 1 } },
    });
  });
}

/**
 * Upserts the rolling leaderboard windows.
 *
 * Keyed on (window, period, user), so replaying this stage overwrites rather
 * than double-counting.
 */
async function updateLeaderboard(
  deps: SettleDeps,
  gameId: string,
  standings: readonly { playerId: string; score: number; kills: number; placement: number }[],
  _mode: string,
): Promise<void> {
  const day = new Date(deps.now()).toISOString().slice(0, 10);

  for (const standing of standings) {
    for (const [window, periodKey] of [
      [LeaderboardWindow.DAILY, day],
      [LeaderboardWindow.ALL_TIME, 'all'],
    ] as const) {
      const existing = await deps.prisma.leaderboard.findUnique({
        where: {
          window_periodKey_userId: { window, periodKey, userId: standing.playerId },
        },
        select: { id: true, score: true, gamesPlayed: true, wins: true, kills: true },
      });

      const isWin = standing.placement === 1;

      if (existing) {
        await deps.prisma.leaderboard.update({
          where: { id: existing.id },
          data: {
            // Best score for the window, not the latest — a bad game should not
            // erase a good one.
            score: BigInt(Math.max(Number(existing.score), standing.score)),
            gamesPlayed: existing.gamesPlayed + 1,
            wins: existing.wins + (isWin ? 1 : 0),
            kills: existing.kills + standing.kills,
            computedAt: new Date(deps.now()),
          },
        });
      } else {
        await deps.prisma.leaderboard.create({
          data: {
            window,
            periodKey,
            userId: standing.playerId,
            // Ranks are assigned by a separate pass over the window; a rank
            // computed per-game would be wrong the moment anyone else played.
            rank: 0,
            score: BigInt(standing.score),
            gamesPlayed: 1,
            wins: isWin ? 1 : 0,
            kills: standing.kills,
            computedAt: new Date(deps.now()),
          },
        });
      }
    }
  }

  void gameId;
}

async function finishGame(
  deps: SettleDeps,
  gameId: string,
  status: SettlementStatus,
  signature: string | null,
): Promise<void> {
  await deps.prisma.game.update({
    where: { id: gameId },
    data: {
      status: GameStatus.COMPLETED,
      endedAt: new Date(deps.now()),
      settlementStatus: status,
      ...(signature ? { settlementSignature: signature } : {}),
      settlementError: null,
    },
  });
}

/**
 * Announces the result.
 *
 * Published to Redis for any realtime node still holding the room to relay,
 * and persisted as Reward rows above — by settlement time the room may already
 * be gone, so the durable record is what the player actually sees next login.
 */
async function notifyPlayers(
  deps: SettleDeps,
  gameId: string,
  winnerId: string,
  payouts: readonly { playerId: string; lamports: bigint }[],
): Promise<void> {
  const payload = JSON.stringify({
    type: 'match-settled',
    gameId,
    winnerId,
    payouts: payouts.map((payout) => ({
      playerId: payout.playerId,
      lamports: payout.lamports.toString(),
    })),
    settledAt: deps.now(),
    eventId: randomUUID(),
  });

  // Best effort: a failed notification must never fail a completed settlement.
  await deps.redis.publish(redisChannels.matchSettlement, payload).catch((error: unknown) => {
    deps.log.warn({ err: error, gameId }, 'could not publish settlement notification');
  });
}
