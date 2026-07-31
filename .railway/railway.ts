import { defineRailway, github, postgres, preserve, project, redis, service } from 'railway/iac';

/**
 * Railway topology for Slither Arena.
 *
 * Every service builds from the repo root so `turbo prune` can see the whole
 * workspace; they differ only in RAILWAY_DOCKERFILE_PATH and the PACKAGE /
 * APP_DIR build args the shared Dockerfile takes.
 *
 * Secrets (JWT_SECRET, SETTLEMENT_AUTHORITY_SECRET) are declared as preserve()
 * so their values live in Railway rather than in this file.
 */

const REPO = 'azamkhujav-code/solana-snake-arena';
const BRANCH = 'main';
const NODE_DOCKERFILE = 'infra/docker/node-service.Dockerfile';
const WEB_DOCKERFILE = 'infra/docker/web.Dockerfile';

// Ports are pinned rather than left to Railway's injected PORT so the
// *.railway.internal URLs below are deterministic.
const GATEWAY_PORT = 4000;
const REALTIME_PORT = 4001;
const MATCHMAKER_PORT = 4002;
const WEB_PORT = 3000;

const SOLANA = {
  SOLANA_CLUSTER: 'devnet',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  SOLANA_COMMITMENT: 'confirmed',
  ARENA_PROGRAM_ID: '4y2eaLGzqmfFrMTAhVzruQ4BeuHsBZCdAR52FBFkJ9hc',
};

export default defineRailway(() => {
  const db = postgres('postgres');
  const cache = redis('redis');

  const base = {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    LOG_PRETTY: 'false',
    // Fastify defaults to 0.0.0.0, which is IPv4-only and therefore unreachable
    // over Railway's IPv6 private network. '::' accepts both.
    HOST: '::',
  };

  const gateway = service('gateway', {
    source: github(REPO, { branch: BRANCH }),
    healthcheck: '/health/live',
    env: {
      ...base,
      ...SOLANA,
      RAILWAY_DOCKERFILE_PATH: NODE_DOCKERFILE,
      PACKAGE: '@arena/gateway',
      APP_DIR: 'gateway',
      SERVICE_NAME: 'gateway',
      PORT: String(GATEWAY_PORT),
      DATABASE_URL: db.env.DATABASE_URL,
      DIRECT_DATABASE_URL: db.env.DATABASE_URL,
      REDIS_URL: cache.env.REDIS_URL,
      MATCHMAKER_INTERNAL_URL: `http://matchmaker.railway.internal:${MATCHMAKER_PORT}`,
      CORS_ORIGINS: 'https://${{web.RAILWAY_PUBLIC_DOMAIN}}',
      AUTH_DOMAIN: '${{web.RAILWAY_PUBLIC_DOMAIN}}',
      JWT_SECRET: preserve(),
    },
  });

  const matchmaker = service('matchmaker', {
    source: github(REPO, { branch: BRANCH }),
    healthcheck: '/health/live',
    env: {
      ...base,
      RAILWAY_DOCKERFILE_PATH: NODE_DOCKERFILE,
      PACKAGE: '@arena/matchmaker',
      APP_DIR: 'matchmaker',
      SERVICE_NAME: 'matchmaker',
      PORT: String(MATCHMAKER_PORT),
      REDIS_URL: cache.env.REDIS_URL,
      GATEWAY_INTERNAL_URL: `http://gateway.railway.internal:${GATEWAY_PORT}`,
      CORS_ORIGINS: 'https://${{web.RAILWAY_PUBLIC_DOMAIN}}',
      AUTH_DOMAIN: '${{web.RAILWAY_PUBLIC_DOMAIN}}',
      JWT_SECRET: preserve(),
    },
  });

  // Stateful: each instance owns a disjoint set of rooms and clients connect to
  // it directly by ADVERTISE_URL, so this stays at one replica. Scaling it out
  // needs per-node addressing, not a second copy behind the same domain.
  const realtime = service('realtime', {
    source: github(REPO, { branch: BRANCH }),
    healthcheck: '/health/live',
    replicas: 1,
    env: {
      ...base,
      RAILWAY_DOCKERFILE_PATH: NODE_DOCKERFILE,
      PACKAGE: '@arena/realtime',
      APP_DIR: 'realtime',
      SERVICE_NAME: 'realtime',
      PORT: String(REALTIME_PORT),
      REDIS_URL: cache.env.REDIS_URL,
      NODE_ID: 'realtime-railway-1',
      ADVERTISE_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      CORS_ORIGINS: 'https://${{web.RAILWAY_PUBLIC_DOMAIN}}',
      AUTH_DOMAIN: '${{web.RAILWAY_PUBLIC_DOMAIN}}',
      JWT_SECRET: preserve(),
    },
  });

  const worker = service('worker', {
    source: github(REPO, { branch: BRANCH }),
    env: {
      ...base,
      ...SOLANA,
      RAILWAY_DOCKERFILE_PATH: NODE_DOCKERFILE,
      PACKAGE: '@arena/worker',
      APP_DIR: 'worker',
      SERVICE_NAME: 'worker',
      DATABASE_URL: db.env.DATABASE_URL,
      DIRECT_DATABASE_URL: db.env.DATABASE_URL,
      REDIS_URL: cache.env.REDIS_URL,
      WORKER_SCHEDULER_ENABLED: 'true',
      SETTLEMENT_AUTHORITY_SECRET: preserve(),
    },
  });

  // NEXT_PUBLIC_* are inlined by `next build`, so these are consumed as build
  // args (the Dockerfile declares a matching ARG for each) rather than read at
  // container start.
  const web = service('web', {
    source: github(REPO, { branch: BRANCH }),
    env: {
      NODE_ENV: 'production',
      RAILWAY_DOCKERFILE_PATH: WEB_DOCKERFILE,
      PORT: String(WEB_PORT),
      NEXT_PUBLIC_APP_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      NEXT_PUBLIC_GATEWAY_URL: 'https://${{gateway.RAILWAY_PUBLIC_DOMAIN}}',
      NEXT_PUBLIC_MATCHMAKER_URL: 'https://${{matchmaker.RAILWAY_PUBLIC_DOMAIN}}',
      NEXT_PUBLIC_SOLANA_CLUSTER: SOLANA.SOLANA_CLUSTER,
      NEXT_PUBLIC_SOLANA_RPC_URL: SOLANA.SOLANA_RPC_URL,
      NEXT_PUBLIC_ARENA_PROGRAM_ID: SOLANA.ARENA_PROGRAM_ID,
    },
  });

  return project('slither-arena', {
    resources: [db, cache, gateway, matchmaker, realtime, worker, web],
  });
});
