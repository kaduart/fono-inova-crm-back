/**
 * 🧪 Configuração do Vitest para Testes de Correção de Bugs
 * 
 * Testes E2E específicos para garantir que bugs críticos corrigidos
 * não voltem a ocorrer.
 * 
 * Bugs cobertos:
 * 1. Erro de enum no schema (crm inválido)
 * 2. Modal não fechava após criar agendamento
 * 3. Pagamento não era criado (evento errado)
 * 4. Lista de pagamentos vazia/conflituosa
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/packs/**/*.pack.js'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: [],
    testTimeout: 60000,  // 60s para testes E2E
    hookTimeout: 30000,
    
    // Relatório detalhado
    reporter: ['verbose', 'html'],
    outputFile: {
      html: './test-results/bugfixes-e2e-report.html',
    },
    
    // Cobertura (opcional)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage/bugfixes-e2e',
    },
  },
  
  resolve: {
    conditions: ['import'],
  },
});
