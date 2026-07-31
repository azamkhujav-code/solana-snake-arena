#!/usr/bin/env node
/**
 * End-to-end smoke test against a running local stack.
 *
 *   node scripts/smoke.mjs
 *
 * Drives the real HTTP surface with a real ed25519 keypair: request a nonce,
 * sign it, exchange it for tokens, then use those tokens on authenticated
 * endpoints. Nothing is stubbed.
 *
 * Distinct from the test suite, which substitutes Postgres and Redis. This
 * needs the actual stack up and answers a different question: does the thing
 * work when it is genuinely running?
 */
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:4200';
const MATCHMAKER = process.env.MATCHMAKER_URL ?? 'http://127.0.0.1:4202';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n          ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON responses are reported as raw text */
  }

  return { status: response.status, json, text, headers: response.headers };
}

console.log('\nHealth\n');

await check('gateway ready', async () => {
  const { status, json } = await request(GATEWAY, '/health/ready');
  assert(status === 200, `status ${status}`);
  assert(json.checks.database === 'ok', 'database not ok');
  assert(json.checks.redis === 'ok', 'redis not ok');
  return 'database + redis ok';
});

await check('matchmaker ready', async () => {
  const { status } = await request(MATCHMAKER, '/health/ready');
  assert(status === 200, `status ${status}`);
});

console.log('\nPublic API\n');

await check('lists the seven seeded rooms', async () => {
  const { status, json } = await request(GATEWAY, '/v1/rooms');
  assert(status === 200, `status ${status}`);
  assert(json.rooms.length === 7, `got ${json.rooms.length} rooms`);

  // The contract that stops a client corrupting balances above 2^53.
  const fee = json.rooms[0].entryFeeLamports;
  assert(typeof fee === 'string', `entryFeeLamports is ${typeof fee}, expected string`);

  return json.rooms.map((r) => r.code).join(', ');
});

await check('rooms are ordered by entry fee', async () => {
  const { json } = await request(GATEWAY, '/v1/rooms');
  const fees = json.rooms.map((r) => BigInt(r.entryFeeLamports));
  for (let i = 1; i < fees.length; i += 1) {
    assert(fees[i] >= fees[i - 1], 'not ascending');
  }
  return `${fees[0]} → ${fees[fees.length - 1]} lamports`;
});

await check('leaderboard responds with a period key', async () => {
  const { status, json } = await request(GATEWAY, '/v1/leaderboard');
  assert(status === 200, `status ${status}`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(json.periodKey), `periodKey ${json.periodKey}`);
  return `window=${json.window} period=${json.periodKey}`;
});

await check('games list paginates with an explicit cursor, never an absent one', async () => {
  // The property is that `nextCursor` is always *present* — a uuid when there is
  // another page, `null` when there is not. `undefined` would serialise away
  // entirely, and a client testing `'nextCursor' in response` would loop.
  //
  // This previously asserted `nextCursor === null` outright, which silently
  // depended on the database being empty. It passed on a fresh checkout and
  // failed the moment anyone had played twenty games — which is not a defect,
  // and not worth being told about.
  const { json } = await request(GATEWAY, '/v1/games');
  assert(Array.isArray(json.games), 'games not an array');
  assert('nextCursor' in json, 'nextCursor was absent, not null');

  const cursor = json.nextCursor;
  assert(
    cursor === null || (typeof cursor === 'string' && cursor.length > 0),
    `nextCursor was ${JSON.stringify(cursor)}`,
  );

  return cursor === null ? 'single page' : 'has a next page';
});

await check('unknown route returns the API error envelope', async () => {
  const { status, json } = await request(GATEWAY, '/v1/does-not-exist');
  assert(status === 404, `status ${status}`);
  assert(json.error.code === 'NOT_FOUND', `code ${json.error?.code}`);
  assert(typeof json.error.requestId === 'string', 'no requestId');
});

await check('malformed uuid is a 400 with field details', async () => {
  const { status, json } = await request(GATEWAY, '/v1/games/not-a-uuid');
  assert(status === 400, `status ${status}`);
  assert(json.error.code === 'VALIDATION_ERROR', `code ${json.error?.code}`);
  assert(Array.isArray(json.error.details), 'details missing — the field list is the point');
});

await check('OpenAPI document is served', async () => {
  const { status, json } = await request(GATEWAY, '/openapi.json');
  assert(status === 200, `status ${status}`);
  const paths = Object.keys(json.paths).length;
  assert(paths > 25, `only ${paths} paths`);
  return `${paths} paths, openapi ${json.openapi}`;
});

console.log('\nAuthentication (real ed25519 signature)\n');

const keypair = nacl.sign.keyPair();
const wallet = bs58.encode(keypair.publicKey);
let accessToken = null;
let refreshToken = null;

await check('issues a nonce and a message to sign', async () => {
  const { status, json } = await request(GATEWAY, '/v1/auth/nonce', {
    method: 'POST',
    body: { wallet },
  });
  assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
  assert(json.message.includes(wallet), 'message does not name the wallet');
  assert(json.message.includes(json.nonce), 'message does not carry the nonce');
  globalThis.__nonce = json;
  return `nonce ${json.nonce.slice(0, 12)}…`;
});

await check('rejects a signature over the wrong message', async () => {
  const forged = nacl.sign.detached(new TextEncoder().encode('something else'), keypair.secretKey);
  const { status } = await request(GATEWAY, '/v1/auth/verify', {
    method: 'POST',
    body: { wallet, signature: bs58.encode(forged), nonce: globalThis.__nonce.nonce },
  });
  assert(status === 401, `status ${status} — a forged signature was accepted`);
});

await check('a failed attempt burns the nonce', async () => {
  // The replay defence: the nonce is consumed before the signature is checked.
  const signature = nacl.sign.detached(
    new TextEncoder().encode(globalThis.__nonce.message),
    keypair.secretKey,
  );
  const { status } = await request(GATEWAY, '/v1/auth/verify', {
    method: 'POST',
    body: { wallet, signature: bs58.encode(signature), nonce: globalThis.__nonce.nonce },
  });
  assert(status === 401, `status ${status} — a spent nonce was reusable`);
});

await check('signs in with a fresh nonce', async () => {
  const nonce = (await request(GATEWAY, '/v1/auth/nonce', { method: 'POST', body: { wallet } }))
    .json;

  const signature = nacl.sign.detached(new TextEncoder().encode(nonce.message), keypair.secretKey);

  const { status, json } = await request(GATEWAY, '/v1/auth/verify', {
    method: 'POST',
    body: { wallet, signature: bs58.encode(signature), nonce: nonce.nonce },
  });

  assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
  assert(json.player.wallet === wallet, 'wrong wallet on the session');
  accessToken = json.tokens.accessToken;
  refreshToken = json.tokens.refreshToken;
  return `player ${json.player.id.slice(0, 8)}… role=${json.player.role}`;
});

await check('the token identifies the caller', async () => {
  const { status, json } = await request(GATEWAY, '/v1/auth/me', { token: accessToken });
  assert(status === 200, `status ${status}`);
  assert(json.wallet === wallet, 'wrong wallet');
  return `role=${json.role}`;
});

await check('rotates the refresh token', async () => {
  const { status, json } = await request(GATEWAY, '/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
  });
  assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
  globalThis.__rotated = json.tokens.refreshToken;
});

await check('reusing a rotated token revokes the family', async () => {
  const { status, json } = await request(GATEWAY, '/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
  });
  assert(status === 401, `status ${status}`);
  assert(json.error.code === 'TOKEN_REUSE_DETECTED', `code ${json.error?.code}`);
});

console.log('\nAuthenticated API\n');

await check('custody balance starts at zero, as strings', async () => {
  const { status, json } = await request(GATEWAY, '/v1/wallet/balance', { token: accessToken });
  assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
  assert(typeof json.balance === 'string', `balance is ${typeof json.balance}`);
  assert(json.balance === '0', `balance ${json.balance}`);
  return `balance=${json.balance} spendable=${json.spendable}`;
});

await check('match history is empty for a new player', async () => {
  const { status, json } = await request(GATEWAY, '/v1/history', { token: accessToken });
  assert(status === 200, `status ${status}`);
  assert(json.matches.length === 0, `got ${json.matches.length}`);
  assert(json.totals.played === 0, 'totals not zeroed');
});

await check('rewards list is empty with a zero unclaimed total', async () => {
  const { status, json } = await request(GATEWAY, '/v1/rewards', { token: accessToken });
  assert(status === 200, `status ${status}`);
  assert(json.unclaimedLamports === '0', `unclaimed ${json.unclaimedLamports}`);
});

await check('a player is refused the admin API with 403, not 401', async () => {
  const { status, json } = await request(GATEWAY, '/v1/admin/stats', { token: accessToken });
  assert(status === 403, `status ${status}`);
  assert(json.error.code === 'FORBIDDEN', `code ${json.error?.code}`);
});

await check('the admin API is refused outright without a token', async () => {
  const { status } = await request(GATEWAY, '/v1/admin/stats');
  assert(status === 401, `status ${status}`);
});

console.log('\nMatchmaking\n');

await check('lobby board lists all seven tiers', async () => {
  const { status, json } = await request(MATCHMAKER, '/v1/lobbies', { token: accessToken });
  assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
  assert(json.lobbies.length === 7, `got ${json.lobbies.length}`);
  return json.lobbies.map((l) => l.tierId).join(', ');
});

await check('regional capacity reflects the running node', async () => {
  const { status, json } = await request(MATCHMAKER, '/v1/servers');
  assert(status === 200, `status ${status}`);
  assert(json.regions.length > 0, 'no regions — is the realtime node registered?');
  return json.regions.map((r) => `${r.region}:${r.nodes} node(s)`).join(', ');
});

await check('placement issues a single-use ticket', async () => {
  const { status, json } = await request(MATCHMAKER, '/v1/matchmake', {
    method: 'POST',
    token: accessToken,
    body: { mode: 'casual' },
  });
  assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
  assert(json.ticket.split('.').length === 2, 'ticket is not payload.signature');
  assert(json.realtimeUrl.startsWith('http'), `realtimeUrl ${json.realtimeUrl}`);
  globalThis.__ticket = json;
  return `room=${json.roomId} node=${json.realtimeUrl}`;
});

await check('joining a lobby queues the player', async () => {
  const { status, json } = await request(MATCHMAKER, '/v1/lobbies/join', {
    method: 'POST',
    token: accessToken,
    body: { tierId: 'practice', nickname: 'smoketest' },
  });
  assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
  return `players=${json.lobby?.playerCount ?? '?'}`;
});

await check('leaving a lobby is idempotent', async () => {
  for (let i = 0; i < 2; i += 1) {
    const { status } = await request(MATCHMAKER, '/v1/lobbies/leave', {
      method: 'POST',
      token: accessToken,
      body: { tierId: 'practice' },
    });
    assert(status === 200, `status ${status} on attempt ${i + 1}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
