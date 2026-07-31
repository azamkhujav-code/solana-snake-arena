import { FlatCompat } from '@eslint/eslintrc';
import tseslint from 'typescript-eslint';

import { TS_FILES } from './base.js';
import { reactConfig } from './react.js';

// eslint-config-next is still authored as an eslintrc-style config, so it is
// bridged into flat config rather than spread directly.
const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

/**
 * Config for the Next.js 15 App Router app.
 *
 * @type {import('eslint').Linter.Config[]}
 */
export const nextConfig = [
  ...reactConfig,
  ...compat.extends('next/core-web-vitals'),
  {
    // next/core-web-vitals installs its own parser for TypeScript, which does
    // not expose the services that typescript-eslint rules need. Restoring the
    // parser here — after the compat block — keeps both working.
    files: TS_FILES,
    languageOptions: { parser: tseslint.parser },
  },
  {
    rules: {
      // PixiJS renders into a canvas, so next/image has nothing to optimise for
      // in-game textures. Still enforced for regular UI imagery via review.
      '@next/next/no-img-element': 'warn',
    },
  },
  {
    ignores: ['.next/**', 'next-env.d.ts'],
  },
];

export default nextConfig;
