/**
 * Development seed.
 *
 * Populates reference data (skins), the singleton pool accounts the ledger
 * depends on, and a couple of fixture users so the UI has something to render.
 *
 * The pool accounts are the important part: TREASURY, RAKE and REWARDS must
 * exist before any transaction can be posted, because every ledger entry needs
 * a pool to debit or credit.
 *
 * Never run against production — the guard below refuses.
 */
import { ROOM_TIERS } from '@arena/protocol';
import { GameMode, PoolAccountKind, PrismaClient, Rarity, RoomStatus } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Pools that must exist in every environment.
 *
 * EXTERNAL is not optional. It is the counter-account for money entering and
 * leaving the platform: a deposit debits EXTERNAL and credits custody. Without
 * the row, the first deposit fails because its other leg has nowhere to go —
 * and the "every entry group sums to zero" invariant cannot hold.
 */
const SYSTEM_POOLS = [
  { name: 'treasury', kind: PoolAccountKind.TREASURY },
  { name: 'rake', kind: PoolAccountKind.RAKE },
  { name: 'rewards', kind: PoolAccountKind.REWARDS },
  { name: 'external', kind: PoolAccountKind.EXTERNAL },
] as const;

const SKINS = [
  { id: 'default', name: 'Default', rarity: Rarity.COMMON },
  { id: 'neon', name: 'Neon', rarity: Rarity.RARE },
  { id: 'aurora', name: 'Aurora', rarity: Rarity.EPIC },
  { id: 'void', name: 'Void', rarity: Rarity.LEGENDARY },
] as const;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  console.log('Seeding reference data...');

  for (const pool of SYSTEM_POOLS) {
    await prisma.poolAccount.upsert({
      where: { name: pool.name },
      update: {},
      create: { name: pool.name, kind: pool.kind },
    });
  }

  for (const skin of SKINS) {
    await prisma.skin.upsert({
      where: { id: skin.id },
      update: { name: skin.name, rarity: skin.rarity },
      create: skin,
    });
  }

  // One `rooms` row per tier, from the same table the matchmaker runs its live
  // queues off. Without these the gateway's `GET /v1/rooms` returns an empty
  // list, because it reads durable rows rather than the in-memory tier config.
  for (const tier of ROOM_TIERS) {
    await prisma.room.upsert({
      where: { code: tier.id },
      update: {
        name: tier.name,
        maxPlayers: tier.maxPlayers,
        entryFeeLamports: tier.entryFeeLamports,
        rakeBps: tier.rakeBps,
      },
      create: {
        code: tier.id,
        name: tier.name,
        // Free play is casual; anything with a stake is a wager room.
        mode: tier.entryFeeLamports === 0n ? GameMode.CASUAL : GameMode.WAGER,
        status: RoomStatus.ACTIVE,
        maxPlayers: tier.maxPlayers,
        entryFeeLamports: tier.entryFeeLamports,
        rakeBps: tier.rakeBps,
      },
    });
  }

  console.log(
    `Seeded ${SYSTEM_POOLS.length} pool accounts, ${SKINS.length} skins, ` +
      `${ROOM_TIERS.length} rooms.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
