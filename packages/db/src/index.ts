export { disconnectPrisma, getPrismaClient, pingDatabase, PrismaClient } from './client.js';
export type { Prisma, PrismaFactoryOptions } from './client.js';

// Re-exported so consumers depend on @arena/db alone and never import
// @prisma/client directly — that keeps the generated client swappable.
export type {
  AuditLog,
  Deposit,
  Game,
  GamePlayer,
  Leaderboard,
  MatchHistory,
  PoolAccount,
  RefreshToken,
  Reward,
  Room,
  Skin,
  Transaction,
  User,
  Wallet,
  Withdrawal,
} from '@prisma/client';

export {
  Chain,
  DeathCause,
  DepositStatus,
  GameMode,
  GameStatus,
  LeaderboardWindow,
  ParticipantState,
  PoolAccountKind,
  Rarity,
  Region,
  RewardKind,
  RewardStatus,
  RoomStatus,
  RoomVisibility,
  SettlementStatus,
  Severity,
  TransactionDirection,
  TransactionStatus,
  TransactionType,
  UserRole,
  UserStatus,
  WithdrawalStatus,
} from '@prisma/client';
export * from './refund.js';
export * from './stake.js';
