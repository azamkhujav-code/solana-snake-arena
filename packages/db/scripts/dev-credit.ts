/**
 * Credits a wallet's custody balance, for local development.
 *
 *   pnpm credit <wallet-address> [sol]
 *   pnpm credit HaMuP4mk... 5
 *
 * **This is not a deposit.** No SOL moves on chain and nothing is verified
 * against a signature. It exists because real deposits need the Anchor program
 * deployed, which it is not, and without a balance there is no way to exercise
 * staking, room joins or settlement locally.
 *
 * It posts a proper double-entry pair — debit EXTERNAL, credit custody —
 * exactly as `confirmDeposit` would. Bumping `balance_lamports` directly would
 * be a lie the treasury page immediately catches: the ledger invariant
 * `SUM(pool balances) == SUM(posted entries)` would report drift equal to
 * whatever was credited. That bug existed in `consumeReservations` and is worth
 * not reintroducing here.
 *
 * Refuses to run against a non-local database.
 */
import {
  PoolAccountKind,
  PrismaClient,
  TransactionDirection,
  TransactionType,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

const [address, solArg] = process.argv.slice(2);

if (!address) {
  console.error('Usage: pnpm credit <wallet-address> [sol]');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!/localhost|127\.0\.0\.1/.test(databaseUrl)) {
  // A script that mints balances must never be pointable at a real database.
  console.error('Refusing to run: DATABASE_URL is not local.');
  process.exit(1);
}

const sol = Number(solArg ?? '5');
if (!Number.isFinite(sol) || sol <= 0) {
  console.error(`Invalid amount: ${solArg}`);
  process.exit(1);
}

const lamports = BigInt(Math.round(sol * 1e9));
const prisma = new PrismaClient();

try {
  const wallet = await prisma.wallet.findUnique({
    where: { address },
    include: { user: true },
  });

  if (!wallet) {
    console.error(`No wallet ${address}. Sign in with it once first, then re-run.`);
    process.exit(1);
  }

  const external = await prisma.poolAccount.findUnique({ where: { name: 'external' } });
  if (!external) {
    console.error('The EXTERNAL pool account is missing. Run `pnpm db:seed`.');
    process.exit(1);
  }

  const custody = await prisma.poolAccount.upsert({
    where: { name: `custody:${wallet.userId}` },
    update: {},
    create: {
      name: `custody:${wallet.userId}`,
      kind: PoolAccountKind.USER_CUSTODY,
      ownerUserId: wallet.userId,
    },
  });

  const entryGroupId = randomUUID();

  const result = await prisma.$transaction(async (tx) => {
    const custodyRow = await tx.poolAccount.findUniqueOrThrow({ where: { id: custody.id } });
    const externalRow = await tx.poolAccount.findUniqueOrThrow({ where: { id: external.id } });

    const custodyAfter = custodyRow.balanceLamports + lamports;
    // EXTERNAL mirrors net inflow rather than funds held, so it goes negative.
    // It is the one account allowed to.
    const externalAfter = externalRow.balanceLamports - lamports;

    await tx.poolAccount.update({
      where: { id: custodyRow.id, version: custodyRow.version },
      data: { balanceLamports: custodyAfter, version: { increment: 1 } },
    });
    await tx.poolAccount.update({
      where: { id: externalRow.id, version: externalRow.version },
      data: { balanceLamports: externalAfter, version: { increment: 1 } },
    });

    await tx.transaction.createMany({
      data: [
        {
          entryGroupId,
          type: TransactionType.DEPOSIT,
          direction: TransactionDirection.DEBIT,
          amountLamports: lamports,
          balanceAfterLamports: externalAfter,
          poolAccountId: externalRow.id,
          idempotencyKey: `dev-credit:${entryGroupId}:external`,
          description: 'Development credit (not a real deposit)',
        },
        {
          entryGroupId,
          type: TransactionType.DEPOSIT,
          direction: TransactionDirection.CREDIT,
          amountLamports: lamports,
          balanceAfterLamports: custodyAfter,
          userId: wallet.userId,
          poolAccountId: custodyRow.id,
          idempotencyKey: `dev-credit:${entryGroupId}`,
          description: 'Development credit (not a real deposit)',
        },
      ],
    });

    return custodyAfter;
  });

  // Prove the books still balance rather than asserting it.
  const [pools, ledger] = await Promise.all([
    prisma.poolAccount.aggregate({ _sum: { balanceLamports: true } }),
    prisma.transaction.groupBy({
      by: ['direction'],
      where: { status: 'POSTED' },
      _sum: { amountLamports: true },
    }),
  ]);

  const poolTotal = pools._sum.balanceLamports ?? 0n;
  const ledgerTotal = ledger.reduce(
    (sum, row) =>
      sum +
      (row.direction === TransactionDirection.CREDIT
        ? (row._sum.amountLamports ?? 0n)
        : -(row._sum.amountLamports ?? 0n)),
    0n,
  );

  console.log(`\n  Credited ${sol} SOL to ${address}`);
  console.log(`  Custody balance: ${Number(result) / 1e9} SOL`);
  console.log(`  Ledger drift:    ${poolTotal - ledgerTotal} lamports (must be 0)\n`);

  if (poolTotal !== ledgerTotal) {
    console.error('  Ledger does not balance. Something posted a balance without an entry.');
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
