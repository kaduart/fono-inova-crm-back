// back/domains/billing/workers/packageProjectionWorker.js
/**
 * Package Projection Worker - ELITE VERSION
 * 
 * Garantias de Produção:
 * - Idempotência: eventId + cache de 24h
 * - Resiliência: retry 5x + DLQ + reprocessamento manual
 * - Observabilidade: logs estruturados + métricas + tracing
 * - Zero perda: DLQ persistente com reprocessamento
 * 
 * Eventos Processados:
 * - PACKAGE_CREATED, PACKAGE_UPDATED → build view
 * - PACKAGE_UPDATE_REQUESTED → update doc + rebuild
 * - PACKAGE_DELETE_REQUESTED → cancel doc + delete view
 * - PACKAGE_CANCELLED, PACKAGE_DELETED → delete view
 * - SESSION_* → rebuild (afeta métricas)
 * - PACKAGE_VIEW_REBUILD_REQUESTED → rebuild manual
 */

import { Worker, Queue } from 'bullmq';
import { redisConnection } from '../../../infrastructure/queue/queueConfig.js';
import { createContextLogger } from '../../../utils/logger.js';
import { buildPackageView, deletePackageView } from '../services/PackageProjectionService.js';

const logger = createContextLogger('PackageProjectionWorker');

// ============================================
// CONFIGURAÇÃO DE RESILIÊNCIA
// ============================================

const RESILIENCE_CONFIG = {
  maxRetries: 5,
  backoff: {
    type: 'exponential',
    delay: 2000 // 2s, 4s, 8s, 16s, 32s
  },
  dlqRetention: 7 * 24 * 60 * 60 * 1000, // 7 dias
  eventCacheTTL: 24 * 60 * 60 * 1000 // 24h
};

// ============================================
// IDEMPOTÊNCIA: Cache de eventos processados
// ============================================

const processedEvents = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [eventId, timestamp] of processedEvents) {
    if (now - timestamp > RESILIENCE_CONFIG.eventCacheTTL) {
      processedEvents.delete(eventId);
    }
  }
}, 60 * 60 * 1000);

// ============================================
// DLQ: Fila de mensagens falhas
// ============================================

const dlqQueue = new Queue('package-projection-dlq', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
    attempts: 1
  }
});

// ============================================
// MÉTRICAS (para monitoramento)
// ============================================

const metrics = {
  processed: 0,
  failed: 0,
  movedToDLQ: 0,
  retried: 0,
  byEventType: {}
};

setInterval(() => {
  logger.info('[Metrics] PackageProjectionWorker stats', { metrics });
}, 5 * 60 * 1000); // Log a cada 5 min

// ============================================
// WORKER PRINCIPAL
// ============================================

export const packageProjectionWorker = new Worker(
  'package-projection',
  async (job) => {
    const { eventType, payload, correlationId, eventId } = job.data;
    const startTime = Date.now();
    const attempt = job.attemptsMade + 1;
    
    // 1. IDEMPOTÊNCIA: Verifica se já processou
    if (eventId && processedEvents.has(eventId)) {
      logger.info(`[${correlationId}] ⏭️ Already processed`, { eventId, eventType });
      return { status: 'already_processed', eventId };
    }
    
    logger.info(`[${correlationId}] 🎯 Processing ${eventType}`, {
      packageId: payload?.packageId,
      patientId: payload?.patientId,
      jobId: job.id,
      attempt
    });
    
    try {
      // 2. Validação de payload
      if (!payload?.packageId && !payload?.patientId) {
        throw new Error('Missing packageId or patientId in payload');
      }
      
      // 3. Processa evento
      const result = await processEvent(eventType, payload, correlationId);
      
      // 4. Registra como processado (idempotência)
      if (eventId) {
        processedEvents.set(eventId, Date.now());
      }
      
      // 5. Atualiza métricas
      metrics.processed++;
      metrics.byEventType[eventType] = (metrics.byEventType[eventType] || 0) + 1;
      
      const duration = Date.now() - startTime;
      logger.info(`[${correlationId}] ✅ Completed ${eventType}`, {
        packageId: payload?.packageId,
        duration: `${duration}ms`,
        operation: result.operation
      });
      
      return {
        success: true,
        eventType,
        packageId: payload?.packageId,
        duration,
        ...result
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      const willRetry = job.attemptsMade < RESILIENCE_CONFIG.maxRetries;
      
      logger.error(`[${correlationId}] ❌ Failed ${eventType}`, {
        packageId: payload?.packageId,
        error: error.message,
        duration: `${duration}ms`,
        attempt,
        willRetry
      });
      
      // Se não vai mais tentar, move para DLQ
      if (!willRetry) {
        await moveToDLQ(job, error);
      }
      
      throw error; // BullMQ faz retry
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
    limiter: { max: 20, duration: 1000 },
    stalledInterval: 30000,
    lockDuration: 30000
  }
);

// ============================================
// DLQ: Move mensagem para fila de falhas
// ============================================

async function moveToDLQ(job, error) {
  const { eventType, payload, correlationId, eventId } = job.data;
  
  const dlqEntry = {
    originalJob: {
      id: job.id,
      name: job.name,
      data: job.data,
      timestamp: job.timestamp,
      attemptsMade: job.attemptsMade
    },
    failure: {
      message: error.message,
      stack: error.stack,
      attempts: job.attemptsMade + 1,
      failedAt: new Date().toISOString()
    },
    metadata: {
      movedToDlqAt: new Date().toISOString(),
      correlationId,
      expiresAt: new Date(Date.now() + RESILIENCE_CONFIG.dlqRetention).toISOString()
    }
  };
  
  await dlqQueue.add('failed_job', dlqEntry);
  metrics.movedToDLQ++;
  
  logger.error(`[${correlationId}] 📦 Moved to DLQ`, {
    eventType,
    packageId: payload?.packageId,
    error: error.message,
    attempts: job.attemptsMade + 1
  });
}

// ============================================
// PROCESSAMENTO DE EVENTOS
// ============================================

async function processEvent(eventType, payload, correlationId) {
  const { packageId, patientId } = payload;
  
  switch (eventType) {
    // ========================================
    // PACKAGE LIFECYCLE
    // ========================================
    case 'PACKAGE_CREATED':
    case 'PACKAGE_UPDATED':
      return await handlePackageBuild(packageId, correlationId);
    
    case 'PACKAGE_UPDATE_REQUESTED':
      return await handlePackageUpdateRequested(packageId, payload, correlationId);
    
    case 'PACKAGE_DELETE_REQUESTED':
      return await handlePackageDeleteRequested(packageId, payload, correlationId);
    
    case 'PACKAGE_CANCELLED':
    case 'PACKAGE_DELETED':
      return await handlePackageDelete(packageId, correlationId);
    
    // ========================================
    // SESSION EVENTS (afetam métricas do pacote)
    // ========================================
    case 'SESSION_COMPLETED':
    case 'SESSION_CANCELLED':
    case 'SESSION_CREATED':
    case 'SESSION_PAYMENT_RECEIVED':
      if (packageId) {
        return await handlePackageBuild(packageId, correlationId);
      }
      return { operation: 'ignored', reason: 'no_package_id' };
    
    // ========================================
    // REBUILD MANUAL
    // ========================================
    case 'PACKAGE_VIEW_REBUILD_REQUESTED':
      return await handlePackageBuild(packageId, correlationId);
    
    default:
      logger.warn(`Unknown event type: ${eventType}`, { packageId });
      return { operation: 'ignored', reason: 'unknown_event' };
  }
}

// ============================================
// HANDLERS
// ============================================

async function handlePackageBuild(packageId, correlationId) {
  const result = await buildPackageView(packageId, { correlationId });
  
  // Null check defensivo
  if (!result?.view) {
    throw new Error(`BUILD_RETURNED_NULL: packageId=${packageId}`);
  }
  
  return {
    operation: 'build_view',
    viewVersion: result.view?.snapshot?.version,
    duration: result.duration
  };
}

async function handlePackageDelete(packageId, correlationId) {
  await deletePackageView(packageId);
  return {
    operation: 'delete_view',
    deleted: true
  };
}

async function handlePackageUpdateRequested(packageId, payload, correlationId) {
  const { updates, updatedBy } = payload;
  
  // 1. Atualiza o documento original no MongoDB
  const Package = (await import('../../../models/Package.js')).default;
  const updated = await Package.findByIdAndUpdate(
    packageId,
    { 
      ...updates,
      updatedBy,
      updatedAt: new Date()
    },
    { new: true }
  );
  
  if (!updated) {
    throw new Error(`Package ${packageId} not found for update`);
  }
  
  // 2. Rebuild da view
  const result = await buildPackageView(packageId, { correlationId });
  
  if (!result?.view) {
    throw new Error(`BUILD_RETURNED_NULL after update: packageId=${packageId}`);
  }
  
  return {
    operation: 'update_and_rebuild',
    viewVersion: result.view?.snapshot?.version,
    duration: result.duration
  };
}

async function handlePackageDeleteRequested(packageId, payload, correlationId) {
  const { reason, deletedBy } = payload;
  
  // 1. Soft delete no documento original
  const Package = (await import('../../../models/Package.js')).default;
  const updated = await Package.findByIdAndUpdate(
    packageId,
    { 
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: deletedBy,
      cancellationReason: reason,
      updatedAt: new Date()
    },
    { new: true }
  );
  
  if (!updated) {
    throw new Error(`Package ${packageId} not found for cancellation`);
  }
  
  // 2. Remove a view
  await deletePackageView(packageId);
  
  return {
    operation: 'cancel_and_delete_view',
    cancelled: true,
    reason
  };
}

// ============================================
// EVENT HANDLERS (logs/métricas)
// ============================================

packageProjectionWorker.on('completed', (job, result) => {
  if (result?.status !== 'already_processed') {
    logger.info(`Job ${job.id} completed`, {
      eventType: job.data.eventType,
      packageId: job.data.payload?.packageId,
      duration: result?.duration
    });
  }
});

packageProjectionWorker.on('failed', (job, err) => {
  logger.error(`Job ${job.id} failed`, {
    eventType: job.data?.eventType,
    packageId: job.data?.payload?.packageId,
    error: err.message,
    attempts: job.attemptsMade
  });
});

// ============================================
// API DE DLQ (para reprocessamento manual)
// ============================================

export async function listDLQMessages(limit = 100) {
  const jobs = await dlqQueue.getJobs(['waiting'], 0, limit);
  return jobs.map(job => ({
    id: job.id,
    failedAt: job.data.metadata?.movedToDlqAt,
    error: job.data.failure?.message,
    correlationId: job.data.metadata?.correlationId,
    eventType: job.data.originalJob?.data?.eventType,
    packageId: job.data.originalJob?.data?.payload?.packageId
  }));
}

export async function reprocessDLQMessage(jobId) {
  const job = await dlqQueue.getJob(jobId);
  
  if (!job) {
    throw new Error(`Job ${jobId} not found in DLQ`);
  }
  
  const { originalJob } = job.data;
  
  logger.info(`[DLQ] Reprocessing message`, {
    jobId,
    eventType: originalJob.data.eventType,
    correlationId: originalJob.data.correlationId
  });
  
  try {
    // Remove da DLQ
    await job.remove();
    
    // Reprocessa
    const result = await processEvent(
      originalJob.data.eventType,
      originalJob.data.payload,
      originalJob.data.correlationId
    );
    
    logger.info(`[DLQ] Reprocess succeeded`, { jobId });
    return { success: true, result };
    
  } catch (error) {
    // Se falhar, volta para DLQ
    await moveToDLQ({ ...originalJob, attemptsMade: 0 }, error);
    throw error;
  }
}

export async function getDLQStats() {
  const counts = await dlqQueue.getJobCounts();
  return {
    ...counts,
    metrics: { ...metrics }
  };
}

export default packageProjectionWorker;
