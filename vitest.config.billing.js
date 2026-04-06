import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals:     true,
    environment: 'node',
    include:     ['tests/billing/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    conditions: ['import'],
  },
});
