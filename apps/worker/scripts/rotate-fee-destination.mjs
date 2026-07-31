#!/usr/bin/env node
/**
 * Points the platform fee at a different wallet.
 *
 * The rake is paid straight to `Config.fee_destination` at settlement, and
 * `settle_to_winner` constrains the account it is given against that value — so
 * the destination has to be changed on chain, not just in the backend's
 * environment. Setting `FEE_DESTINATION` alone makes every settlement fail the
 * constraint rather than paying somewhere new.
 *
 *   node apps/worker/scripts/rotate-fee-destination.mjs <pubkey>
 *
 * Signed by the admin key, read from SETTLEMENT_AUTHORITY_SECRET. Prints the
 * config before and after so the change is visible rather than assumed.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createUpdateConfigInstruction, findConfigPda } from '@arena/solana';
import bs58 from 'bs58';

import { loadSettlementAuthority } from '../dist/lib/settlement-authority.js';

const target = process.argv[2];
if (!target) {
  console.error('Usage: rotate-fee-destination.mjs <pubkey>');
  process.exit(1);
}

const RPC = process.env.SOLANA_RPC_URL;
const PROGRAM_ID = new PublicKey(process.env.ARENA_PROGRAM_ID);
const feeDestination = new PublicKey(target);

const admin = loadSettlementAuthority(process.env.SETTLEMENT_AUTHORITY_SECRET);
if (!admin) {
  console.error('SETTLEMENT_AUTHORITY_SECRET is not set.');
  process.exit(1);
}

const connection = new Connection(RPC, 'confirmed');
const [configPda] = findConfigPda(PROGRAM_ID);

/** Reads `fee_destination` out of the Config account. */
async function readFeeDestination() {
  const info = await connection.getAccountInfo(configPda);
  if (!info) throw new Error('config account does not exist');

  // 8 discriminator + admin(32) + Option<Pubkey> pending_admin + authority(32)
  // + treasury(32), then fee_destination.
  let o = 8 + 32;
  const hasPending = info.data[o] === 1;
  o += 1 + (hasPending ? 32 : 0);
  o += 32 + 32;
  return new PublicKey(info.data.subarray(o, o + 32)).toBase58();
}

console.log(`admin            ${admin.publicKey.toBase58()}`);
console.log(`fee destination  ${await readFeeDestination()}  (before)`);

const signature = await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    createUpdateConfigInstruction({
      programId: PROGRAM_ID,
      admin: admin.publicKey,
      // Everything else stays as it is: `None` leaves the stored value alone.
      feeDestination,
    }),
  ),
  [admin],
  { commitment: 'confirmed' },
);

console.log(`fee destination  ${await readFeeDestination()}  (after)`);
console.log(`signature        ${signature}`);
