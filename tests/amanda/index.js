// back/tests/amanda/index.js
/**
 * Amanda Test Suite - Entry Point
 * 
 * Exporta todos os utilitários de teste da Amanda.
 * 
 * Usage:
 *   import { AmandaTestClient, contractTest, runAllTests } from './tests/amanda/index.js';
 * 
 *   // Teste simples
 *   const client = new AmandaTestClient();
 *   const result = await client.sendMessage({ message: 'quero agendar' });
 * 
 *   // Rodar todos os testes
 *   await runAllTests();
 */

// Core
export { AmandaTestClient, contractTest } from './AmandaTestClient.js';
export { 
  processMessageSync, 
  createMockLead, 
  simulateConversation 
} from './amandaTestMode.js';

// Testes
export { tests as intentContracts, flowTests, run as runIntentContracts } from './contracts/intentContracts.test.js';

// Runner
export { runSuite, TestResults } from './run-all-amanda-tests.js';

/**
 * Roda todos os testes da Amanda
 * @param {Object} options - Opções de execução
 * @returns {Promise<boolean>} true se todos passaram
 */
export async function runAllTests(options = {}) {
  const { default: runAll } = await import('./run-all-amanda-tests.js');
  return runAll(options);
}

/**
 * Cria cliente de teste configurado
 * @param {Object} config - Configuração do cliente
 * @returns {AmandaTestClient}
 */
export function createTestClient(config = {}) {
  const { AmandaTestClient } = require('./AmandaTestClient.js');
  return new AmandaTestClient({
    mode: 'sync',
    trackEvents: true,
    ...config
  });
}

// Metadados
export const VERSION = '2.0.0';
export const TEST_SUITES = [
  'contracts',
  'unit', 
  'integration',
  'e2e',
  'stress',
  'regression'
];

export default {
  VERSION,
  TEST_SUITES,
  runAllTests,
  createTestClient
};
