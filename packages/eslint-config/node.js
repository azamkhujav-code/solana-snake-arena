import globals from 'globals';

import { baseConfig } from './base.js';

/**
 * Config for the Fastify services (gateway, realtime, matchmaker) and any
 * Node-only package.
 *
 * @type {import('eslint').Linter.Config[]}
 */
export const nodeConfig = [
  ...baseConfig,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      // Services log through Pino, never stdout directly.
      'no-console': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
      'no-process-exit': 'off',
    },
  },
  {
    // Entrypoints, CLI scripts and seeds write to stdout by design — they run
    // outside the request path where the Pino pipeline applies.
    files: [
      '**/src/index.ts',
      '**/src/server.ts',
      '**/scripts/**/*.ts',
      '**/prisma/seed.ts',
      '**/*.config.ts',
    ],
    rules: { 'no-console': 'off' },
  },
];

export default nodeConfig;
