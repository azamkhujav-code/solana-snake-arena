import { nodeConfig } from '@arena/eslint-config/node';

export default [
  ...nodeConfig,
  {
    /**
     * Operator scripts, not service code.
     *
     * Two of the service rules are actively wrong here. `no-console` exists so
     * that running code logs through the structured logger and stays greppable
     * in production; a CLI whose whole job is printing a report to a human has
     * no such obligation. `turbo/no-undeclared-env-vars` exists so a build input
     * cannot change without invalidating the cache; these scripts are never a
     * build input and are run by hand against a live stack.
     */
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      'turbo/no-undeclared-env-vars': 'off',
    },
  },
];
