import { baseConfig } from '@arena/eslint-config/base';

/**
 * Root config. Each app/package ships its own eslint.config.mjs; this one only
 * covers loose files at the repo root (scripts, config files).
 *
 * @type {import('eslint').Linter.Config[]}
 */
export default [
  ...baseConfig,
  {
    ignores: ['apps/**', 'packages/**', 'programs/**', 'infra/**'],
  },
];
