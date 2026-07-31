-- CreateTable
CREATE TABLE "stake_reservations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tier_id" VARCHAR(32) NOT NULL,
    "lamports" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stake_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stake_reservations_tier_id_idx" ON "stake_reservations"("tier_id");

-- CreateIndex
CREATE UNIQUE INDEX "stake_reservations_user_id_tier_id_key" ON "stake_reservations"("user_id", "tier_id");

-- AddForeignKey
ALTER TABLE "stake_reservations" ADD CONSTRAINT "stake_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
