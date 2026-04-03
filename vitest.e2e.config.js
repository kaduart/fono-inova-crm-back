import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/package-types-e2e.test.js'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
  resolve: {
    conditions: ['import'],
  },
});
