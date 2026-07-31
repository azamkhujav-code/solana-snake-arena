-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('PLAYER', 'MODERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'SHADOWBANNED', 'BANNED', 'CLOSED');

-- CreateEnum
CREATE TYPE "chain" AS ENUM ('SOLANA');

-- CreateEnum
CREATE TYPE "room_visibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "room_status" AS ENUM ('ACTIVE', 'DRAINING', 'CLOSED');

-- CreateEnum
CREATE TYPE "game_mode" AS ENUM ('CASUAL', 'RANKED', 'WAGER');

-- CreateEnum
CREATE TYPE "region" AS ENUM ('US_EAST', 'US_WEST', 'EU_WEST', 'AP_SOUTHEAST');

-- CreateEnum
CREATE TYPE "game_status" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "settlement_status" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "death_cause" AS ENUM ('COLLISION', 'WALL', 'DISCONNECT', 'KICKED');

-- CreateEnum
CREATE TYPE "participant_state" AS ENUM ('PLAYING', 'ELIMINATED', 'SURVIVED', 'FORFEITED');

-- CreateEnum
CREATE TYPE "pool_account_kind" AS ENUM ('USER_CUSTODY', 'GAME_ESCROW', 'TREASURY', 'RAKE', 'REWARDS');

-- CreateEnum
CREATE TYPE "transaction_type" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'ENTRY_FEE', 'PAYOUT', 'RAKE', 'REWARD', 'REFUND', 'TRANSFER', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "transaction_direction" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "transaction_status" AS ENUM ('PENDING', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "deposit_status" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "withdrawal_status" AS ENUM ('REQUESTED', 'PENDING_REVIEW', 'APPROVED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "reward_kind" AS ENUM ('DAILY_BONUS', 'REFERRAL', 'TOURNAMENT', 'ACHIEVEMENT', 'PROMO', 'COMPENSATION');

-- CreateEnum
CREATE TYPE "reward_status" AS ENUM ('PENDING', 'GRANTED', 'CLAIMED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "leaderboard_window" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'ALL_TIME', 'SEASON');

-- CreateEnum
CREATE TYPE "rarity" AS ENUM ('COMMON', 'RARE', 'EPIC', 'LEGENDARY');

-- CreateEnum
CREATE TYPE "severity" AS ENUM ('INFO', 'WARN', 'CRITICAL');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(16),
    "display_name" VARCHAR(32),
    "avatar_url" VARCHAR(512),
    "skin_id" VARCHAR(64),
    "role" "user_role" NOT NULL DEFAULT 'PLAYER',
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "games_played" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "kills" INTEGER NOT NULL DEFAULT 0,
    "deaths" INTEGER NOT NULL DEFAULT 0,
    "best_score" INTEGER NOT NULL DEFAULT 0,
    "total_playtime_seconds" INTEGER NOT NULL DEFAULT 0,
    "lifetime_wagered" BIGINT NOT NULL DEFAULT 0,
    "lifetime_won" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "address" VARCHAR(44) NOT NULL,
    "chain" "chain" NOT NULL DEFAULT 'SOLANA',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "label" VARCHAR(32),
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "name" VARCHAR(48),
    "mode" "game_mode" NOT NULL DEFAULT 'CASUAL',
    "region" "region" NOT NULL DEFAULT 'US_EAST',
    "visibility" "room_visibility" NOT NULL DEFAULT 'PUBLIC',
    "status" "room_status" NOT NULL DEFAULT 'ACTIVE',
    "max_players" INTEGER NOT NULL DEFAULT 120,
    "entry_fee_lamports" BIGINT NOT NULL DEFAULT 0,
    "rake_bps" INTEGER NOT NULL DEFAULT 0,
    "node_id" VARCHAR(64),
    "owner_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "status" "game_status" NOT NULL DEFAULT 'PENDING',
    "seed" BIGINT NOT NULL,
    "node_id" VARCHAR(64) NOT NULL,
    "player_count" INTEGER NOT NULL DEFAULT 0,
    "pot_lamports" BIGINT NOT NULL DEFAULT 0,
    "rake_lamports" BIGINT NOT NULL DEFAULT 0,
    "payout_lamports" BIGINT NOT NULL DEFAULT 0,
    "onchain_match_pda" VARCHAR(44),
    "settlement_signature" VARCHAR(96),
    "settlement_status" "settlement_status" NOT NULL DEFAULT 'NOT_REQUIRED',
    "settlement_attempts" INTEGER NOT NULL DEFAULT 0,
    "settlement_error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_players" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_id" UUID,
    "nickname" VARCHAR(16) NOT NULL,
    "placement" INTEGER DEFAULT 0,
    "score" INTEGER NOT NULL DEFAULT 0,
    "kills" INTEGER NOT NULL DEFAULT 0,
    "max_mass" INTEGER NOT NULL DEFAULT 0,
    "survived_ms" INTEGER NOT NULL DEFAULT 0,
    "entry_paid_lamports" BIGINT NOT NULL DEFAULT 0,
    "payout_lamports" BIGINT NOT NULL DEFAULT 0,
    "killed_by_id" UUID,
    "death_cause" "death_cause",
    "result" "participant_state" NOT NULL DEFAULT 'PLAYING',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "game_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_accounts" (
    "id" UUID NOT NULL,
    "kind" "pool_account_kind" NOT NULL,
    "name" VARCHAR(96) NOT NULL,
    "owner_user_id" UUID,
    "game_id" UUID,
    "balance_lamports" BIGINT NOT NULL DEFAULT 0,
    "reserved_lamports" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "onchain_address" VARCHAR(44),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "entry_group_id" UUID NOT NULL,
    "type" "transaction_type" NOT NULL,
    "direction" "transaction_direction" NOT NULL,
    "status" "transaction_status" NOT NULL DEFAULT 'POSTED',
    "amount_lamports" BIGINT NOT NULL,
    "balance_after_lamports" BIGINT NOT NULL,
    "user_id" UUID,
    "pool_account_id" UUID NOT NULL,
    "game_id" UUID,
    "deposit_id" UUID,
    "withdrawal_id" UUID,
    "reward_id" UUID,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "description" VARCHAR(256),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "status" "deposit_status" NOT NULL DEFAULT 'PENDING',
    "amount_lamports" BIGINT NOT NULL,
    "tx_signature" VARCHAR(96),
    "slot" BIGINT,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "pool_account_id" UUID,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "failure_reason" VARCHAR(256),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "status" "withdrawal_status" NOT NULL DEFAULT 'REQUESTED',
    "amount_lamports" BIGINT NOT NULL,
    "fee_lamports" BIGINT NOT NULL DEFAULT 0,
    "tx_signature" VARCHAR(96),
    "idempotency_key" VARCHAR(128) NOT NULL,
    "failure_reason" VARCHAR(256),
    "reviewed_by_id" UUID,
    "review_note" VARCHAR(256),
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rewards" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "reward_kind" NOT NULL,
    "status" "reward_status" NOT NULL DEFAULT 'PENDING',
    "amount_lamports" BIGINT NOT NULL,
    "game_id" UUID,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard" (
    "id" UUID NOT NULL,
    "window_type" "leaderboard_window" NOT NULL,
    "period_key" VARCHAR(16) NOT NULL,
    "user_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" BIGINT NOT NULL,
    "games_played" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "kills" INTEGER NOT NULL DEFAULT 0,
    "finalized" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_history" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "mode" "game_mode" NOT NULL,
    "region" "region" NOT NULL,
    "placement" INTEGER,
    "score" INTEGER NOT NULL DEFAULT 0,
    "kills" INTEGER NOT NULL DEFAULT 0,
    "survived_ms" INTEGER NOT NULL DEFAULT 0,
    "entry_lamports" BIGINT NOT NULL DEFAULT 0,
    "payout_lamports" BIGINT NOT NULL DEFAULT 0,
    "net_lamports" BIGINT NOT NULL DEFAULT 0,
    "played_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "match_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "user_agent" VARCHAR(256),
    "ip_hash" VARCHAR(64),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skins" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "rarity" "rarity" NOT NULL DEFAULT 'COMMON',
    "price_lamports" BIGINT NOT NULL DEFAULT 0,
    "collection_mint" VARCHAR(44),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID,
    "actor_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "severity" "severity" NOT NULL DEFAULT 'INFO',
    "metadata" JSONB,
    "ip_hash" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_last_seen_at_idx" ON "users"("last_seen_at" DESC);

-- CreateIndex
CREATE INDEX "users_best_score_idx" ON "users"("best_score" DESC);

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_address_key" ON "wallets"("address");

-- CreateIndex
CREATE INDEX "wallets_user_id_is_primary_idx" ON "wallets"("user_id", "is_primary");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_address_key" ON "wallets"("user_id", "address");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_code_key" ON "rooms"("code");

-- CreateIndex
CREATE INDEX "rooms_status_visibility_region_mode_idx" ON "rooms"("status", "visibility", "region", "mode");

-- CreateIndex
CREATE INDEX "rooms_node_id_idx" ON "rooms"("node_id");

-- CreateIndex
CREATE INDEX "rooms_owner_id_idx" ON "rooms"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "games_settlement_signature_key" ON "games"("settlement_signature");

-- CreateIndex
CREATE INDEX "games_started_at_idx" ON "games"("started_at" DESC);

-- CreateIndex
CREATE INDEX "games_room_id_started_at_idx" ON "games"("room_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "games_status_idx" ON "games"("status");

-- CreateIndex
CREATE INDEX "games_settlement_status_ended_at_idx" ON "games"("settlement_status", "ended_at");

-- CreateIndex
CREATE INDEX "game_players_user_id_joined_at_idx" ON "game_players"("user_id", "joined_at" DESC);

-- CreateIndex
CREATE INDEX "game_players_game_id_placement_idx" ON "game_players"("game_id", "placement");

-- CreateIndex
CREATE INDEX "game_players_killed_by_id_idx" ON "game_players"("killed_by_id");

-- CreateIndex
CREATE INDEX "game_players_wallet_id_idx" ON "game_players"("wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_players_game_id_user_id_key" ON "game_players"("game_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "pool_accounts_name_key" ON "pool_accounts"("name");

-- CreateIndex
CREATE UNIQUE INDEX "pool_accounts_owner_user_id_key" ON "pool_accounts"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "pool_accounts_game_id_key" ON "pool_accounts"("game_id");

-- CreateIndex
CREATE INDEX "pool_accounts_kind_idx" ON "pool_accounts"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotency_key_key" ON "transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "transactions_entry_group_id_idx" ON "transactions"("entry_group_id");

-- CreateIndex
CREATE INDEX "transactions_user_id_created_at_idx" ON "transactions"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transactions_pool_account_id_created_at_idx" ON "transactions"("pool_account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transactions_type_created_at_idx" ON "transactions"("type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transactions_game_id_idx" ON "transactions"("game_id");

-- CreateIndex
CREATE INDEX "transactions_created_at_idx" ON "transactions"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "deposits_tx_signature_key" ON "deposits"("tx_signature");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_idempotency_key_key" ON "deposits"("idempotency_key");

-- CreateIndex
CREATE INDEX "deposits_user_id_created_at_idx" ON "deposits"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "deposits_status_created_at_idx" ON "deposits"("status", "created_at");

-- CreateIndex
CREATE INDEX "deposits_wallet_id_idx" ON "deposits"("wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_tx_signature_key" ON "withdrawals"("tx_signature");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_idempotency_key_key" ON "withdrawals"("idempotency_key");

-- CreateIndex
CREATE INDEX "withdrawals_user_id_requested_at_idx" ON "withdrawals"("user_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "withdrawals_status_requested_at_idx" ON "withdrawals"("status", "requested_at");

-- CreateIndex
CREATE INDEX "withdrawals_wallet_id_idx" ON "withdrawals"("wallet_id");

-- CreateIndex
CREATE INDEX "withdrawals_reviewed_by_id_idx" ON "withdrawals"("reviewed_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "rewards_idempotency_key_key" ON "rewards"("idempotency_key");

-- CreateIndex
CREATE INDEX "rewards_user_id_created_at_idx" ON "rewards"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "rewards_status_expires_at_idx" ON "rewards"("status", "expires_at");

-- CreateIndex
CREATE INDEX "rewards_kind_idx" ON "rewards"("kind");

-- CreateIndex
CREATE INDEX "rewards_game_id_idx" ON "rewards"("game_id");

-- CreateIndex
CREATE INDEX "leaderboard_window_type_period_key_rank_idx" ON "leaderboard"("window_type", "period_key", "rank");

-- CreateIndex
CREATE INDEX "leaderboard_user_id_window_type_idx" ON "leaderboard"("user_id", "window_type");

-- CreateIndex
CREATE UNIQUE INDEX "leaderboard_window_type_period_key_user_id_key" ON "leaderboard"("window_type", "period_key", "user_id");

-- CreateIndex
CREATE INDEX "match_history_user_id_played_at_idx" ON "match_history"("user_id", "played_at" DESC);

-- CreateIndex
CREATE INDEX "match_history_game_id_idx" ON "match_history"("game_id");

-- CreateIndex
CREATE INDEX "match_history_mode_played_at_idx" ON "match_history"("mode", "played_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "match_history_user_id_game_id_key" ON "match_history"("user_id", "game_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "skins_active_idx" ON "skins"("active");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_severity_created_at_idx" ON "audit_logs"("severity", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_killed_by_id_fkey" FOREIGN KEY ("killed_by_id") REFERENCES "game_players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_accounts" ADD CONSTRAINT "pool_accounts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_accounts" ADD CONSTRAINT "pool_accounts_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_pool_account_id_fkey" FOREIGN KEY ("pool_account_id") REFERENCES "pool_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "rewards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_pool_account_id_fkey" FOREIGN KEY ("pool_account_id") REFERENCES "pool_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard" ADD CONSTRAINT "leaderboard_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_history" ADD CONSTRAINT "match_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_history" ADD CONSTRAINT "match_history_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_history" ADD CONSTRAINT "match_history_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

