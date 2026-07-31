import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: '@arena/web',
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
