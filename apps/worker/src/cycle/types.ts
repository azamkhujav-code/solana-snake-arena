import type { LobbyService } from '@arena/lobby';
import type { PrismaClient } from '@arena/db';
import type { ArenaService } from '@arena/solana';
import type { RedisClient } from '@arena/redis';
import type { Logger } from '@arena/logger';

import type { CycleStage } from './plan.js';

/** Payload carried by every stage job. */
export interface CycleJobData {
  cycleId: string;
  tierId: string;
  stage: CycleStage;
  /** Epoch ms the cycle's window began. All offsets are relative to this. */
  cycleStartedAt: number;
  /** Set by `create-game` and threaded through the rest of the pipeline. */
  gameId?: string;
  roomId?: string;
  /** Set by `start-match`. */
  nodeId?: string;
  realtimeUrl?: string;
}

export interface StageContext {
  prisma: PrismaClient;
  solana: ArenaService;
  redis: RedisClient;
  lobbies: LobbyService;
  log: Logger;
  now: () => number;
  /** Wallet that receives the platform fee at settlement. */
  feeDestination: string;
}

/**
 * Result of a stage.
 *
 * `patch` is merged into the job data passed to the next stage, which is how
 * ids created early (the game row, the room) reach the stages that need them
 * without a database round-trip at every step.
 */
export interface StageResult {
  patch?: Partial<CycleJobData>;
  /** Stops the pipeline without failing the job — e.g. an empty lobby. */
  abort?: { reason: string };
  /**
   * Stops the pipeline **and hands the pot back**.
   *
   * The difference from `abort` is whether money has moved. Before
   * `close-lobby` nothing has, so aborting is complete in itself. After it, the
   * entry fees are in the game's escrow and stopping without refunding strands
   * them there — so a stage that fails terminally past that point must cancel
   * rather than abort.
   */
  cancel?: { reason: string };
}

export type StageHandler = (data: CycleJobData, context: StageContext) => Promise<StageResult>;
