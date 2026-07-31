#!/usr/bin/env node
/**
 * End-to-end proof of the staked match money path, against the running stack.
 *
 * Drives the whole thing the way a player does — sign in, deposit, confirm the
 * entry fee, join, play, die — and then asserts where every lamport ended up.
 *
 * Why a script and not a unit test: the properties that matter here only exist
 * when the real services are wired together. The entry fee is reserved by the
 * gateway, consumed by the worker, held by a pool account created by a third
 * stage, and paid out by settlement reading a result published by the realtime
 * node over Redis. Each of those is individually tested; none of those tests
 * would catch the escrow account being created under a name the consuming stage
 * does not look up, which is exactly the class of bug this found.
 *
 * The cycle is nine minutes by design, so the stages are invoked directly in
 * order rather than waited for. That is the same code the scheduler runs — only
 * the clock is skipped.
 *
 * Usage: pnpm match-flow [tierId]        (default: gold, 0.1 SOL)
 */
import { randomUUID } from 'node:crypto';

import { PoolAccountKind, getPrismaClient } from '@arena/db';
import { ROOM_TIERS } from '@arena/lobby';
import bs58 from 'bs58';
import { runStages, settleWithWinner } from './match-flow-stages.mjs';
import nacl from 'tweetnacl';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:4200';
const MATCHMAKER = process.env.MATCHMAKER_URL ?? 'http://127.0.0.1:4202';
const TIER_ID = process.argv[2] ?? 'gold';

const tier = ROOM_TIERS.find((entry) => entry.id === TIER_ID);
if (!tier) {
  console.error(`Unknown tier "${TIER_ID}". Known: ${ROOM_TIERS.map((t) => t.id).join(', ')}`);
  process.exit(1);
}
if (tier.entryFeeLamports === 0n) {
  console.error(`Tier "${TIER_ID}" is free; there is no money path to prove.`);
  process.exit(1);
}

const prisma = getPrismaClient({ datasourceUrl: process.env.DATABASE_URL });

let failures = 0;
const sol = (lamports) => `${(Number(lamports) / 1e9).toFixed(4)} ◎`;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) console.log(`      expected ${expected}\n      actual   ${actual}`);
}

async function api(base, path, { token, body, method = 'GET' } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

/** A fresh wallet with a real ed25519 signature over the server's own message. */
async function signIn(label) {
  const keypair = nacl.sign.keyPair();
  const wallet = bs58.encode(keypair.publicKey);
  const nonce = await api(GATEWAY, '/v1/auth/nonce', { method: 'POST', body: { wallet } });
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(nonce.message), keypair.secretKey),
  );
  const session = await api(GATEWAY, '/v1/auth/verify', {
    method: 'POST',
    body: { wallet, signature, nonce: nonce.nonce },
  });
  return { label, wallet, token: session.tokens.accessToken, userId: session.player.id };
}

/** Credits custody with balanced EXTERNAL -> custody legs, as a deposit would. */
async function credit(userId, lamports) {
  const external = await prisma.poolAccount.findFirstOrThrow({
    where: { kind: PoolAccountKind.EXTERNAL },
  });
  const custody = await prisma.poolAccount.upsert({
    where: { name: `custody:${userId}` },
    update: {},
    create: { name: `custody:${userId}`, kind: PoolAccountKind.USER_CUSTODY, ownerUserId: userId },
  });

  await prisma.$transaction(async (tx) => {
    const after = custody.balanceLamports + lamports;
    await tx.poolAccount.update({
      where: { id: custody.id },
      data: { balanceLamports: after },
    });
    await tx.poolAccount.update({
      where: { id: external.id },
      data: { balanceLamports: { decrement: lamports } },
    });
    const group = randomUUID();
    await tx.transaction.createMany({
      data: [
        {
          entryGroupId: group,
          type: 'DEPOSIT',
          direction: 'DEBIT',
          amountLamports: lamports,
          balanceAfterLamports: external.balanceLamports - lamports,
          poolAccountId: external.id,
          idempotencyKey: `flow:${group}:ext`,
        },
        {
          entryGroupId: group,
          type: 'DEPOSIT',
          direction: 'CREDIT',
          amountLamports: lamports,
          balanceAfterLamports: after,
          userId,
          poolAccountId: custody.id,
          idempotencyKey: `flow:${group}:custody`,
        },
      ],
    });
  });
}

async function custodyBalance(userId) {
  const account = await prisma.poolAccount.findUnique({ where: { name: `custody:${userId}` } });
  return account?.balanceLamports ?? 0n;
}

/**
 * Gives each player a seat row.
 *
 * Settlement refuses a report naming anyone who did not have one, which is what
 * stops a compromised node inventing a winner. The real pipeline writes these in
 * `start-match`; this stands in for it.
 */
async function seatPlayers(gameId, players, entryFeeLamports) {
  for (const player of players) {
    await prisma.gamePlayer.upsert({
      where: { gameId_userId: { gameId, userId: player.userId } },
      update: {},
      create: {
        gameId,
        userId: player.userId,
        nickname: player.label,
        entryPaidLamports: entryFeeLamports,
      },
    });
  }
}

/**
 * Retires any match already live for this tier.
 *
 * `/v1/matches/wallets` reports the newest live game per tier, so a game left
 * behind by a previous run — or by the real scheduler, which is running the same
 * ten-minute cycle in the background — is what the assertions would read. The
 * first version of this script failed on exactly that: it asserted an empty
 * wallet and found the previous run's funded one.
 *
 * Marked CANCELLED rather than deleted so the ledger rows they own keep their
 * foreign key, which is what keeps the drift check meaningful.
 */
async function clearLiveGames() {
  const { count } = await prisma.game.updateMany({
    where: { room: { code: TIER_ID }, status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'CANCELLED', endedAt: new Date() },
  });

  // Orphaned reservations are the more damaging leftover: they are keyed by
  // tier, so one surviving from a previous run makes the next `close-lobby`
  // refuse the whole match on a staked-total mismatch.
  const { count: released } = await prisma.stakeReservation.deleteMany({
    where: { tierId: TIER_ID },
  });

  if (count > 0 || released > 0) {
    console.log(`  retired ${count} leftover game(s), released ${released} reservation(s)\n`);
  }
}

/** Reservations are tier-wide, so only this run's contribution is meaningful. */
async function committedForTier() {
  const sum = await prisma.stakeReservation.aggregate({
    where: { tierId: TIER_ID },
    _sum: { lamports: true },
  });
  return sum._sum.lamports ?? 0n;
}

/** Rake accumulates across every match, so only its change is meaningful. */
async function rakeBalance() {
  const account = await prisma.poolAccount.findFirst({
    where: { kind: PoolAccountKind.RAKE },
  });
  return account?.balanceLamports ?? 0n;
}

async function ledgerDrift() {
  const [pools, posted] = await Promise.all([
    prisma.poolAccount.aggregate({ _sum: { balanceLamports: true } }),
    prisma.transaction.findMany({
      where: { status: 'POSTED' },
      select: { direction: true, amountLamports: true },
    }),
  ]);
  const net = posted.reduce(
    (total, row) => total + (row.direction === 'CREDIT' ? row.amountLamports : -row.amountLamports),
    0n,
  );
  return (pools._sum.balanceLamports ?? 0n) - net;
}

async function main() {
  console.log(`\nMatch money path — ${tier.name} (${sol(tier.entryFeeLamports)} entry)\n`);

  await clearLiveGames();
  const driftBefore = await ledgerDrift();
  const rakeBefore = await rakeBalance();
  const committedBefore = await committedForTier();

  // --- players -----------------------------------------------------------
  const alice = await signIn('alice');
  const bob = await signIn('bob');
  const funding = tier.entryFeeLamports * 3n;
  await credit(alice.userId, funding);
  await credit(bob.userId, funding);
  console.log(`  two players funded with ${sol(funding)} each\n`);

  // --- open the lobby ----------------------------------------------------
  // Before the joins, as the scheduler does. Skipping this was fine only while
  // the lobby happened to be left open by a previous run; against a lobby stuck
  // in `launching` every join is refused, which is what surfaced the missing
  // stake refund.
  const opened = await runStages(prisma, TIER_ID, ['create-game', 'create-pool', 'open-lobby']);
  const gameId = opened.gameId;

  // --- join (reserves the entry fee) -------------------------------------
  console.log('Join — the fee is reserved, not yet moved:');
  for (const player of [alice, bob]) {
    const joined = await api(MATCHMAKER, '/v1/lobbies/join', {
      method: 'POST',
      token: player.token,
      body: { tierId: TIER_ID, nickname: player.label },
    });
    // A refusal is returned, not thrown. Ignoring it was how an earlier version
    // of this script "passed" against a lobby nobody was actually in.
    if (joined.rejected !== null) {
      throw new Error(`${player.label} was refused: ${joined.rejected}`);
    }
  }

  const wallets = await api(GATEWAY, '/v1/matches/wallets', { token: alice.token });
  const beforeStart = wallets.wallets.find((w) => w.tierId === TIER_ID);
  // A delta, because reservations are tier-wide and a lobby the real scheduler
  // is running alongside this would count too. The absolute figure was right
  // only on an otherwise-idle database.
  check(
    'both entry fees are committed',
    BigInt(beforeStart.committedLamports) - committedBefore,
    tier.entryFeeLamports * 2n,
  );
  check('the match wallet still holds nothing', BigInt(beforeStart.balanceLamports), 0n);
  check(
    'each player keeps their balance for now',
    await custodyBalance(alice.userId),
    funding,
  );

  // --- launch (consumes reservations into the match wallet) ---------------
  console.log('\nLaunch — the fees move into this match’s own wallet:');

  await runStages(prisma, TIER_ID, ['close-lobby'], opened);

  const escrow = await prisma.poolAccount.findUniqueOrThrow({
    where: { name: `escrow:${gameId}` },
  });
  check('the match wallet has its own address', escrow.onchainAddress !== null, true);
  check('the pot is in the match wallet', escrow.balanceLamports, tier.entryFeeLamports * 2n);
  check(
    'the fee has left each player',
    await custodyBalance(alice.userId),
    funding - tier.entryFeeLamports,
  );

  const afterStart = (await api(GATEWAY, '/v1/matches/wallets', { token: alice.token })).wallets.find(
    (w) => w.tierId === TIER_ID,
  );
  console.log(`      wallet ${escrow.onchainAddress}`);
  console.log(
    `      holds ${sol(afterStart.balanceLamports)} · winner takes ${sol(afterStart.prizeLamports)} · on chain: ${afterStart.onChain}`,
  );

  // --- settle (last snake standing) --------------------------------------
  console.log('\nSettle — alice dies first, so bob is the last snake standing:');
  await seatPlayers(gameId, [alice, bob], tier.entryFeeLamports);
  const outcome = await settleWithWinner(prisma, gameId, { winner: bob, loser: alice });
  check('settlement reports success', outcome.status, 'settled');

  const pot = tier.entryFeeLamports * 2n;
  const rake = (pot * BigInt(tier.rakeBps)) / 10_000n;
  const prize = pot - rake;

  check('the survivor is paid the pot less the fee', await custodyBalance(bob.userId), funding - tier.entryFeeLamports + prize);
  check('the eliminated player gets nothing back', await custodyBalance(alice.userId), funding - tier.entryFeeLamports);
  check('the match wallet is emptied', (await prisma.poolAccount.findUniqueOrThrow({ where: { id: escrow.id } })).balanceLamports, 0n);

  check('the platform fee is collected', (await rakeBalance()) - rakeBefore, rake);

  console.log(`      pot ${sol(pot)} → winner ${sol(prize)} + platform ${sol(rake)} (${tier.rakeBps / 100}%)`);

  // --- the invariant that makes all of the above trustworthy -------------
  console.log('\nBooks:');
  const driftAfter = await ledgerDrift();
  check('the ledger still balances', driftAfter, driftBefore);

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nflow failed:', error.message);
  await prisma.$disconnect();
  process.exit(1);
});
