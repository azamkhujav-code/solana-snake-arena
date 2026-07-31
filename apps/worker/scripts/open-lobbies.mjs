#!/usr/bin/env node
/**
 * Opens every tier's lobby immediately.
 *
 * Lobby state lives in Redis and survives a restart, so a stack brought back up
 * mid-cycle finds every room in whatever status it was left in — usually
 * `launching`, which refuses joins. The scheduler heals this on its next
 * ten-minute tick, but that is ten minutes of a board nobody can use.
 *
 * Runs the same `create-game` → `create-pool` → `open-lobby` stages the cycle
 * does, so this is a nudge rather than a special case.
 *
 * Usage: pnpm open-lobbies
 */
import { getPrismaClient } from '@arena/db';
import { ROOM_TIERS } from '@arena/lobby';

import { runStages } from './match-flow-stages.mjs';

const prisma = getPrismaClient({ datasourceUrl: process.env.DATABASE_URL });

async function main() {
  console.log('\nOpening lobbies\n');

  for (const tier of ROOM_TIERS) {
    try {
      const data = await runStages(prisma, tier.id, [
        'create-game',
        'create-pool',
        'open-lobby',
      ]);
      console.log(`  ✓ ${tier.id.padEnd(9)} game ${String(data.gameId).slice(0, 8)}`);
    } catch (error) {
      console.log(`  ✗ ${tier.id.padEnd(9)} ${error.message.slice(0, 70)}`);
    }
  }

  await prisma.$disconnect();
  console.log('');
}

main().catch(async (error) => {
  console.error('failed:', error.message);
  await prisma.$disconnect();
  process.exit(1);
});
