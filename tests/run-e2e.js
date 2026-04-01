#!/usr/bin/env node
// tests/run-e2e.js
// Executor principal de testes E2E
// 
// DETERMINISMO GARANTIDO:
// - Banco de teste isolado (não usa development)
// - Cleanup total antes/depois
// - Timeout controlado
// - Idempotência validada

import 'dotenv/config';
import { TestRunner } from './framework/TestRunner.js';
import { Fixtures } from './framework/Fixtures.js';
import { startAllWorkers, stopAllWorkers } from '../workers/index.js';
import { startRedis } from '../services/redisClient.js';
import { startOutboxWorker as startOutboxPoller } from '../infrastructure/outbox/outboxPattern.js';
import completeToInvoiceScenario from './scenarios/complete-to-invoice.scenario.js';
import idempotencyCheckScenario from './scenarios/idempotency-check.scenario.js';
import cancelFlowScenario from './scenarios/cancel-flow.scenario.js';
import workerFailureRetryScenario from './scenarios/worker-failure-retry.scenario.js';
import concurrencyRaceScenario from './scenarios/concurrency-race.scenario.js';
import stressTestScenario from './scenarios/stress-test.scenario.js';
import duplicateEventScenario from './scenarios/duplicate-event.scenario.js';

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     🧪 FRAMEWORK E2E - CRM EVENT-DRIVEN 4.0            ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  
  const runner = new TestRunner({
    timeout: 10000,
    pollInterval: 200
  });
  
  try {
    // Setup global (conecta ao banco primeiro)
    await runner.beforeAll();
    
    // Inicia Redis (necessário para locks)
    await startRedis();
    console.log('✅ Redis conectado');
    
    // Inicia todos os workers (incluindo outbox processor)
    startAllWorkers();
    console.log('✅ Workers iniciados');
    
    // Inicia poller do outbox (processa eventos pendentes)
    startOutboxPoller(500);
    console.log('✅ Outbox poller iniciado');
    
    // Injeta fixtures DEPOIS de conectar
    runner.context.fixtures = new Fixtures();
    
    // Lista de cenários (ordem importa: fluxo feliz → edge cases → concorrência)
    const scenarios = [
      completeToInvoiceScenario,      // 1. Fluxo feliz
      idempotencyCheckScenario,       // 2. Idempotência
      cancelFlowScenario,             // 3. Rollback
      workerFailureRetryScenario,     // 4. Resiliência
      concurrencyRaceScenario,        // 5. Race condition
      duplicateEventScenario,         // 6. Evento duplicado
      stressTestScenario,             // 7. Carga (10 requisições)
      // Próximos:
      // convenioFlowScenario,
      // liminarRevenueScenario,
    ];
    
    // Executa todos
    const results = [];
    for (const scenario of scenarios) {
      const result = await runner.run(scenario);
      results.push(result);
    }
    
    // Relatório
    const report = runner.printReport(results);
    
    // Exit code
    process.exit(report.success ? 0 : 1);
    
  } catch (error) {
    console.error('❌ Erro fatal:', error.message);
    process.exit(1);
  } finally {
    // Aguarda processamento final antes de parar
    console.log('⏳ Aguardando processamento final...');
    try {
      await runner.waitForStabilization({}, 10000);
    } catch (e) {
      // Ignora timeout, vai parar os workers de qualquer forma
    }
    
    // Pausa todas as filas para não pegar novos jobs
    const { Queue } = await import('bullmq');
    const queueNames = ['complete-orchestrator', 'appointment-processing', 'payment-processing', 'sync-medical', 'notification'];
    for (const name of queueNames) {
      const queue = new Queue(name, { connection: { host: 'localhost', port: 6379 } });
      await queue.pause();
      await queue.close();
    }
    console.log('✅ Filas pausadas');
    
    // Aguarda um pouco para jobs ativos terminarem
    await new Promise(r => setTimeout(r, 2000));
    
    // Para os workers
    stopAllWorkers();
    console.log('✅ Workers parados');
    await runner.afterAll();
  }
}

main();
