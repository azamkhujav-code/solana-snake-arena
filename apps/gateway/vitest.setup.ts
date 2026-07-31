/**
 * Config is validated at import time — `config.ts` calls `getGatewayEnv()` at
 * module scope so a misconfigured deploy dies at boot rather than on the first
 * request that needs the missing value. That is the right behaviour in
 * production and it means any test importing a module that touches config needs
 * these present.
 *
 * Deliberately fake values: no test here opens a connection. Anything that
 * actually reached one of these hosts would be a test that should have been
 * using a stub.
 */
const TEST_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://arena:arena@127.0.0.1:5432/arena_test',
  DIRECT_DATABASE_URL: 'postgresql://arena:arena@127.0.0.1:5432/arena_test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_SECRET: 'test-secret-not-used-to-sign-anything-real-0123456789',
  SOLANA_RPC_URL: 'http://127.0.0.1:8899',
  ARENA_PROGRAM_ID: 'ArenaPr0gram11111111111111111111111111111111',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  // Never overwrite: a developer pointing the suite at a real local stack
  // should not have it silently swapped out from under them.
  process.env[key] ??= value;
}
