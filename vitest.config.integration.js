/**
 * ⚙️ Configuração do Vitest para Testes de Integração
 * 
 * Executar: npx vitest run --config vitest.config.integration.js
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'integration-agenda-externa',
    root: './tests/integration',
    
    // Ambiente
    environment: 'node',
    globals: true,
    
    // Setup
    setupFiles: ['./agenda-externa.setup.js'],
    
    // Padrões de arquivo
    include: [
      '**/*.test.js',
      '**/*.spec.js'
    ],
    exclude: [
      'node_modules',
      'dist',
      '**/*.setup.js'
    ],
    
    // Timeout
    testTimeout: 30000, // 30 segundos para testes de integração
    hookTimeout: 30000,
    
    // Retry em caso de falha (útil para testes de concorrência)
    retry: 1,
    
    // Relatório
    reporter: ['verbose', 'json', 'html'],
    outputFile: {
      json: './coverage/integration-test-results.json',
      html: './coverage/integration-test-report.html'
    },
    
    // Cobertura
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage/integration',
      include: [
        'routes/importFromAgenda.js',
        'routes/preAgendamento.js',
        'routes/appointment.js',
        'utils/appointmentMapper.js',
        'middleware/agendaAuth.js',
        'middleware/amandaAuth.js'
      ],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.test.js'
      ]
    },
    
    // Logs
    silent: false,
    printConsoleTrace: true,
    
    // Mocking
    mockReset: true,
    restoreMocks: true,
    clearMocks: true,
    
    // Workers (paralelismo)
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true, // MongoMemoryServer funciona melhor em single thread
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
