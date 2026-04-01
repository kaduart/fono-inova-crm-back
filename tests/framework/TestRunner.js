// tests/framework/TestRunner.js
// Framework avançado de testes E2E para sistema event-driven

import mongoose from 'mongoose';
import { createContextLogger } from '../../utils/logger.js';
import { TestDatabase } from './TestDatabase.js';

/**
 * TestRunner - Orquestrador de testes E2E
 * 
 * Features:
 * - Setup/Teardown isolado
 * - Wait inteligente (race condition proof)
 * - Validação de eventos (outbox)
 * - Idempotência checks
 */
export class TestRunner {
  constructor(config = {}) {
    this.config = {
      timeout: config.timeout || 10000,
      pollInterval: config.pollInterval || 200,
      dbUri: config.dbUri || process.env.MONGO_URI,
      ...config
    };
    this.context = {};
    this.results = [];
    this.log = createContextLogger(null, 'test-runner');
  }

  async beforeAll() {
    this.log.info('init', 'Inicializando TestRunner...');
    
    // Conecta ao banco de teste (isola do desenvolvimento)
    this.testDb = new TestDatabase();
    await this.testDb.connect();
    this.testDb.validateTestDatabase();  // Segurança: só roda em banco teste
    
    this.db = mongoose.connection;
    this.log.info('connected', 'Banco de teste conectado e limpo');
  }

  async afterAll() {
    this.log.info('cleanup', 'Finalizando...');
    
    // Limpa tudo
    await this.testDb?.cleanAll();
    await this.testDb?.disconnect();
    
    this.log.info('done', 'TestRunner finalizado - banco limpo');
  }

  async run(scenario) {
    const { name, setup, execute, assert, cleanup } = scenario;
    
    this.log.info('scenario-start', `Iniciando: ${name}`);
    let data = null;
    
    // Garante que runner está no contexto
    this.context.runner = this;
    
    // Configura token de autenticação para testes
    this.context.authToken = process.env.ADMIN_API_TOKEN || process.env.TEST_API_TOKEN;
    
    try {
      // 1. SETUP
      this.log.info('setup', 'Criando dados...');
      data = await setup(this.context);
      
      // 2. EXECUTE
      this.log.info('execute', 'Executando ação...');
      const result = await execute({ ...this.context, data, runner: this });
      
      // 3. WAIT - Aguarda processamento assíncrono
      this.log.info('wait', 'Aguardando workers...');
      await this.waitForStabilization(data);
      
      // 4. ASSERT
      this.log.info('assert', 'Validando resultado...');
      await assert({ ...this.context, data, result, runner: this });
      
      // 5. CLEANUP (desabilitado entre cenários para permitir processamento async)
      // Cleanup só é feito no afterAll
      this.log.info('cleanup', 'Pulando cleanup (será feito no final)');
      // await cleanup({ ...this.context, data, fixtures: this.context.fixtures });
      
      this.log.info('scenario-pass', `✅ ${name} PASSOU`);
      return { success: true, name };
      
    } catch (error) {
      this.log.error('scenario-fail', `❌ ${name} FALHOU: ${error.message}`);
      
      try {
        await cleanup({ ...this.context, data, fixtures: this.context.fixtures });
      } catch (cleanupErr) {
        this.log.error('cleanup-fail', `Cleanup falhou: ${cleanupErr.message}`);
      }
      
      return { success: false, name, error: error.message };
    }
  }

  async waitForStabilization(data, timeout = 15000) {
    const start = Date.now();
    
    this.log.info('wait', `Aguardando estabilização (timeout: ${timeout}ms)...`);
    
    const Queue = (await import('bullmq')).Queue;
    const queueNames = [
      'complete-orchestrator',
      'appointment-processing',
      'payment-processing',
      'sync-medical',
      'notification'
    ];
    
    while (Date.now() - start < timeout) {
      // Verifica outbox vazio
      const pendingEvents = await mongoose.connection.db
        .collection('outboxes')
        .countDocuments({ status: 'pending' });
      
      // Verifica TODAS as filas
      const queues = queueNames.map(name => new Queue(name, { 
        connection: { host: 'localhost', port: 6379 }
      }));
      
      const queueStats = await Promise.all(
        queues.map(async (q) => ({
          name: q.name,
          waiting: await q.getWaitingCount(),
          active: await q.getActiveCount(),
          failed: await q.getFailedCount()
        }))
      );
      
      await Promise.all(queues.map(q => q.close()));
      
      const totalWaiting = queueStats.reduce((sum, q) => sum + q.waiting, 0);
      const totalActive = queueStats.reduce((sum, q) => sum + q.active, 0);
      const totalFailed = queueStats.reduce((sum, q) => sum + q.failed, 0);
      
      if (pendingEvents === 0 && totalWaiting === 0 && totalActive === 0) {
        this.log.info('stabilized', `Sistema estabilizado (falhos: ${totalFailed})`);
        return;
      }
      
      const queueStatus = queueStats.map(q => `${q.name}: ${q.waiting}w/${q.active}a`).join(', ');
      this.log.info('wait-progress', `Outbox: ${pendingEvents}p | ${queueStatus}`);
      await this.sleep(this.config.pollInterval);
    }
    
    this.log.warn('timeout', 'Timeout aguardando estabilização');
  }

  async waitFor(conditionFn, timeout = 5000, message = 'Condição não satisfeita') {
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      if (await conditionFn()) {
        return true;
      }
      await this.sleep(this.config.pollInterval);
    }
    
    throw new Error(`Timeout: ${message}`);
  }

  async assertEventEmitted(eventType, filter = {}, timeout = 3000) {
    await this.waitFor(async () => {
      const event = await mongoose.connection.db
        .collection('outboxes')
        .findOne({ 
          eventType, 
          status: { $in: ['processed', 'published'] },
          ...filter 
        });
      return !!event;
    }, timeout, `Evento ${eventType} não foi processado`);
    
    this.log.info('event-emitted', `Evento ${eventType} confirmado`);
  }

  async assertIdempotency(collection, filter, expectedCount = 1) {
    const count = await mongoose.connection.db
      .collection(collection)
      .countDocuments(filter);
    
    if (count !== expectedCount) {
      throw new Error(
        `Idempotência quebrada: esperado ${expectedCount}, encontrado ${count} em ${collection}`
      );
    }
    
    this.log.info('idempotency-ok', `Idempotência válida: ${collection}`);
  }

  async assertDatabase(collection, filter, assertions) {
    const doc = await mongoose.connection.db
      .collection(collection)
      .findOne(filter);
    
    if (!doc) {
      throw new Error(`Documento não encontrado em ${collection}`);
    }
    
    for (const [field, expected] of Object.entries(assertions)) {
      const actual = this.getNestedValue(doc, field);
      
      if (actual !== expected && String(actual) !== String(expected)) {
        throw new Error(
          `Assert falhou em ${collection}.${field}: esperado ${expected}, obtido ${actual}`
        );
      }
    }
    
    this.log.info('assert-ok', `Validação OK: ${collection}`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  printReport(results) {
    const passed = results.filter(r => r.success).length;
    const total = results.length;
    
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║              📊 RELATÓRIO DE TESTES E2E                ║');
    console.log('╠════════════════════════════════════════════════════════╣');
    
    results.forEach(r => {
      const icon = r.success ? '✅' : '❌';
      console.log(`║  ${icon} ${r.name.padEnd(45)} ║`);
    });
    
    console.log('╠════════════════════════════════════════════════════════╣');
    console.log(`║  TOTAL: ${passed}/${total} cenários passaram${' '.repeat(28)}║`);
    console.log('╚════════════════════════════════════════════════════════╝\n');
    
    return { passed, total, success: passed === total };
  }
}
