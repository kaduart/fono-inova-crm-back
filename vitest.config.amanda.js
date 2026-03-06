/**
 * ⚙️ Configuração do Vitest para Testes da Amanda
 * 
 * Executar: npx vitest run --config vitest.config.amanda.js
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'amanda-tests',
    root: '.',
    
    // Ambiente
    environment: 'node',
    globals: true,
    
    // Padrões de arquivo
    include: [
      'tests/amanda/**/*.test.js',
    ],
    exclude: [
      '**/node_modules/**',
      'dist',
      'tests/amanda/persistencia-dados.test.js',
      'tests/amanda/fluxo-conversa.test.js',
      'tests/amanda/simulador-real.js',
      'tests/amanda/flows.test.js',
      'tests/amanda/p1-p4-fixes.test.js',
      'tests/amanda/p1-p4-integration.test.js',
      'tests/amanda/responseTracking.test.js',
      'tests/amanda/simulacao-conversa.test.js',
    ],
    
    // Timeout
    testTimeout: 60000, // 60 segundos para testes E2E
    hookTimeout: 30000,
    
    // Retry em caso de falha
    retry: 1,
    
    // Relatório
    reporter: ['verbose'],
    
    // Logs
    silent: false,
    printConsoleTrace: true,
    
    // Mocking
    mockReset: true,
    restoreMocks: true,
    clearMocks: true,
    
    // Workers
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
        maxThreads: 1
      }
    }
  },
  
  // Resolução de módulos
  resolve: {
    alias: {
      '@': './',
      '@models': './models',
      '@routes': './routes',
      '@middleware': './middleware',
      '@utils': './utils'
    }
  },
  
  // ES Modules
  esbuild: {
    target: 'node18',
    format: 'esm'
  }
});
