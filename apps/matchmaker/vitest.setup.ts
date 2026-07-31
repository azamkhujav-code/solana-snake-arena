/**
 * See the note in the gateway's setup file: config is validated at module
 * scope, so anything importing a module that reads it needs these present.
 * Fake values — no test here opens a connection.
 */
const TEST_ENV: Record<string, string> = {
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_SECRET: 'test-secret-not-used-to-sign-anything-real-0123456789',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  process.env[key] ??= value;
}
