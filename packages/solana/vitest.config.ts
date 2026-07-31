import { defineConfig } from 'vitest/config';

/**
 * Package-local config.
 *
 * Without this, running `vitest` from the package directory walks up to the
 * root config, whose globs are root-relative and therefore match nothing here.
 */
export default defineConfig({
  test: {
    name: '@arena/solana',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
