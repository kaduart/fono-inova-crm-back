/**
 * Configuração do Vitest para testes E2E e Amanda
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/e2e/**/*.test.js',
      'tests/amanda/**/*.test.js',
      'tests/packs/**/*.pack.js',  // 🆕 Novos test packs para bugs corrigidos
    ],
    setupFiles: [],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    conditions: ['import'],
  },
});
