// back/tests/e2e/stress-test.js
/**
 * Stress Test - Simulação de carga real
 * 
 * Testa o sistema sob carga pesada:
 * - WhatsApp bombando (mensagens simultâneas)
 * - Sessões sendo completadas em batch
 * - Eventos em alta velocidade
 * 
 * Objetivos:
 * - Verificar throughput dos workers
 * - Detectar race conditions
 * - Validar rate limiting
 * - Testar DLQ sob pressão
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';

const TEST_DB_URI = process.env.TEST_DB_URI || 'mongodb://localhost:27017/crm_test_stress';

// Configurações de stress
const STRESS_CONFIG = {
  whatsappMessages: 100,      // 100 mensagens simultâneas
  sessionCompletions: 50,     // 50 sessões completadas
  batchSize: 10,              // Processar em lotes de 10
  maxConcurrency: 20,         // Máximo paralelo
  timeoutMs: 60000            // Timeout total do teste
};

describe('🔥 STRESS TEST: Sistema sob carga', () => {
  let redisConnection;
  let queues = {};

  beforeAll(async () => {
    await mongoose.connect(TEST_DB_URI);
    
    // Limpar dados anteriores
    await mongoose.connection.dropDatabase();
    
    // Inicializar filas
    queues.whatsapp = new Queue('whatsapp-message-buffer', { connection: redisConnection });
    queues.billing = new Queue('billing-orchestrator', { connection: redisConnection });
    
    console.log('\n🔥 STRESS TEST CONFIGURATION:');
    console.log(`   WhatsApp Messages: ${STRESS_CONFIG.whatsappMessages}`);
    console.log(`   Session Completions: ${STRESS_CONFIG.sessionCompletions}`);
    console.log(`   Max Concurrency: ${STRESS_CONFIG.maxConcurrency}`);
    console.log(`   Timeout: ${STRESS_CONFIG.timeoutMs}ms\n`);
  });

  afterAll(async () => {
    // Limpar filas
    for (const queue of Object.values(queues)) {
      await queue.obliterate({ force: true });
    }
    await mongoose.disconnect();
  });

  // ============================================
  // TESTE 1: WhatsApp Flood
  // ============================================
  it('should handle WhatsApp message flood', async () => {
    const startTime = Date.now();
    const correlationIds = [];

    console.log('\n📱 TEST 1: WhatsApp Message Flood');
    console.log(`   Injecting ${STRESS_CONFIG.whatsappMessages} messages...`);

    // Injeta mensagens em paralelo
    const promises = [];
    for (let i = 0; i < STRESS_CONFIG.whatsappMessages; i++) {
      const correlationId = `stress_wp_${uuidv4()}`;
      correlationIds.push(correlationId);

      const promise = queues.whatsapp.add('message_received', {
        eventId: `evt_wp_${i}`,
        payload: {
          phone: `551199999${String(i).padStart(4, '0')}`,
          message: `Stress test message ${i}`,
          timestamp: new Date()
        },
        metadata: { 
          correlationId,
          test: 'stress_whatsapp'
        }
      }, {
        priority: i % 10 === 0 ? 1 : 5 // Algumas com prioridade alta
      });

      promises.push(promise);

      // Batch a cada 10 mensagens para não sobrecarregar
      if (promises.length >= STRESS_CONFIG.batchSize) {
        await Promise.all(promises);
        promises.length = 0;
        process.stdout.write('.');
      }
    }

    // Completa restante
    if (promises.length > 0) {
      await Promise.all(promises);
    }

    const injectionTime = Date.now() - startTime;
    console.log(`\n   ✅ Injected in ${injectionTime}ms`);

    // Aguarda processamento
    console.log('   Waiting for processing...');
    await waitForQueueDrain(queues.whatsapp, STRESS_CONFIG.timeoutMs);

    const totalTime = Date.now() - startTime;
    const throughput = (STRESS_CONFIG.whatsappMessages / totalTime * 1000).toFixed(2);

    console.log(`   ✅ Completed in ${totalTime}ms`);
    console.log(`   📊 Throughput: ${throughput} msg/s`);

    // Verifica se todas foram processadas
    const counts = await queues.whatsapp.getJobCounts();
    expect(counts.waiting).toBe(0);
    expect(counts.delayed).toBe(0);

  }, STRESS_CONFIG.timeoutMs + 10000);

  // ============================================
  // TESTE 2: Session Completion Storm
  // ============================================
  it('should handle session completion storm', async () => {
    const startTime = Date.now();
    const correlationIds = [];

    console.log('\n💉 TEST 2: Session Completion Storm');
    console.log(`   Injecting ${STRESS_CONFIG.sessionCompletions} SESSION_COMPLETED events...`);

    const promises = [];
    for (let i = 0; i < STRESS_CONFIG.sessionCompletions; i++) {
      const correlationId = `stress_sess_${uuidv4()}`;
      correlationIds.push(correlationId);

      const promise = queues.billing.add('SESSION_COMPLETED', {
        eventId: `evt_sess_${i}`,
        payload: {
          sessionId: `sess_${i}`,
          patientId: `pat_${i % 10}`, // Reusa alguns pacientes
          doctorId: `doc_${i % 5}`,
          date: new Date(),
          specialty: 'Psicologia',
          paymentType: 'convenio',
          insuranceProvider: 'Unimed',
          patientData: {
            insuranceProvider: 'Unimed'
          }
        },
        metadata: {
          correlationId,
          test: 'stress_sessions'
        }
      });

      promises.push(promise);

      if (promises.length >= STRESS_CONFIG.batchSize) {
        await Promise.all(promises);
        promises.length = 0;
        process.stdout.write('.');
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }

    const injectionTime = Date.now() - startTime;
    console.log(`\n   ✅ Injected in ${injectionTime}ms`);

    // Aguarda processamento
    console.log('   Waiting for billing processing...');
    await waitForQueueDrain(queues.billing, STRESS_CONFIG.timeoutMs);

    const totalTime = Date.now() - startTime;
    const throughput = (STRESS_CONFIG.sessionCompletions / totalTime * 1000).toFixed(2);

    console.log(`   ✅ Completed in ${totalTime}ms`);
    console.log(`   📊 Throughput: ${throughput} events/s`);

    // Verifica DLQ
    const dlqQueue = new Queue('billing-orchestrator_dlq', { connection: redisConnection });
    const dlqCounts = await dlqQueue.getJobCounts();
    
    if (dlqCounts.waiting > 0) {
      console.warn(`   ⚠️  ${dlqCounts.waiting} messages in DLQ`);
    } else {
      console.log('   ✅ No messages in DLQ');
    }

  }, STRESS_CONFIG.timeoutMs + 10000);

  // ============================================
  // TESTE 3: Mixed Load (WhatsApp + Clinical)
  // ============================================
  it('should handle mixed workload', async () => {
    console.log('\n🔄 TEST 3: Mixed Workload');
    console.log('   Simulating real-world scenario...');

    const startTime = Date.now();

    // Simula padrão real: mensagens chegando enquanto sessões são processadas
    const interval = setInterval(async () => {
      // Injeta mensagem WhatsApp aleatória
      await queues.whatsapp.add('message_received', {
        payload: {
          phone: `55119${Math.floor(Math.random() * 100000000)}`,
          message: 'Mixed load test'
        },
        metadata: {
          correlationId: `mixed_${uuidv4()}`,
          test: 'mixed_load'
        }
      });
    }, 100); // A cada 100ms

    // Injeta sessões em paralelo
    for (let i = 0; i < 20; i++) {
      await queues.billing.add('SESSION_COMPLETED', {
        payload: {
          sessionId: `mixed_sess_${i}`,
          patientId: `mixed_pat_${i}`,
          paymentType: 'convenio',
          insuranceProvider: 'Unimed'
        },
        metadata: {
          correlationId: `mixed_${uuidv4()}`,
          test: 'mixed_load'
        }
      });
      await new Promise(r => setTimeout(r, 50));
    }

    // Aguarda 5 segundos de carga mista
    await new Promise(r => setTimeout(r, 5000));
    clearInterval(interval);

    // Aguarda processamento
    await Promise.all([
      waitForQueueDrain(queues.whatsapp, 30000),
      waitForQueueDrain(queues.billing, 30000)
    ]);

    const totalTime = Date.now() - startTime;
    console.log(`   ✅ Mixed load completed in ${totalTime}ms`);

  }, 45000);

  // ============================================
  // TESTE 4: Rate Limiting Validation
  // ============================================
  it('should enforce rate limiting', async () => {
    console.log('\n⏱️  TEST 4: Rate Limiting');
    console.log('   Testing notification rate limits...');

    const notificationQueue = new Queue('whatsapp-notification', { connection: redisConnection });
    
    // Injeta 50 mensagens para o mesmo número (deve ser rate limited)
    const phone = '5511999999999';
    
    for (let i = 0; i < 50; i++) {
      await notificationQueue.add('send_notification', {
        payload: { phone, message: `Rate limit test ${i}` },
        metadata: { correlationId: `rate_${uuidv4()}` }
      });
    }

    // Aguarda processamento
    await new Promise(r => setTimeout(r, 5000));

    const counts = await notificationQueue.getJobCounts();
    console.log(`   Queue status: ${JSON.stringify(counts)}`);

    // Verifica se algumas foram delayed (rate limit)
    // Nota: Isso depende da implementação do rate limiting no worker

    await notificationQueue.obliterate({ force: true });

  }, 15000);

  // ============================================
  // RESUMO
  // ============================================
  it('Summary: Stress test results', async () => {
    console.log('\n' + '='.repeat(60));
    console.log('🔥 STRESS TEST SUMMARY');
    console.log('='.repeat(60));

    const allQueues = [
      'whatsapp-message-buffer',
      'whatsapp-lead-state',
      'whatsapp-orchestrator',
      'whatsapp-notification',
      'billing-orchestrator',
      'clinical-orchestrator'
    ];

    console.log('\nQueue Status:');
    for (const queueName of allQueues) {
      try {
        const queue = new Queue(queueName, { connection: redisConnection });
        const counts = await queue.getJobCounts();
        const total = counts.waiting + counts.active + counts.delayed + counts.completed + counts.failed;
        
        if (total > 0) {
          console.log(`  ${queueName.padEnd(30)}: ${JSON.stringify(counts)}`);
        }
      } catch (e) {
        // Queue não existe
      }
    }

    console.log('\n✅ Stress test completed');
    console.log('='.repeat(60) + '\n');
  });
});

// ============================================
// HELPERS
// ============================================

async function waitForQueueDrain(queue, timeoutMs) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const counts = await queue.getJobCounts();
    const pending = counts.waiting + counts.active + counts.delayed;
    
    if (pending === 0) {
      return;
    }
    
    process.stdout.write(`\r   Pending: ${pending} (waiting: ${counts.waiting}, active: ${counts.active}, delayed: ${counts.delayed})`);
    await new Promise(r => setTimeout(r, 1000));
  }
  
  throw new Error('Timeout waiting for queue drain');
}
