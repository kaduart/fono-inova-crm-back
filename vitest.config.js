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
