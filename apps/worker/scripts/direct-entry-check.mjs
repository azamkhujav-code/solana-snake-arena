#!/usr/bin/env node
/**
 * Proves the direct-entry money model on a real chain.
 *
 * The new model in one line: a player pays the room's exact fee from their own
 * wallet into that match's vault, and the last one alive is paid out of that
 * vault straight back to their wallet. No custody balance at either end.
 *
 * Every assertion below is on real lamport balances rather than on a ledger
 * row, because the whole point of the change is that the chain — not the
 * database — is where the money is. A test that checked our own bookkeeping
 * would pass just as happily if nothing moved on chain at all.
 *
 * Usage: SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm direct-entry-check
 */
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ArenaService, roomIdFromUuid } from '@arena/solana';

import { loadSettlementAuthority } from '../dist/lib/settlement-authority.js';

const RPC = process.env.SOLANA_RPC_URL;
const PROGRAM_ID = process.env.ARENA_PROGRAM_ID;
const ENTRY_FEE = 100_000_000n; // 0.1 SOL, the gold room
const RAKE_BPS = 1_000n; // 10%

let failures = 0;
const sol = (l) => `${(Number(l) / LAMPORTS_PER_SOL).toFixed(4)} ◎`;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) console.log(`      expected ${expected}\n      actual   ${actual}`);
}

const authority = loadSettlementAuthority(process.env.SETTLEMENT_AUTHORITY_SECRET);
if (!authority) {
  console.error('SETTLEMENT_AUTHORITY_SECRET is not set.');
  process.exit(1);
}

const solana = new ArenaService({
  programId: PROGRAM_ID,
  endpoints: [{ http: RPC, weight: 10, label: 'primary' }],
  commitment: 'confirmed',
  settlementAuthority: authority,
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
});

const conn = solana.connection;
const balance = async (pk) => BigInt(await conn.getBalance(pk, 'confirmed'));
const alreadyDone = (e) =>
  /already in use|already initialized|program error 0\b|custom program error: 0x0\b/i.test(
    e instanceof Error ? e.message : String(e),
  );

/** A funded player wallet, as a real user would have. */
async function fundedPlayer(label) {
  const kp = Keypair.generate();
  const sig = await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, 'confirmed');
  return { label, kp };
}

async function main() {
  console.log(`\nDirect-entry money path — ${RPC}\n`);

  try {
    await solana.initializeProgram({
      admin: authority,
      settlementAuthority: authority.publicKey,
      feeDestination: authority.publicKey,
      feeBps: Number(RAKE_BPS),
    });
  } catch (error) {
    if (!alreadyDone(error)) throw error;
  }

  // A fresh room per run, so this is a genuine match rather than a no-op.
  const gameId = `${Keypair.generate().publicKey.toBase58().slice(0, 8)}-0000-4000-8000-000000000000`;
  const roomId = roomIdFromUuid(gameId);
  const vault = solana.getRoomVaultAddress(roomId);

  await solana.createRoom({ roomId, entryFeeLamports: ENTRY_FEE, maxPlayers: 65_535 });
  const vaultAfterCreate = await balance(vault);
  console.log(`  match vault ${vault.toBase58()}`);
  console.log(`  rent-exempt floor ${sol(vaultAfterCreate)}\n`);

  // ---- two players pay their own way in --------------------------------
  console.log('Entry — each player pays the exact fee from their own wallet:');
  const alice = await fundedPlayer('alice');
  const bob = await fundedPlayer('bob');

  const before = { alice: await balance(alice.kp.publicKey), bob: await balance(bob.kp.publicKey) };

  for (const player of [alice, bob]) {
    const ix = solana.buildEnterRoomInstruction({ player: player.kp.publicKey, roomId });
    await solana.sendSigned([ix], [player.kp]);
  }

  const vaultAfterEntry = await balance(vault);
  check('the vault holds both entry fees', vaultAfterEntry - vaultAfterCreate, ENTRY_FEE * 2n);

  // Fees plus transaction costs, so the wallet is down by at least the fee.
  const aliceSpent = before.alice - (await balance(alice.kp.publicKey));
  check('the fee actually left the player wallet', aliceSpent >= ENTRY_FEE, true);

  // Entering twice must be impossible — the RoomPlayer PDA already exists.
  let doubleEntryRejected = false;
  try {
    const ix = solana.buildEnterRoomInstruction({ player: alice.kp.publicKey, roomId });
    await solana.sendSigned([ix], [alice.kp]);
  } catch {
    doubleEntryRejected = true;
  }
  check('a second entry by the same player is refused', doubleEntryRejected, true);

  // ---- the match runs and bob survives ---------------------------------
  console.log('\nSettlement — alice dies, bob is the last snake standing:');
  await solana.startRoom(roomId);
  await solana.unlockPrize(roomId);

  const pot = ENTRY_FEE * 2n;
  const rake = (pot * RAKE_BPS) / 10_000n;
  const prize = pot - rake;

  const bobBefore = await balance(bob.kp.publicKey);
  const feeBefore = await balance(authority.publicKey);

  await solana.settleToWinner({
    roomId,
    winner: bob.kp.publicKey,
    feeDestination: authority.publicKey,
  });

  const bobGained = (await balance(bob.kp.publicKey)) - bobBefore;
  check('the winner is paid into their own wallet', bobGained, prize);

  // The authority pays the transaction fee, so compare the net movement.
  const feeGained = (await balance(authority.publicKey)) - feeBefore;
  check('the platform fee reaches the admin wallet', feeGained > 0n, true);

  const vaultAfterSettle = await balance(vault);
  check('the match vault is emptied of stakes', vaultAfterSettle, vaultAfterCreate);

  check('alice, who died, is paid nothing', (await balance(alice.kp.publicKey)) < before.alice, true);

  console.log(
    `      pot ${sol(pot)} → winner ${sol(prize)} + platform ${sol(rake)} (${Number(RAKE_BPS) / 100}%)`,
  );

  // Paying twice would drain another room's escrow.
  let doublePayRejected = false;
  try {
    await solana.settleToWinner({
      roomId,
      winner: bob.kp.publicKey,
      feeDestination: authority.publicKey,
    });
  } catch {
    doublePayRejected = true;
  }
  check('settling a second time is refused', doublePayRejected, true);

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\ndirect-entry check failed:', error.message);
  process.exit(1);
});
