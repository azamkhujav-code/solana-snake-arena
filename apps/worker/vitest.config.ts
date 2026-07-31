import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@arena/worker',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
