import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@arena/db',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // PGlite boots a WASM Postgres and replays every migration before the first
    // assertion. That is a few hundred milliseconds of real work, and the
    // default 5s timeout trips on a cold cache.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One PGlite instance per file, so a file's fixtures cannot leak into
    // another's assertions. Threads would each pay the boot cost anyway.
    fileParallelism: false,
  },
});
