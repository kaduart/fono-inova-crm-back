// workers/syncMedicalWorker.js
/**
 * Sync Medical Worker
 *
 * Responsabilidade: Tratar eventos secundários de domínio que não têm dono no fluxo principal.
 * NÃO decide billing — o CompleteOrchestrator é a fonte de verdade.
 *
 * Garantias:
 * - Idempotência via eventId
 * - Retry automático com backoff exponencial
 * - DLQ para eventos que falham permanentemente
 * - Logs estruturados com correlationId
 *
 * Eventos processados:
 * - INSURANCE_GLOSA → Registra glosa de convênio para revisão do financeiro
 * - APPOINTMENT_COMPLETED → Ack
 * - APPOINTMENT_CANCELLED → Ack (futuro: cancelar invoice se existir)
 */

import { Worker, Queue } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import { createContextLogger } from '../utils/logger.js';
import EventStore from '../models/EventStore.js';

const logger = createContextLogger('SyncMedicalWorker');

// ============================================
// CONFIGURAÇÃO
// ============================================

const CONFIG = {
  maxRetries: 5,
  backoff: {
    type: 'exponential',
    delay: 2000 // 2s, 4s, 8s, 16s, 32s
  },
  concurrency: 5
};

// DLQ para eventos que falham
const dlqQueue = new Queue('sync-medical-dlq', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
    attempts: 1
  }
});

// Cache de eventos processados (idempotência em memória)
const processedEvents = new Map();
const EVENT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// Limpa cache antigo a cada hora
setInterval(() => {
  const now = Date.now();
  for (const [eventId, timestamp] of processedEvents) {
    if (now - timestamp > EVENT_CACHE_TTL) {
      processedEvents.delete(eventId);
    }
  }
}, 60 * 60 * 1000);

// ============================================
// WORKER
// ============================================

export function startSyncMedicalWorker() {
  logger.info('worker_start', 'Iniciando SyncMedicalWorker');

  const worker = new Worker('sync-medical', async (job) => {
    const { eventType, eventId, correlationId, payload, idempotencyKey } = job.data;
    const startTime = Date.now();
    const attempt = job.attemptsMade + 1;

    const log = createContextLogger(correlationId || eventId, 'sync_medical');

    log.info('job_start', 'Processando evento médico', {
      eventType,
      eventId,
      attempt,
      maxRetries: CONFIG.maxRetries
    });

    // 🛡️ IDEMPOTÊNCIA: Verifica se já processou
    if (await isAlreadyProcessed(eventId, idempotencyKey)) {
      log.info('idempotent', 'Evento já processado, ignorando', { eventId });
      return { status: 'already_processed', idempotent: true };
    }

    try {
      let result;

      switch (eventType) {
        case 'INSURANCE_GLOSA':
          result = await handleInsuranceGlosa(payload, log);
          break;

        case 'APPOINTMENT_COMPLETED':
          result = await handleAppointmentCompleted(payload, log);
          break;

        case 'APPOINTMENT_CANCELLED':
          result = await handleAppointmentCancelled(payload, log);
          break;

        default:
          log.warn('event_ignored', 'Evento não tratado', { eventType });
          return { status: 'ignored', eventType };
      }

      // Registra como processado
      await markAsProcessed(eventId, idempotencyKey, result);

      const duration = Date.now() - startTime;
      log.info('job_success', 'Evento processado com sucesso', {
        eventType,
        eventId,
        duration: `${duration}ms`,
        result
      });

      return { status: 'success', ...result };

    } catch (error) {
      const duration = Date.now() - startTime;
      const willRetry = job.attemptsMade < CONFIG.maxRetries;

      log.error('job_error', 'Erro processando evento', {
        eventType,
        eventId,
        error: error.message,
        attempt,
        willRetry,
        duration: `${duration}ms`
      });

      // Se não vai mais tentar, move para DLQ
      if (!willRetry) {
        await moveToDLQ(job, error);
        log.error('job_dlq', 'Evento movido para DLQ', { eventId, error: error.message });
      }

      throw error;
    }
  }, {
    connection: redisConnection,
    concurrency: CONFIG.concurrency,
    limiter: {
      max: 20,
      duration: 1000
    }
  });

  worker.on('completed', (job, result) => {
    if (!result?.idempotent) {
      logger.info('job_completed', `Job ${job.id} completado`, {
        eventType: job.data.eventType,
        status: result?.status
      });
    }
  });

  worker.on('failed', (job, error) => {
    logger.error('job_failed', `Job ${job?.id} falhou`, {
      eventType: job?.data?.eventType,
      error: error.message,
      attempts: job?.attemptsMade
    });
  });

  logger.info('worker_ready', 'SyncMedicalWorker iniciado e pronto');
  return worker;
}

// ============================================
// IDEMPOTÊNCIA
// ============================================

async function isAlreadyProcessed(eventId, idempotencyKey) {
  // Cache em memória (rápido)
  if (eventId && processedEvents.has(eventId)) {
    return true;
  }

  // Verifica EventStore (persistente)
  if (eventId) {
    const existing = await EventStore.findOne({ 
      eventId,
      status: 'processed'
    });
    if (existing) {
      processedEvents.set(eventId, Date.now());
      return true;
    }
  }

  // Verifica por idempotencyKey
  if (idempotencyKey) {
    const existing = await EventStore.findOne({
      idempotencyKey,
      status: 'processed'
    });
    if (existing) {
      if (eventId) processedEvents.set(eventId, Date.now());
      return true;
    }
  }

  return false;
}

async function markAsProcessed(eventId, idempotencyKey, result) {
  if (eventId) {
    processedEvents.set(eventId, Date.now());
  }

  // Registra no EventStore para persistência
  try {
    await EventStore.findOneAndUpdate(
      { eventId },
      {
        eventId,
        idempotencyKey,
        status: 'processed',
        processedAt: new Date(),
        result: JSON.stringify(result)
      },
      { upsert: true }
    );
  } catch (error) {
    // Não falha se não conseguir registrar, apenas loga
    logger.warn('event_store_warn', 'Não conseguiu registrar no EventStore', { error: error.message });
  }
}

// ============================================
// HANDLERS
// ============================================

async function handleInsuranceGlosa(payload, log) {
  const { itemId, batchId, expectedAmount, paidAmount, glosaAmount, glosaType, detectedAt } = payload;

  if (!itemId || glosaAmount === undefined) {
    throw new Error(`Dados incompletos de glosa: itemId=${itemId}`);
  }

  log.warn('glosa_received', 'Glosa de convênio recebida — requer ação do financeiro', {
    itemId,
    batchId,
    expectedAmount,
    paidAmount,
    glosaAmount,
    glosaType,
    detectedAt
  });

  // TODO: atualizar InsuranceItem.status = 'glosa' quando modelo estiver disponível
  // Possíveis ações: fix_resubmit | charge_patient | write_off

  return {
    status: 'glosa_logged',
    itemId,
    batchId,
    glosaAmount,
    glosaType,
    requiresAction: true
  };
}

async function handleAppointmentCompleted(payload, log) {
  const { appointmentId, paymentOrigin } = payload;

  // Invoice per-session é criada pelo CompleteOrchestrator no momento do complete
  // Este worker apenas confirma o recebimento
  log.info('appointment_completed_ack', 'Appointment completado (invoice já criada)', {
    appointmentId,
    paymentOrigin
  });

  return {
    status: 'acknowledged',
    message: 'Invoice criada pelo CompleteOrchestrator',
    appointmentId,
    paymentOrigin
  };
}

async function handleAppointmentCancelled(payload, log) {
  const { appointmentId } = payload;

  log.info('appointment_cancelled', 'Appointment cancelado', { appointmentId });

  // TODO: Futuro - cancelar invoice se existir
  // const Invoice = (await import('../models/Invoice.js')).default;
  // await Invoice.findOneAndUpdate(
  //   { appointment: appointmentId },
  //   { status: 'cancelled', cancelledAt: new Date() }
  // );

  return {
    status: 'acknowledged',
    event: 'APPOINTMENT_CANCELLED',
    appointmentId
  };
}

// ============================================
// API DLQ (para reprocessamento manual)
// ============================================

export async function listDLQMessages(limit = 100) {
  const jobs = await dlqQueue.getJobs(['waiting'], 0, limit);
  return jobs.map(job => ({
    id: job.id,
    eventType: job.data?.eventType,
    eventId: job.data?.eventId,
    error: job.failedReason,
    failedAt: job.failedAt
  }));
}

export async function reprocessDLQMessage(jobId) {
  const job = await dlqQueue.getJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} não encontrado na DLQ`);
  }

  // Remove da DLQ e reprocessa
  await job.remove();
  
  // Adiciona novamente na fila principal
  const mainQueue = new Queue('sync-medical', { connection: redisConnection });
  await mainQueue.add(job.name, job.data, {
    jobId: `reprocess_${jobId}_${Date.now()}`
  });

  return { success: true, message: 'Job reprocessado' };
}

export default { startSyncMedicalWorker, listDLQMessages, reprocessDLQMessage };
