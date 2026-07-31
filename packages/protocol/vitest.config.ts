import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@arena/protocol',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
