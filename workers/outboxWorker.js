// workers/outboxWorker.js
import { Worker } from 'bullmq';
import { redisConnection } from '../infrastructure/queue/queueConfig.js';
import Outbox from '../models/Outbox.js';
import { publishEvent } from '../infrastructure/events/eventPublisher.js';

/**
 * Outbox Worker
 * 
 * Garante que eventos nunca sejam perdidos.
 * Processa eventos pendentes do MongoDB e publica no Redis.
 */

export function startOutboxWorker() {
  const worker = new Worker('outbox-processor', async (job) => {
    const { outboxId } = job.data;
    
    console.log(`[OutboxWorker] Processando evento: ${outboxId}`);
    
    const outbox = await Outbox.findById(outboxId);
    
    if (!outbox) {
      console.log(`[OutboxWorker] Evento não encontrado: ${outboxId}`);
      return { status: 'not_found' };
    }
    
    if (outbox.status === 'published') {
      console.log(`[OutboxWorker] Evento já publicado: ${outboxId}`);
      return { status: 'already_published' };
    }
    
    try {
      // Marca como processando
      outbox.status = 'processing';
      outbox.attempts += 1;
      await outbox.save();
      
      // Publica no Redis
      const result = await publishEvent(
        outbox.eventType,
        outbox.payload,
        outbox.options
      );
      
      // Marca como publicado
      outbox.status = 'published';
      outbox.publishedAt = new Date();
      await outbox.save();
      
      console.log(`[OutboxWorker] ✅ Evento publicado: ${outboxId}`);
      
      return { 
        status: 'published', 
        eventId: result.eventId,
        queue: result.queue
      };
      
    } catch (error) {
      console.error(`[OutboxWorker] ❌ Erro: ${error.message}`);
      
      outbox.status = 'failed';
      outbox.error = error.message;
      await outbox.save();
      
      throw error;
    }
  }, {
    connection: redisConnection,
    concurrency: 10
  });
  
  worker.on('completed', (job, result) => {
    console.log(`[OutboxWorker] Job ${job.id}: ${result.status}`);
  });
  
  worker.on('failed', (job, err) => {
    console.error(`[OutboxWorker] Job ${job.id} falhou: ${err.message}`);
  });
  
  console.log('[OutboxWorker] Worker iniciado');
  return worker;
}

/**
 * Cria um evento no outbox (usado pelas rotas)
 */
export async function createOutboxEvent(eventType, payload, options = {}) {
  const outbox = new Outbox({
    eventType,
    payload,
    options,
    status: 'pending'
  });
  
  await outbox.save();
  
  console.log(`[Outbox] Evento criado: ${outbox._id} (${eventType})`);
  
  // Agenda processamento imediato
  const { getQueue } = await import('../infrastructure/queue/queueConfig.js');
  const queue = getQueue('outbox-processor');
  
  await queue.add('process-outbox', {
    outboxId: outbox._id.toString()
  }, {
    delay: options.delay || 0,
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000
    }
  });
  
  return {
    outboxId: outbox._id,
    eventType,
    status: 'pending'
  };
}
