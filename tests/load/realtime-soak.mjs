#!/usr/bin/env node
/**
 * Realtime soak: many concurrent sockets against one node.
 *
 *   node tests/load/realtime-soak.mjs --url ws://localhost:4001 --clients 200
 *
 * k6 does not speak Socket.IO, so this uses the real client library. It needs a
 * running realtime node and a way to mint tickets, which is why it lives here
 * rather than in the test suite — CI has neither.
 *
 * What it measures is the thing that decides node sizing: whether snapshot
 * delivery stays on schedule as socket count climbs. A node that is CPU-bound
 * does not error, it just falls behind, and every player experiences that as
 * rubber-banding rather than as a failure anyone gets paged for.
 */
import { createHmac } from 'node:crypto';
import { parseArgs } from 'node:util';
import { io } from 'socket.io-client';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:4001' },
    clients: { type: 'string', default: '100' },
    seconds: { type: 'string', default: '60' },
    secret: { type: 'string', default: process.env.JWT_SECRET ?? '' },
    node: { type: 'string', default: 'realtime-local-1' },
    room: { type: 'string', default: 'soak-room' },
  },
});

const CLIENTS = Number.parseInt(values.clients, 10);
const SECONDS = Number.parseInt(values.seconds, 10);

if (!values.secret) {
  console.error('Set --secret or JWT_SECRET: tickets are HMAC-signed and the node verifies them.');
  process.exit(1);
}

/** Mirrors the matchmaker's ticket format. */
function mintTicket(claims) {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', values.secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

const stats = {
  connected: 0,
  rejected: 0,
  snapshots: 0,
  disconnects: 0,
  /** Gaps between consecutive snapshots, in ms. */
  gaps: [],
};

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function spawnClient(index) {
  const playerId = `soak-${index}`;
  const issuedAt = Date.now();

  const ticket = mintTicket({
    playerId,
    wallet: `wallet-${playerId}`,
    roomId: values.room,
    nodeId: values.node,
    nickname: playerId.slice(0, 16),
    issuedAt,
    expiresAt: issuedAt + 30_000,
  });

  // NOTE: the node consumes the ticket from Redis, so a real soak needs each
  // ticket registered there first — run the matchmaker, or pre-seed the keys.
  const socket = io(values.url, {
    path: '/ws',
    transports: ['websocket'],
    auth: { ticket },
    reconnection: false,
  });

  let lastSnapshot = 0;

  socket.on('connect', () => {
    stats.connected += 1;
  });
  socket.on('connect_error', () => {
    stats.rejected += 1;
  });
  socket.on('disconnect', () => {
    stats.disconnects += 1;
  });

  // The event that actually matters: if these stop arriving on schedule the
  // node is behind, whatever the CPU graph says.
  socket.on('S', () => {
    stats.snapshots += 1;
    const now = performance.now();
    if (lastSnapshot > 0) stats.gaps.push(now - lastSnapshot);
    lastSnapshot = now;
  });

  // Steer continuously — an idle socket costs far less than a playing one, and
  // measuring idle sockets would flatter the result.
  let seq = 0;
  const inputTimer = setInterval(() => {
    if (!socket.connected) return;
    seq += 1;
    socket.emit('i', {
      clientTime: Date.now(),
      commands: [{ seq, angle: (seq * 0.1) % 6.28, boost: seq % 5 === 0, dt: 33 }],
    });
  }, 50);

  return () => {
    clearInterval(inputTimer);
    socket.disconnect();
  };
}

console.log(`Connecting ${CLIENTS} clients to ${values.url} for ${SECONDS}s...`);

const teardowns = [];
for (let i = 0; i < CLIENTS; i += 1) {
  teardowns.push(await spawnClient(i));
  // Staggered: the node's connection guard throttles bursts from one address,
  // and tripping it would measure the limiter rather than the simulation.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

await new Promise((resolve) => setTimeout(resolve, SECONDS * 1_000));
for (const teardown of teardowns) teardown();

const expectedGapMs = 1_000 / 15;

console.log(
  JSON.stringify(
    {
      clients: CLIENTS,
      connected: stats.connected,
      rejected: stats.rejected,
      disconnects: stats.disconnects,
      snapshots: stats.snapshots,
      snapshot_gap_ms: {
        expected: Number(expectedGapMs.toFixed(1)),
        p50: Number(percentile(stats.gaps, 50).toFixed(1)),
        p95: Number(percentile(stats.gaps, 95).toFixed(1)),
        // The number to watch. A p99 far above expected means the node is
        // falling behind under load, which players feel as rubber-banding.
        p99: Number(percentile(stats.gaps, 99).toFixed(1)),
      },
    },
    null,
    2,
  ),
);

process.exit(0);
