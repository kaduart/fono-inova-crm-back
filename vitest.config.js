/**
 * Configuração do Vitest para Backend
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        'scripts/',
        '**/*.config.*',
      ],
    },
    include: ['tests/unit/**/*.test.js'],
    exclude: [
      '**/node_modules/**',
      // Scripts que usam process.exit() — não são testes vitest
      'tests/unit/therapyDetector.test.js',
      'tests/unit/safeAgeUpdate.test.js',
      'tests/unit/flagsDetector.p1-p4.test.js',
      // Precisa de MongoDB rodando — só roda em ambiente de integração
      'tests/unit/taxaCartao.test.js',
    ],
    setupFiles: [],
    // Timeout para testes com MongoDB
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    // Suporte a ES modules
    conditions: ['import'],
  },
});
