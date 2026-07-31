/**
 * Checks that leaving a room actually releases the seat held for you.
 *
 * A launch stages a ticket per entrant with a sixty-second life, and the room
 * board reports it as `pendingMatch` — which is what the client follows into
 * the arena. Leaving used to release the queue slot and not the staged ticket,
 * so the board went on announcing a match the player had just quit and walked
 * them straight back into it. Pressing Leave repeatedly did eventually work,
 * once the ticket expired on its own.
 *
 *   node apps/matchmaker/scripts/leave-clears-seat.mjs [tierId]
 */
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const GATEWAY = process.env.GATEWAY_URL ?? 'https://gateway-production-8a28.up.railway.app';
const MATCHMAKER =
  process.env.MATCHMAKER_URL ?? 'https://matchmaker-production-7572.up.railway.app';
const TIER = process.argv[2] ?? 'practice';

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
  return text ? JSON.parse(text) : null;
}

async function signIn() {
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
  return verified.tokens?.accessToken ?? verified.accessToken;
}

const token = await signIn();
await call(MATCHMAKER, '/v1/lobbies/join', {
  method: 'POST',
  body: { tierId: TIER, nickname: 'leaver' },
  token,
});
console.log(`joined ${TIER}`);

// Wait for the launch to stage a seat for this player.
let staged = null;
for (let i = 0; i < 40 && !staged; i += 1) {
  const list = await call(MATCHMAKER, '/v1/lobbies', { token });
  staged = list.pendingMatch;
  if (!staged) await new Promise((r) => setTimeout(r, 1_000));
}

if (!staged) {
  console.log('no seat was ever staged — nothing to test');
  process.exit(1);
}
console.log(`seat staged for game ${staged.gameId.slice(0, 8)}…`);

await call(MATCHMAKER, '/v1/lobbies/leave', { method: 'POST', body: { tierId: TIER }, token });
console.log('left the room');

const after = await call(MATCHMAKER, '/v1/lobbies', { token });
console.log(
  `pendingMatch after leaving: ${after.pendingMatch ? after.pendingMatch.gameId : 'null'}`,
);

if (after.pendingMatch) {
  console.error(
    '\nFAIL: the seat is still held, so the client would rejoin the match it just quit.',
  );
  process.exit(1);
}
console.log('\nPASS: leaving released the seat; nothing pulls the player back in.');
