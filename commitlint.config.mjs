/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'web',
        'gateway',
        'realtime',
        'matchmaker',
        'protocol',
        'game-core',
        'db',
        'env',
        'logger',
        'redis',
        'solana',
        'ui',
        'programs',
        'infra',
        'ci',
        'deps',
        'docs',
        'repo',
      ],
    ],
    'body-max-line-length': [1, 'always', 120],
  },
};
