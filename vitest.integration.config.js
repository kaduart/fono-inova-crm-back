/**
 * Configuração do Vitest para Testes de Integração
 *
 * Uso:
 *   npx vitest run --config vitest.integration.config.js --reporter=verbose
 *   npx vitest run --config vitest.integration.config.js tests/integration/appointment-create-event-driven.test.js
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.js'],
    exclude: ['**/node_modules/**'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
  resolve: {
    conditions: ['import'],
  },
});
