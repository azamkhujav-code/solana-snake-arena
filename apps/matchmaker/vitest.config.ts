import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@arena/matchmaker',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Runs before the module graph imports config.ts, which validates env at
    // module scope.
    setupFiles: ['./vitest.setup.ts'],
  },
});
