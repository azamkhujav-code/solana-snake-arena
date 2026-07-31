import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@arena/game-core',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
