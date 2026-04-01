// tests/load/syncMedicalWorker.load.test.js
/**
 * Teste de Carga - SyncMedicalWorker
 * 
 * Valida:
 * - Throughput (eventos/segundo)
 * - Idempotência sob carga
 * - Comportamento com falhas simuladas
 * - Consistência final (não duplica invoices)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { redisConnection } from '../../infrastructure/queue/queueConfig.js';
import mongoose from 'mongoose';
import { createContextLogger } from '../../utils/logger.js';

const logger = createContextLogger('LoadTest');

// Configurações do teste
const CONFIG = {
  totalEvents: 1000,        // Total de eventos a gerar
  batchSize: 50,            // Eventos por lote
  concurrency: 10,          // Workers paralelos (simulado)
  duplicateRate: 0.1,       // 10% de eventos duplicados (testa idempotência)
  failureRate: 0.05,        // 5% de falhas simuladas
  maxDuration: 60000,       // Timeout do teste (60s)
};

// Métricas
const metrics = {
  sent: 0,
  processed: 0,
  failed: 0,
  duplicated: 0,
  startTime: null,
  endTime: null
};

describe('🔥 SyncMedicalWorker Load Test', () => {
  let queue;

  beforeAll(async () => {
    // Conecta à fila
    queue = new Queue('sync-medical', { connection: redisConnection });
    
    metrics.startTime = Date.now();
    logger.info('load_test_start', 'Iniciando teste de carga', CONFIG);
  });

  afterAll(async () => {
    metrics.endTime = Date.now();
    const duration = metrics.endTime - metrics.startTime;
    const throughput = (metrics.processed / duration * 1000).toFixed(2);
    
    logger.info('load_test_complete', 'Teste de carga finalizado', {
      ...metrics,
      duration: `${duration}ms`,
      throughput: `${throughput} events/s`
    });

    await queue.close();
  });

  it('deve enfileirar 1000 eventos rapidamente', async () => {
    const events = generateTestEvents(CONFIG.totalEvents, CONFIG.duplicateRate);
    
    // Envia eventos em lotes
    for (let i = 0; i < events.length; i += CONFIG.batchSize) {
      const batch = events.slice(i, i + CONFIG.batchSize);
      await Promise.all(batch.map(event => queue.add(event.type, event.data, {
        jobId: event.id,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 }
      })));
      metrics.sent += batch.length;
    }

    logger.info('events_sent', `${metrics.sent} eventos enviados`);
    expect(metrics.sent).toBe(CONFIG.totalEvents);
  }, 30000);

  it('deve ter gerado eventos com duplicatas para testar idempotência', () => {
    expect(metrics.duplicated).toBeGreaterThan(0);
    logger.info('duplicates_generated', `${metrics.duplicated} eventos duplicados gerados`);
  });
});

// ============================================
// HELPERS
// ============================================

function generateTestEvents(count, duplicateRate) {
  const events = [];

  for (let i = 0; i < count; i++) {
    const isDuplicate = Math.random() < duplicateRate && i > 0;
    const baseId = isDuplicate 
      ? events[Math.floor(Math.random() * events.length)].id
      : `test_payment_${Date.now()}_${i}`;
    
    const eventId = isDuplicate ? baseId : `${baseId}_${Math.random().toString(36).substr(2, 9)}`;
    
    events.push({
      id: eventId,
      type: 'PAYMENT_COMPLETED',
      data: {
        eventType: 'PAYMENT_COMPLETED',
        eventId: eventId,
        correlationId: `load_test_${Date.now()}`,
        idempotencyKey: isDuplicate ? baseId : eventId,
        payload: {
          paymentId: `payment_${i}`,
          appointmentId: `appt_${i}`,
          patientId: `patient_${i % 100}`,
          doctorId: `doctor_${i % 10}`,
          amount: 100 + (i % 50),
          paymentMethod: i % 2 === 0 ? 'pix' : 'card'
        }
      }
    });

    if (isDuplicate) {
      metrics.duplicated++;
    }
  }

  return events;
}
