import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@arena/lobby',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
