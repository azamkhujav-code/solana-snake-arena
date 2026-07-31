import { defineConfig } from 'vitest/config';

/**
 * Root test config. Each workspace package is a project so they can differ in
 * environment (node vs jsdom) while still running from a single command.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'services',
          include: ['apps/{gateway,realtime,matchmaker}/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          // Documentation accuracy. Lives at the root because it reads across
          // every workspace — docs make claims about apps, packages, the Prisma
          // schema and the Rust program all at once.
          name: 'docs',
          include: ['scripts/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'node',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['**/dist/**', '**/.next/**', '**/*.config.*', '**/generated/**'],
    },
  },
});
