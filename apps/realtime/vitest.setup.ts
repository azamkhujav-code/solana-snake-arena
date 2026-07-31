/**
 * Config is validated at import time, so anything importing a module that
 * reads it needs these present. See the gateway's equivalent.
 *
 * Deliberately fake: no test opens a Redis connection. The multiplayer harness
 * substitutes Redis entirely and binds its own ephemeral port.
 */
const TEST_ENV: Record<string, string> = {
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_SECRET: 'test-secret-not-used-to-sign-anything-real-0123456789',
  NODE_ID: 'realtime-test-1',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  // Never overwrite: a developer pointing the suite at a real local stack
  // should not have it silently swapped out.
  process.env[key] ??= value;
}
