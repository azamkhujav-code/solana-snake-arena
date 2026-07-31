import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import turbo from 'eslint-plugin-turbo';
import tseslint from 'typescript-eslint';

/** File globs the TypeScript-specific rules apply to. */
export const TS_FILES = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];

/**
 * Shared flat config for every package in the monorepo.
 *
 * `prettier` must stay last so it can switch off stylistic rules that would
 * otherwise fight the formatter.
 *
 * @type {import('eslint').Linter.Config[]}
 */
export const baseConfig = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/generated/**',
      '**/target/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { turbo },
    rules: {
      // Catches env vars read at runtime but never declared in turbo.json,
      // which is the usual cause of "works locally, broken in CI cache".
      'turbo/no-undeclared-env-vars': 'error',
    },
  },
  {
    // Scoped to TypeScript only. Applying these to .mjs/.js config files makes
    // rules that need parser services crash under eslint-config-next, which
    // installs its own parser for plain JavaScript.
    files: TS_FILES,
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  prettier,
];

export default baseConfig;
