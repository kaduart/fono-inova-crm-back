import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    retry: 2,
    include: ['tests/integration/package-types-e2e.test.js'],
    pool: 'threads',
    poolOptions: {
      threads: { singleThread: true, maxThreads: 1 }
    }
  },
  resolve: {
    conditions: ['import']
  }
});
