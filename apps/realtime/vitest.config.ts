import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@arena/realtime',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Runs before the module graph imports config.ts, which validates at
    // module scope.
    setupFiles: ['./vitest.setup.ts'],
    // The multiplayer suite binds real sockets and waits on real timers.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
