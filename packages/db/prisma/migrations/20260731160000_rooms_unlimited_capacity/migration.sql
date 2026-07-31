-- Rooms have no seat limit.
--
-- `max_players` becomes nullable, where NULL means "no limit". A sentinel such
-- as 65535 would have avoided the migration, but every read site would then
-- have to know the sentinel, and one that did not would render "12/65535".
--
-- Existing rows are set to NULL rather than left at their old caps: the caps
-- were the thing being removed, and leaving them would keep old rooms
-- rejecting players while new ones did not.
ALTER TABLE "rooms" ALTER COLUMN "max_players" DROP DEFAULT;
ALTER TABLE "rooms" ALTER COLUMN "max_players" DROP NOT NULL;
UPDATE "rooms" SET "max_players" = NULL;
