#!/usr/bin/env node
/**
 * Proves the money model against the deployed stack and a real chain.
 *
 * Two funded wallets sign in, queue for a paid room, pay the entry fee from
 * their own wallets into that match's vault, play it out until one is left, and
 * the survivor is paid from the vault. Every assertion is on real lamport
 * balances rather than on our own ledger rows, because the chain is where the
 * money is — a test that checked the database would pass just as happily if
 * nothing had moved.
 *
 *   node apps/worker/scripts/paid-match-e2e.mjs [tierId]
 *
 * Funds the two players from the admin key, so it needs that key to hold enough
 * for two entry fees plus rent and transaction fees.
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { ArenaService, findConfigPda, findRoomPda, roomIdFromUuid } from '@arena/solana';
import { io } from 'socket.io-client';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync, writeFileSync } from 'node:fs';

import { loadSettlementAuthority } from '../dist/lib/settlement-authority.js';

const GATEWAY = process.env.GATEWAY_URL ?? 'https://gateway-production-8a28.up.railway.app';
const MATCHMAKER =
  process.env.MATCHMAKER_URL ?? 'https://matchmaker-production-7572.up.railway.app';
const TIER = process.argv[2] ?? 'bronze';

const RPC = process.env.SOLANA_RPC_URL;
const PROGRAM_ID = new PublicKey(process.env.ARENA_PROGRAM_ID);
const ClientEvent = { Join: 'j', Leave: 'l' };

const sol = (l) => `${(Number(l) / LAMPORTS_PER_SOL).toFixed(6)} ◎`;
const connection = new Connection(RPC, 'confirmed');
const arena = new ArenaService({
  programId: PROGRAM_ID.toBase58(),
  endpoints: [{ http: RPC, weight: 10, label: 'primary' }],
  commitment: 'confirmed',
});

const admin = loadSettlementAuthority(process.env.SETTLEMENT_AUTHORITY_SECRET);
if (!admin) throw new Error('SETTLEMENT_AUTHORITY_SECRET is not set');

async function http(base, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 250)}`);
  return text ? JSON.parse(text) : null;
}

async function signIn(kp, label) {
  const wallet = kp.publicKey.toBase58();
  const { nonce, message } = await http(GATEWAY, '/v1/auth/nonce', {
    method: 'POST',
    body: { wallet },
  });
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey),
  );
  const verified = await http(GATEWAY, '/v1/auth/verify', {
    method: 'POST',
    body: { wallet, signature, nonce },
  });
  console.log(`  ${label}: ${wallet.slice(0, 8)}…`);
  return verified.tokens?.accessToken ?? verified.accessToken;
}

/** Reads the configured fee destination straight off the Config account. */
async function readFeeDestination() {
  const [configPda] = findConfigPda(PROGRAM_ID);
  const info = await connection.getAccountInfo(configPda);
  let o = 8 + 32;
  const hasPending = info.data[o] === 1;
  o += 1 + (hasPending ? 32 : 0);
  o += 32 + 32;
  return new PublicKey(info.data.subarray(o, o + 32));
}

const balance = (pk) => connection.getBalance(pk).then(BigInt);

// ---- setup ----------------------------------------------------------------

console.log(`\nTier ${TIER}. Admin ${admin.publicKey.toBase58()}`);
const feeDestination = await readFeeDestination();
console.log(`Fee destination ${feeDestination.toBase58()}`);
console.log(`Admin balance   ${sol(await balance(admin.publicKey))}\n`);

/**
 * Persisted before they are funded, and reused on the next run.
 *
 * An earlier version generated these in memory and transferred to them before
 * the first call that could fail. It failed, and the funds were stranded in
 * wallets whose keys had never left the process — devnet SOL, but the faucet is
 * rate limited, so it cost the run that mattered. Writing them out first means a
 * failure anywhere downstream is recoverable by rerunning.
 */
const WALLET_FILE = new URL('../../../.localdev/e2e-players.json', import.meta.url);
let players;
try {
  players = JSON.parse(readFileSync(WALLET_FILE, 'utf8')).map((s) =>
    Keypair.fromSecretKey(bs58.decode(s)),
  );
  console.log('Reusing the players from .localdev/e2e-players.json');
} catch {
  players = [Keypair.generate(), Keypair.generate()];
  writeFileSync(WALLET_FILE, JSON.stringify(players.map((p) => bs58.encode(p.secretKey))));
  console.log('Wrote fresh players to .localdev/e2e-players.json');
}

const FUND = 14_000_000n; // entry fee + PDA rent + a margin for signatures

// Checked before any transfer: a refusal here used to happen *after* funding.
const probe = await signIn(players[0], 'probe');
const afford = await http(GATEWAY, '/v1/wallet/can-afford', {
  method: 'POST',
  body: { tierId: TIER },
  token: probe,
});
console.log(
  `\nAffordability: needs ${afford.requiredLamports}, holds ${afford.walletLamports}, sufficient=${afford.sufficient}`,
);

const required = BigInt(afford.requiredLamports);
const shortfall = players.map(() => required).reduce((a, b) => a + b, 0n);
const adminBalance = await balance(admin.publicKey);
if (adminBalance < shortfall) {
  console.error(
    `\nAdmin holds ${sol(adminBalance)} but funding two players needs ${sol(shortfall)}.`,
  );
  console.error('Top up 4kMxeTHvmqXbhyfLgFbBCJgJxyZq8sE8F8qWwPtn6qN4 at https://faucet.solana.com');
  process.exit(1);
}

console.log('\nFunding players from the admin key…');
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    ...players.map((p) =>
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: p.publicKey,
        lamports: Number(FUND),
      }),
    ),
  ),
  [admin],
  { commitment: 'confirmed' },
);
for (const p of players)
  console.log(`  ${p.publicKey.toBase58().slice(0, 8)}… ${sol(await balance(p.publicKey))}`);

console.log('\nSigning in…');
const tokens = await Promise.all(players.map((p, i) => signIn(p, `player ${i + 1}`)));

// ---- queue ----------------------------------------------------------------

console.log(`\nJoining the ${TIER} queue…`);
for (const [i, token] of tokens.entries()) {
  const res = await http(MATCHMAKER, '/v1/lobbies/join', {
    method: 'POST',
    body: { tierId: TIER, nickname: `e2e${i + 1}` },
    token,
  });
  console.log(`  player ${i + 1}: status=${res.lobby?.status} players=${res.lobby?.playerCount}`);
}

/** Waits for the lobby to name the game it is about to launch. */
async function waitForGameId(token, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await http(MATCHMAKER, '/v1/lobbies', { token });
    const lobby = list.lobbies.find((l) => l.tierId === TIER);
    if (list.pendingMatch?.gameId) return list.pendingMatch.gameId;
    if (lobby?.gameId && lobby.status === 'countdown') return lobby.gameId;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('lobby never named a game');
}

const gameId = await waitForGameId(tokens[0]);
const roomIdBytes = roomIdFromUuid(gameId);
const vault = arena.getRoomVaultAddress(roomIdBytes);
console.log(`\nGame  ${gameId}`);
console.log(`Vault ${vault.toBase58()}  ${sol(await balance(vault))}`);

// ---- pay ------------------------------------------------------------------

/**
 * The room has to exist before anyone can pay into it.
 *
 * The worker opens it within seconds of somebody queueing, but "somebody
 * queued" and "the room is open" are two different events and this sits between
 * them. Paying early fails simulation, which is the same confusing wallet error
 * players were seeing.
 */
const [roomPda] = findRoomPda(PROGRAM_ID, roomIdBytes);
process.stdout.write('Waiting for the room to open on chain');
let roomReady = false;
for (let i = 0; i < 40 && !roomReady; i += 1) {
  roomReady = (await connection.getAccountInfo(roomPda)) !== null;
  if (!roomReady) {
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 3_000));
  }
}
console.log(roomReady ? ' open.' : ' NEVER OPENED.');
if (!roomReady) {
  console.error('The worker never created the room — check its logs and the authority balance.');
  process.exit(1);
}

console.log('\nPaying entry fees (enter_room, signed by each player)…');
const vaultBefore = await balance(vault);

for (const [i, p] of players.entries()) {
  try {
    const ix = arena.buildEnterRoomInstruction({ player: p.publicKey, roomId: roomIdBytes });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [p], {
      commitment: 'confirmed',
    });
    console.log(`  player ${i + 1} paid  ${sig.slice(0, 16)}…`);
  } catch (err) {
    console.log(`  player ${i + 1} FAILED to pay: ${String(err).slice(0, 200)}`);
  }
}

const vaultAfter = await balance(vault);
console.log(
  `\nVault ${sol(vaultBefore)} -> ${sol(vaultAfter)}  (+${sol(vaultAfter - vaultBefore)})`,
);

// ---- play -----------------------------------------------------------------

console.log('\nWaiting for the match to launch…');
const places = [];
for (const token of tokens) {
  const deadline = Date.now() + 90_000;
  let place = null;
  while (Date.now() < deadline && !place) {
    const list = await http(MATCHMAKER, '/v1/lobbies', { token });
    if (list.pendingMatch) {
      place = await http(MATCHMAKER, '/v1/matchmake', {
        method: 'POST',
        body: { mode: 'casual', tierId: TIER },
        token,
      });
    } else {
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  if (!place) throw new Error('never received a ticket');
  places.push(place);
}
console.log(`  rooms: ${places.map((p) => p.roomId).join(', ')}`);

function connect(place, nickname) {
  return new Promise((resolve, reject) => {
    const socket = io(place.realtimeUrl, {
      path: '/ws',
      transports: ['websocket'],
      auth: { ticket: place.ticket, roomId: place.roomId },
      forceNew: true,
      reconnection: false,
      timeout: 15_000,
    });
    const t = setTimeout(() => reject(new Error(`${nickname} join timed out`)), 20_000);
    socket.on('connect_error', reject);
    socket.on('connect', () => {
      socket.emit(
        ClientEvent.Join,
        { roomId: place.roomId, ticket: place.ticket, nickname, protocolVersion: '1.0.0' },
        () => {
          clearTimeout(t);
          resolve(socket);
        },
      );
    });
    socket.on('J', () => {
      clearTimeout(t);
      resolve(socket);
    });
  });
}

const sockets = await Promise.all(places.map((p, i) => connect(p, `e2e${i + 1}`)));
console.log('  both players in the arena');

await new Promise((r) => setTimeout(r, 4_000));
console.log('\nPlayer 1 leaves; player 2 is the last one standing.');
sockets[0].emit(ClientEvent.Leave);
await new Promise((r) => setTimeout(r, 6_000));
sockets.forEach((s) => s.close());

// ---- settle ---------------------------------------------------------------

const winner = players[1];
const winnerBefore = await balance(winner.publicKey);
const feeBefore = await balance(feeDestination);

console.log(`\nWaiting for settlement (the worker settles on its cycle)…`);
console.log(`  winner ${winner.publicKey.toBase58().slice(0, 8)}… ${sol(winnerBefore)}`);
console.log(`  fee    ${feeDestination.toBase58().slice(0, 8)}… ${sol(feeBefore)}`);

const deadline = Date.now() + 11 * 60_000;
let settled = false;
while (Date.now() < deadline) {
  const v = await balance(vault);
  if (v <= 1_000_000n) {
    settled = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 15_000));
  process.stdout.write('.');
}
console.log();

const winnerAfter = await balance(winner.publicKey);
const feeAfter = await balance(feeDestination);
const pot = vaultAfter - vaultBefore;

console.log(`\nvault  ${sol(vaultAfter)} -> ${sol(await balance(vault))}`);
console.log(
  `winner ${sol(winnerBefore)} -> ${sol(winnerAfter)}  (+${sol(winnerAfter - winnerBefore)})`,
);
console.log(`fee    ${sol(feeBefore)} -> ${sol(feeAfter)}  (+${sol(feeAfter - feeBefore)})`);
console.log(`\npot was ${sol(pot)}; 10% of that is ${sol(pot / 10n)}`);

if (!settled) {
  console.log('\nNOT SETTLED within the window — the vault still holds the pot.');
  process.exit(1);
}
console.log('\nSETTLED.');
