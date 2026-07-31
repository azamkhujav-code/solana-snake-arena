#!/usr/bin/env node
/**
 * Reports what the chain thinks of each room a lobby is currently offering.
 *
 * `enter_room` — the instruction the browser signs to pay an entry fee —
 * requires the room account to exist and to be `Open`. When it is neither, the
 * wallet cannot simulate the transaction and shows only that it failed, with no
 * indication of which precondition was missed. This prints them.
 *
 *   node apps/worker/scripts/room-onchain-state.mjs
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { findRoomPda, findRoomVaultPda, roomIdFromUuid } from '@arena/solana';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const GATEWAY = process.env.GATEWAY_URL ?? 'https://gateway-production-8a28.up.railway.app';
const MATCHMAKER =
  process.env.MATCHMAKER_URL ?? 'https://matchmaker-production-7572.up.railway.app';
const PROGRAM_ID = new PublicKey(process.env.ARENA_PROGRAM_ID);
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

const STATUS = ['Open', 'Started', 'Settled', 'Cancelled'];

async function call(base, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const kp = Keypair.generate();
const wallet = kp.publicKey.toBase58();
const { nonce, message } = await call(GATEWAY, '/v1/auth/nonce', {
  method: 'POST',
  body: { wallet },
});
const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
const verified = await call(GATEWAY, '/v1/auth/verify', {
  method: 'POST',
  body: { wallet, signature, nonce },
});
const token = verified.tokens?.accessToken ?? verified.accessToken;

const { lobbies } = await call(MATCHMAKER, '/v1/lobbies', { token });

for (const lobby of lobbies) {
  if (BigInt(lobby.entryFeeLamports) === 0n) continue;

  const label = lobby.tierId.padEnd(9);
  if (!lobby.gameId) {
    console.log(`${label} no gameId bound — nothing to pay into`);
    continue;
  }

  const roomId = roomIdFromUuid(lobby.gameId);
  const [roomPda] = findRoomPda(PROGRAM_ID, roomId);
  const [vaultPda] = findRoomVaultPda(PROGRAM_ID, roomId);
  const info = await connection.getAccountInfo(roomPda);

  if (!info) {
    console.log(
      `${label} game ${lobby.gameId.slice(0, 8)}…  ROOM DOES NOT EXIST on chain — enter_room cannot simulate`,
    );
    continue;
  }

  // Anchor: 8-byte discriminator, then the struct in declaration order.
  const d = info.data;
  let o = 8 + 16 + 32; // room_id + creator
  const status = d[o];
  o += 1;
  const entryFee = d.readBigUInt64LE(o);
  o += 8;
  const maxPlayers = d.readUInt16LE(o);
  o += 2;
  const playerCount = d.readUInt16LE(o);
  o += 2;
  const lockedCount = d.readUInt16LE(o);
  o += 2;
  const totalLocked = d.readBigUInt64LE(o);

  const vaultBalance = await connection.getBalance(vaultPda);
  const openable = STATUS[status] === 'Open' && playerCount < maxPlayers;

  console.log(
    `${label} game ${lobby.gameId.slice(0, 8)}…  status=${STATUS[status] ?? status}  fee=${entryFee}  players=${playerCount}/${maxPlayers}  locked=${lockedCount}  vault=${vaultBalance}  ${openable ? 'ENTERABLE' : 'BLOCKED'}`,
  );
}
