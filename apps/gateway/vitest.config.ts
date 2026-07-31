import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@arena/gateway',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // setupFiles run before the module graph is imported, which is the only
    // window in which env can be seeded — config.ts validates at module scope.
    setupFiles: ['./vitest.setup.ts'],
  },
});
