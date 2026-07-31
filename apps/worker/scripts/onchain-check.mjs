#!/usr/bin/env node
/**
 * Proves the Anchor program actually executes.
 *
 * Until now every on-chain path in this codebase was untested against a real
 * runtime: the program had never been deployed anywhere, so `initialize`,
 * `create_room` and the vault PDAs were only ever exercised through mocks and
 * `cargo test`. This runs them against a live validator and asserts on real
 * account state.
 *
 * Points at whatever `SOLANA_RPC_URL` says, so it works equally against the
 * local validator and devnet.
 *
 * Usage: pnpm onchain-check
 */
import { Keypair } from '@solana/web3.js';
import { ArenaService, roomIdFromUuid } from '@arena/solana';

import { loadSettlementAuthority } from '../dist/lib/settlement-authority.js';

const RPC = process.env.SOLANA_RPC_URL;
const PROGRAM_ID = process.env.ARENA_PROGRAM_ID;

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
}

const authority = loadSettlementAuthority(process.env.SETTLEMENT_AUTHORITY_SECRET);
if (!authority) {
  console.error('SETTLEMENT_AUTHORITY_SECRET is not set; nothing can be signed.');
  process.exit(1);
}

const solana = new ArenaService({
  programId: PROGRAM_ID,
  endpoints: [{ http: RPC, weight: 10, label: 'primary' }],
  commitment: 'confirmed',
  settlementAuthority: authority,
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
});

/**
 * `initialize` and `create_room` are once-only; a repeat is success.
 *
 * Anchor reports a re-initialised account as program error 0, which the client
 * renders as "Arena program error 0" rather than anything nameable — there is
 * no IDL error map on this hand-rolled client, so every failure arrives as a
 * number. Matching the number is therefore the only option.
 */
const alreadyDone = (error) =>
  /already in use|already initialized|program error 0\b|custom program error: 0x0\b/i.test(
    error instanceof Error ? error.message : String(error),
  );

async function main() {
  console.log(`\nOn-chain check — ${RPC}\n  program ${PROGRAM_ID}\n`);

  const info = await solana.connection.getAccountInfo(solana.programId ?? PROGRAM_ID).catch(() => null);
  check('the program is deployed and executable', info?.executable === true);
  if (!info?.executable) {
    console.log('\n  Nothing else can run without it.\n');
    process.exit(1);
  }

  // ---- initialize --------------------------------------------------------
  // The admin is the settlement authority here; in production they differ, and
  // `fee_destination` is what receives the rake.
  try {
    await solana.initializeProgram({
      admin: authority,
      settlementAuthority: authority.publicKey,
      feeBps: 1_000,
      withdrawalFeeBps: 0,
    });
    check('program config initialised', true, '(fee 10%)');
  } catch (error) {
    check('program config initialised', alreadyDone(error), alreadyDone(error) ? '(already)' : String(error).slice(0, 90));
  }

  const vaults = solana.getVaultAddresses();
  console.log(`      pool vault     ${vaults.pool.toBase58()}`);
  console.log(`      treasury vault ${vaults.treasury.toBase58()}`);

  // ---- create_room -------------------------------------------------------
  // A distinct id per run, so this is a genuine creation rather than a no-op.
  const gameId = Keypair.generate().publicKey.toBase58().slice(0, 8);
  const roomId = roomIdFromUuid(`${gameId}-0000-4000-8000-000000000000`);
  const vault = solana.getRoomVaultAddress(roomId);

  const before = await solana.connection.getBalance(vault);
  check('the match vault is empty before creation', before === 0, `${before} lamports`);

  try {
    await solana.createRoom({
      roomId,
      entryFeeLamports: 100_000_000n, // 0.1 SOL, the gold room
      maxPlayers: 65_535, // unlimited
    });
    check('create_room executed', true);
  } catch (error) {
    check('create_room executed', false, String(error).slice(0, 120));
  }

  const after = await solana.connection.getBalance(vault);
  // Rent-exempt minimum for a data-less system account. Non-zero is the proof
  // the PDA now exists on chain rather than merely being derivable.
  check('the match vault now exists on chain', after > 0, `${after} lamports`);
  console.log(`      match vault    ${vault.toBase58()}`);

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\non-chain check failed:', error.message);
  process.exit(1);
});
