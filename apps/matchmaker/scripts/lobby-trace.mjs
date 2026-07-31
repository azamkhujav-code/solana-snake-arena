/**
 * Reproduces what a player sees after pressing Join.
 *
 * Signs in N wallets, joins them all to a tier, then polls the lobby and prints
 * every state change until it launches or the deadline passes. Answers "I
 * joined and nothing happened" with the actual state machine transitions rather
 * than a guess.
 *
 *   node apps/matchmaker/scripts/lobby-trace.mjs [tierId] [players] [seconds]
 */
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const GATEWAY = process.env.GATEWAY_URL ?? 'https://gateway-production-8a28.up.railway.app';
const MATCHMAKER =
  process.env.MATCHMAKER_URL ?? 'https://matchmaker-production-7572.up.railway.app';

const TIER = process.argv[2] ?? 'practice';
const COUNT = Number(process.argv[3] ?? 1);
const SECONDS = Number(process.argv[4] ?? 90);

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
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function signIn(label) {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const { nonce, message } = await call(GATEWAY, '/v1/auth/nonce', {
    method: 'POST',
    body: { wallet },
  });
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey),
  );
  const verified = await call(GATEWAY, '/v1/auth/verify', {
    method: 'POST',
    body: { wallet, signature, nonce },
  });
  const token = verified.tokens?.accessToken ?? verified.accessToken;
  console.log(`${label}: ${wallet.slice(0, 8)}…`);
  return { token, wallet };
}

const players = [];
for (let i = 0; i < COUNT; i += 1) players.push(await signIn(`player ${i + 1}`));

for (const [i, p] of players.entries()) {
  try {
    const res = await call(MATCHMAKER, '/v1/lobbies/join', {
      method: 'POST',
      body: { tierId: TIER, nickname: `probe${i + 1}` },
      token: p.token,
    });
    console.log(
      `player ${i + 1} joined: status=${res.lobby?.status} players=${res.lobby?.playerCount}`,
    );
  } catch (err) {
    console.log(`player ${i + 1} join REFUSED: ${err.message}`);
  }
}

console.log(`\npolling ${TIER} for ${SECONDS}s…`);
const started = Date.now();
let previous = '';

while (Date.now() - started < SECONDS * 1_000) {
  const list = await call(MATCHMAKER, '/v1/lobbies', { token: players[0].token });
  const lobby = (list.lobbies ?? list).find?.((l) => l.tierId === TIER) ?? null;
  const pending = list.pendingMatch ?? null;

  if (lobby) {
    const line = `status=${lobby.status} players=${lobby.playerCount} countdown=${lobby.secondsRemaining ?? lobby.startsInMs ?? '-'} gameId=${(lobby.gameId ?? 'null').slice(0, 8)} pendingMatch=${pending ? pending.gameId.slice(0, 8) : 'null'}`;
    if (line !== previous) {
      console.log(`  [+${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${line}`);
      previous = line;
    }
    if (lobby.status === 'launching' || pending) {
      console.log(
        `\nLAUNCH DETECTED via ${pending ? 'pendingMatch' : 'status'} — claiming ticket…`,
      );
      const place = await call(MATCHMAKER, '/v1/matchmake', {
        method: 'POST',
        body: { mode: 'casual', tierId: TIER },
        token: players[0].token,
      });
      console.log(`  room=${place.roomId} node=${place.realtimeUrl}`);
      process.exit(0);
    }
  }
  await new Promise((r) => setTimeout(r, 2_000));
}

console.log('\nDID NOT LAUNCH within the window.');
process.exit(1);
