#!/usr/bin/env node
/**
 * Creates or funds a devnet test wallet.
 *
 *   node scripts/test-wallet.mjs new           # generate a keypair
 *   node scripts/test-wallet.mjs new --fund    # generate, then airdrop 2 SOL
 *   node scripts/test-wallet.mjs fund <pubkey> # airdrop to an existing wallet
 *   node scripts/test-wallet.mjs balance <pubkey>
 *
 * The private key is printed in the base58 form Phantom's "Import Private Key"
 * expects, so a generated wallet can be used in the browser without extra
 * conversion steps.
 *
 * Devnet only, by construction: the RPC URL is read from `.env` and the script
 * refuses to run against mainnet. Airdropping is impossible there anyway, but
 * printing a private key to a terminal is a habit worth keeping away from any
 * cluster where it could matter.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

function readEnv(key, fallback) {
  try {
    const line = readFileSync('.env', 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : fallback;
  } catch {
    return fallback;
  }
}

const RPC = readEnv('SOLANA_RPC_URL', 'https://api.devnet.solana.com');
const CLUSTER = readEnv('SOLANA_CLUSTER', 'devnet');

if (CLUSTER === 'mainnet-beta' || RPC.includes('mainnet')) {
  console.error('Refusing to run against mainnet. This script prints private keys.');
  process.exit(1);
}

const connection = new Connection(RPC, 'confirmed');
const [command, ...args] = process.argv.slice(2);

/** Airdrops and waits for confirmation, reporting the faucet's own refusals. */
async function fund(pubkey, sol = 2) {
  console.log(`\nRequesting ${sol} SOL from the ${CLUSTER} faucet...`);

  try {
    const signature = await connection.requestAirdrop(
      new PublicKey(pubkey),
      sol * LAMPORTS_PER_SOL,
    );
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature, ...latest }, 'confirmed');

    const balance = await connection.getBalance(new PublicKey(pubkey));
    console.log(`  Funded. Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    console.log(`  https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  } catch (error) {
    // The public faucet is aggressively rate limited and frequently refuses.
    // Say so plainly rather than letting it look like a bug in this script.
    console.log(`  Faucet refused: ${error.message}`);
    console.log('  The public devnet faucet is heavily rate limited. Alternatives:');
    console.log('    • https://faucet.solana.com  (web faucet, separate limits)');
    console.log('    • solana airdrop 2 <pubkey> --url devnet  (if the CLI is installed)');
  }
}

switch (command) {
  case 'new': {
    const keypair = Keypair.generate();
    const pubkey = keypair.publicKey.toBase58();
    // Phantom's import expects the 64-byte secret key, base58 encoded.
    const secret = bs58.encode(keypair.secretKey);

    mkdirSync('.localdev', { recursive: true });
    const path = '.localdev/test-wallet.json';
    writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));

    console.log('\n  Public key   ', pubkey);
    console.log('  Private key  ', secret);
    console.log(`\n  Saved to ${path} (gitignored; this is a throwaway devnet key).`);
    console.log('\n  To use it in the browser:');
    console.log('    1. Install Phantom      https://phantom.app/download');
    console.log('    2. Settings → Developer Settings → Testnet Mode → Devnet');
    console.log('    3. Add account → Import Private Key → paste the key above');

    if (args.includes('--fund')) await fund(pubkey);
    break;
  }

  case 'fund': {
    const pubkey = args[0];
    if (!pubkey) {
      console.error('Usage: node scripts/test-wallet.mjs fund <pubkey>');
      process.exit(1);
    }
    await fund(pubkey, Number(args[1] ?? 2));
    break;
  }

  case 'balance': {
    const pubkey = args[0];
    if (!pubkey) {
      console.error('Usage: node scripts/test-wallet.mjs balance <pubkey>');
      process.exit(1);
    }
    const balance = await connection.getBalance(new PublicKey(pubkey));
    console.log(`  ${balance / LAMPORTS_PER_SOL} SOL on ${CLUSTER}`);
    break;
  }

  default:
    console.log(`
  node scripts/test-wallet.mjs new              generate a keypair
  node scripts/test-wallet.mjs new --fund       generate, then airdrop 2 SOL
  node scripts/test-wallet.mjs fund <pubkey>    airdrop to an existing wallet
  node scripts/test-wallet.mjs balance <pubkey> check a balance
`);
}
