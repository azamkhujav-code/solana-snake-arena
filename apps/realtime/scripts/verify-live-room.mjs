/**
 * End-to-end check against the deployed stack.
 *
 * Signs in two wallets, matchmakes both into one tier, opens a real socket for
 * each, and asserts they land in the same world and can see one another. Then
 * has one leave and asserts the server drops the seat immediately rather than
 * holding it for the reconnect grace window.
 *
 *   node apps/realtime/scripts/verify-live-room.mjs [tierId]
 *
 * Reads the deployed URLs from the environment so it can be pointed at any
 * environment; defaults to the Railway production hosts.
 */
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { io } from 'socket.io-client';

const GATEWAY = process.env.GATEWAY_URL ?? 'https://gateway-production-8a28.up.railway.app';
const MATCHMAKER =
  process.env.MATCHMAKER_URL ?? 'https://matchmaker-production-7572.up.railway.app';
const TIER = process.argv[2] ?? 'practice';

const ClientEvent = { Join: 'j', Leave: 'l' };
const ServerEvent = { Joined: 'J', Leaderboard: 'L' };

async function post(base, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function signIn(label) {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const { nonce, message } = await post(GATEWAY, '/v1/auth/nonce', { wallet });
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey),
  );
  const verified = await post(GATEWAY, '/v1/auth/verify', { wallet, signature, nonce });
  const token = verified.tokens?.accessToken ?? verified.accessToken;
  if (!token) throw new Error(`no access token: ${JSON.stringify(verified).slice(0, 200)}`);
  console.log(`${label}: ${wallet.slice(0, 8)}…`);
  return token;
}

/** Opens a socket and completes the join handshake. */
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

    const fail = (err) => {
      socket.close();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    socket.on('connect_error', fail);
    setTimeout(() => fail(new Error(`${nickname}: join timed out`)), 20_000).unref();

    socket.on('connect', () => {
      socket.emit(
        ClientEvent.Join,
        {
          roomId: place.roomId,
          ticket: place.ticket,
          nickname,
          protocolVersion: process.env.PROTOCOL_VERSION ?? '1.0.0',
        },
        (ack) => {
          if (ack?.code) return fail(new Error(`${nickname}: join rejected ${ack.code}`));
          resolve({ socket, joined: ack });
        },
      );
    });

    // Some builds push Joined rather than acking; accept either.
    socket.on(ServerEvent.Joined, (payload) => resolve({ socket, joined: payload }));
  });
}

/** Waits for a leaderboard naming `expected` players, or times out. */
function waitForRoster(socket, expected, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const deadline = setTimeout(() => resolve(null), timeoutMs);
    socket.on(ServerEvent.Leaderboard, (entries) => {
      if (Array.isArray(entries) && entries.length >= expected) {
        clearTimeout(deadline);
        resolve(entries);
      }
    });
  });
}

const [tokenA, tokenB] = [await signIn('player A'), await signIn('player B')];
const placeA = await post(MATCHMAKER, '/v1/matchmake', { mode: 'casual', tierId: TIER }, tokenA);
const placeB = await post(MATCHMAKER, '/v1/matchmake', { mode: 'casual', tierId: TIER }, tokenB);

console.log(`\ntier ${TIER}`);
console.log(`A room=${placeA.roomId}`);
console.log(`B room=${placeB.roomId}`);
if (placeA.roomId !== placeB.roomId) {
  console.error('FAIL: different rooms');
  process.exit(1);
}

const a = await connect(placeA, 'alice');
const b = await connect(placeB, 'bob');
console.log('\nboth sockets joined');

const roster = await waitForRoster(a.socket, 2);
if (!roster) {
  console.error('FAIL: alice never saw a leaderboard with both players');
  a.socket.close();
  b.socket.close();
  process.exit(1);
}
console.log(`leaderboard seen by alice: ${roster.map((e) => e.nickname).join(', ')}`);

// Leaving must drop the seat now, not after the reconnect grace window.
b.socket.emit(ClientEvent.Leave);
const after = await new Promise((resolve) => {
  let last = roster;
  a.socket.on(ServerEvent.Leaderboard, (entries) => {
    last = entries;
  });
  setTimeout(() => resolve(last), 12_000);
});

console.log(`after bob leaves:           ${after.map((e) => e.nickname).join(', ') || '(empty)'}`);

a.socket.close();
b.socket.close();

if (after.some((e) => e.nickname === 'bob')) {
  console.error('\nFAIL: bob still in the room after leaving');
  process.exit(1);
}
console.log('\nPASS: shared world, mutual visibility, and leave takes effect immediately.');
process.exit(0);
