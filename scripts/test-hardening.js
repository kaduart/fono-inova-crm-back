#!/usr/bin/env node
// scripts/test-hardening.js
/**
 * Script de validação do hardening de produção
 * Testa: Outbox, Redis Lock, DLQ, Logger
 */

import mongoose from 'mongoose';
import { getRedis } from '../services/redisClient.js';
import Outbox from '../models/Outbox.js';
import { acquireLock, releaseLock, withLock } from '../utils/redisLock.js';
import { logger, createContextLogger } from '../utils/logger.js';
import { createOutboxEvent } from '../workers/outboxWorker.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../.env') });

const redis = getRedis();
let passed = 0;
let failed = 0;

function test(name, fn) {
  return async () => {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}: ${err.message}`);
      failed++;
    }
  };
}

async function runTests() {
  console.log('🧪 Iniciando testes de hardening...\n');
  
  // Conecta MongoDB
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB conectado\n');
  
  // Teste 1: Redis Lock
  await test('Redis Lock - Acquire e Release', async () => {
    const token = await acquireLock('test:resource', 10);
    if (!token) throw new Error('Não adquiriu lock');
    
    const released = await releaseLock('test:resource', token);
    if (!released) throw new Error('Não liberou lock');
  })();
  
  // Teste 2: Redis Lock - Prevenção de race condition
  await test('Redis Lock - Bloqueio concorrente', async () => {
    const token1 = await acquireLock('test:concurrent', 10);
    if (!token1) throw new Error('Primeiro lock deveria funcionar');
    
    const token2 = await acquireLock('test:concurrent', 10);
    if (token2) throw new Error('Segundo lock deveria falhar');
    
    await releaseLock('test:concurrent', token1);
  })();
  
  // Teste 3: withLock wrapper
  await test('Redis Lock - withLock wrapper', async () => {
    let executed = false;
    
    await withLock('test:wrapper', async () => {
      executed = true;
      return 'success';
    });
    
    if (!executed) throw new Error('Função não executou');
  })();
  
  // Teste 4: Logger estruturado
  await test('Logger - Criação de log', async () => {
    const log = logger.info('test', 'test_log', { test: true });
    if (!log.timestamp || !log.level) throw new Error('Log mal formado');
  })();
  
  // Teste 5: Logger com contexto
  await test('Logger - Context logger', async () => {
    const log = createContextLogger('corr-123', 'create');
    log.info('step', 'mensagem');
    // Se não der erro, passou
  })();
  
  // Teste 6: Outbox - Criação
  await test('Outbox - Criação de evento', async () => {
    const result = await createOutboxEvent(
      'TEST_EVENT',
      { test: true, data: 'value' },
      { correlationId: 'test-123' }
    );
    
    if (!result.outboxId) throw new Error('Não criou outbox');
    
    // Limpa
    await Outbox.findByIdAndDelete(result.outboxId);
  })();
  
  // Teste 7: Outbox - Persistência
  await test('Outbox - Persistência no MongoDB', async () => {
    const outbox = new Outbox({
      eventType: 'TEST_PERSISTENCE',
      payload: { test: true },
      status: 'pending'
    });
    
    await outbox.save();
    
    const found = await Outbox.findById(outbox._id);
    if (!found) throw new Error('Não persistiu');
    
    await Outbox.findByIdAndDelete(outbox._id);
  })();
  
  // Teste 8: Health Check - Redis
  await test('Health - Redis ping', async () => {
    const result = await redis.ping();
    if (result !== 'PONG') throw new Error('Redis não responde');
  })();
  
  // Teste 9: Health - MongoDB
  await test('Health - MongoDB connection', async () => {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('MongoDB não conectado');
    }
  })();
  
  console.log('\n' + '='.repeat(50));
  console.log(`✅ Passou: ${passed}`);
  console.log(`❌ Falhou: ${failed}`);
  console.log('='.repeat(50));
  
  // Limpa dados de teste
  await Outbox.deleteMany({ eventType: /^TEST_/ });
  await redis.del('lock:test:resource');
  await redis.del('lock:test:concurrent');
  await redis.del('lock:test:wrapper');
  
  await mongoose.disconnect();
  await redis.quit();
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
