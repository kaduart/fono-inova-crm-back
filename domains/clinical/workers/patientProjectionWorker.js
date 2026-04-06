// back/domains/clinical/workers/patientProjectionWorker.js
/**
 * Patient Projection Worker - HARDENED VERSION
 * 
 * Garantias:
 * - Idempotência: rebuild completo sempre (não incremental)
 * - Ordem: não importa (rebuild sobrescreve tudo)
 * - Resiliência: retry com backoff
 * - Observabilidade: logs detalhados + métricas
 */

import { Worker, Queue } from 'bullmq';
import { redisConnection } from '../../../infrastructure/queue/queueConfig.js';
import { createContextLogger } from '../../../utils/logger.js';
import { buildPatientView } from '../services/patientProjectionService.js';
import PatientsView from '../../../models/PatientsView.js';
import Appointment from '../../../models/Appointment.js';
import DLQManager from '../../../infra/queue/dlqSystem.js';

const logger = createContextLogger('PatientProjectionWorker');

// ============================================
// CONFIGURAÇÃO DE RETRY (exponential backoff)
// ============================================

const RETRY_CONFIG = {
  maxRetries: 5,
  backoff: {
    type: 'exponential',
    delay: 2000 // 2s, 4s, 8s, 16s, 32s
  }
};

const dlqManager = new DLQManager(redisConnection);
const dlqQueue = new Queue('patient-projection-dlq', {
  connection: redisConnection,
  defaultJobOptions: { removeOnComplete: false, removeOnFail: false }
});

// ============================================
// WORKER
// ============================================

export const patientProjectionWorker = new Worker(
  'patient-projection',
  async (job) => {
    const { eventType, payload, correlationId, timestamp } = job.data;
    const startTime = Date.now();
    
    logger.info(`[${correlationId}] 🎯 Processing ${eventType}`, {
      patientId: payload.patientId,
      jobId: job.id,
      attempt: job.attemptsMade + 1,
      eventTimestamp: timestamp
    });
    
    try {
      // Validação de payload
      if (!payload.patientId) {
        throw new Error('Missing patientId in payload');
      }
      
      const result = await processEvent(eventType, payload, correlationId);
      
      const duration = Date.now() - startTime;
      logger.info(`[${correlationId}] ✅ Completed ${eventType}`, {
        patientId: payload.patientId,
        duration: `${duration}ms`,
        operation: result.operation
      });
      
      return {
        success: true,
        eventType,
        patientId: payload.patientId,
        duration,
        ...result
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[${correlationId}] ❌ Failed ${eventType}`, {
        patientId: payload.patientId,
        error: error.message,
        stack: error.stack,
        duration: `${duration}ms`,
        attempt: job.attemptsMade + 1,
        willRetry: job.attemptsMade < RETRY_CONFIG.maxRetries
      });
      
      throw error; // BullMQ vai fazer retry
    }
  },
  {
    connection: redisConnection,
    concurrency: 5, // não muito alto para não sobrecarregar MongoDB
    limiter: { max: 20, duration: 1000 },
    stalledInterval: 30000,
    lockDuration: 30000
  }
);

// ============================================
// PROCESSAMENTO DE EVENTOS
// ============================================

async function processEvent(eventType, payload, correlationId) {
  const patientId = payload.patientId;
  
  switch (eventType) {
    // ========================================
    // PATIENT LIFECYCLE
    // ========================================
    case 'PATIENT_CREATED':
    case 'PATIENT_REGISTERED':
      // 🆕 Paciente novo: build inicial
      return await handlePatientCreated(patientId, correlationId);
    
    case 'PATIENT_UPDATED':
      // 📝 Dados alterados: rebuild completo
      return await handlePatientUpdated(patientId, payload, correlationId);
    
    case 'PATIENT_DELETED':
      // 🗑️ Paciente removido: deletar view
      return await handlePatientDeleted(patientId, correlationId);
    
    // ========================================
    // APPOINTMENT EVENTS (afetam stats)
    // ========================================
    case 'APPOINTMENT_SCHEDULED':
    case 'APPOINTMENT_CREATED':
    case 'APPOINTMENT_UPDATED':
    case 'APPOINTMENT_COMPLETED':
    case 'APPOINTMENT_CANCELED':
    case 'APPOINTMENT_RESCHEDULED':
    case 'APPOINTMENT_NO_SHOW':
      // 📅 Qualquer mudança em agendamento = rebuild
      // Afeta: stats, last/next appointment
      return await handleAppointmentEvent(patientId, eventType, correlationId);
    
    // ========================================
    // SESSION EVENTS (afetam stats)
    // ========================================
    case 'SESSION_COMPLETED':
    case 'SESSION_CANCELLED':
    case 'SESSION_CREATED':
    case 'SESSION_PAYMENT_RECEIVED':
      // 🏥 Sessão = rebuild
      return await handleSessionEvent(patientId, eventType, correlationId);
    
    // ========================================
    // PAYMENT EVENTS (afetam saldo)
    // ========================================
    case 'PAYMENT_CREATED':
      // 🔄 Phase 2 da migração do post('save') hook
      return await handlePaymentCreated(payload, correlationId);

    case 'PAYMENT_STATUS_CHANGED':
      // 🔄 Sincroniza appointment.paymentStatus quando payment muda (ex: attended → paid)
      return await handlePaymentStatusChanged(payload, correlationId);

    case 'PAYMENT_COMPLETED':
    case 'PAYMENT_RECEIVED':
    case 'PAYMENT_UPDATED':
    case 'PAYMENT_DELETED':
    case 'PAYMENT_FAILED':
    case 'PAYMENT_CANCELLED':
      // 💰 Pagamento = rebuild (poderia ser parcial, mas rebuild é mais seguro)
      return await handlePaymentEvent(patientId, eventType, correlationId);
    
    // ========================================
    // PACKAGE EVENTS (afetam sessões)
    // ========================================
    case 'PACKAGE_CREATED':
    case 'PACKAGE_UPDATED':
    case 'PACKAGE_CANCELLED':
    case 'PACKAGE_CREDIT_CONSUMED':
    case 'PACKAGE_CREDIT_RESTORED':
    case 'PACKAGE_EXPIRED':
      // 📦 Pacote = rebuild
      return await handlePackageEvent(patientId, eventType, correlationId);
    
    // ========================================
    // BALANCE EVENTS
    // ========================================
    case 'BALANCE_UPDATED':
    case 'BALANCE_CHARGE_CREATED':
      // 💳 Saldo = rebuild
      return await handleBalanceEvent(patientId, eventType, correlationId);
    
    // ========================================
    // MANUAL REBUILD
    // ========================================
    case 'PATIENT_VIEW_REBUILD_REQUESTED':
      // 🔄 Rebuild manual (triggerado por admin ou stale detection)
      return await handleManualRebuild(patientId, payload.reason, correlationId);
    
    default:
      logger.warn(`Unknown event type: ${eventType}`, { patientId });
      return { operation: 'ignored', reason: 'unknown_event' };
  }
}

// ============================================
// HANDLERS (todos usam rebuild completo = idempotente)
// ============================================

async function handlePatientCreated(patientId, correlationId) {
  logger.info(`[${correlationId}] 🆕 Building initial view for new patient`, { patientId });
  
  const view = await buildPatientView(patientId, { correlationId });
  
  if (!view) {
    throw new Error(`Failed to build view for new patient ${patientId}`);
  }
  
  return {
    operation: 'build_initial',
    viewVersion: view.snapshot?.version,
    stats: {
      totalAppointments: view.stats?.totalAppointments || 0,
      totalRevenue: view.stats?.totalRevenue || 0
    }
  };
}

async function handlePatientUpdated(patientId, payload, correlationId) {
  logger.info(`[${correlationId}] 📝 Rebuilding view after patient update`, { 
    patientId,
    updatedFields: Object.keys(payload.updates || {})
  });
  
  // SEMPRE rebuild completo (idempotente)
  const view = await buildPatientView(patientId, { correlationId });
  
  // ✅ FIX P0: null check antes de acessar propriedades
  if (!view) {
    logger.warn(`[${correlationId}] ⚠️ View not built for patient ${patientId} - patient may not exist`);
    return {
      operation: 'rebuild_after_update',
      viewVersion: null,
      error: 'Patient not found, view not built'
    };
  }
  
  return {
    operation: 'rebuild_after_update',
    viewVersion: view.snapshot?.version
  };
}

async function handlePatientDeleted(patientId, correlationId) {
  logger.info(`[${correlationId}] 🗑️ Deleting view for removed patient`, { patientId });
  
  const result = await PatientsView.deleteOne({ patientId });
  
  return {
    operation: 'delete_view',
    deletedCount: result.deletedCount
  };
}

async function handleAppointmentEvent(patientId, eventType, correlationId) {
  logger.info(`[${correlationId}] 📅 Rebuilding view after appointment event`, { 
    patientId, 
    eventType 
  });
  
  const view = await buildPatientView(patientId, { correlationId });
  
  return {
    operation: 'rebuild_appointments',
    viewVersion: view.snapshot?.version,
    nextAppointment: view.nextAppointment?.date || null,
    lastAppointment: view.lastAppointment?.date || null
  };
}

async function handleSessionEvent(patientId, eventType, correlationId) {
  logger.info(`[${correlationId}] 🏥 Rebuilding view after session event`, { 
    patientId, 
    eventType 
  });
  
  const view = await buildPatientView(patientId, { correlationId });
  
  return {
    operation: 'rebuild_sessions',
    viewVersion: view.snapshot?.version,
    totalSessions: view.stats?.totalSessions
  };
}

/**
 * Phase 2 — Shadow Update
 *
 * Replica o comportamento do post('save') hook do model Payment.
 * Roda EM PARALELO com o hook (ambos atualizam appointment.paymentStatus).
 * Objetivo: confirmar parity antes de remover o hook (Phase 4).
 *
 * Hook original (Payment.js):
 *   statusMap = { paid:'paid', pending:'pending', canceled:'canceled', recognized:'recognized' }
 *   Appointment.findByIdAndUpdate(appointmentId, { paymentStatus: statusMap[doc.status] || 'pending' })
 */
async function handlePaymentCreated(payload, correlationId) {
    const { patientId, appointmentId, paymentId, status } = payload;

    // ── Rebuild da patient view (sempre) ─────────────────────────────────────
    const view = await buildPatientView(patientId, { correlationId });

    // ── Shadow update — replica exata do hook ────────────────────────────────
    if (appointmentId) {
        const STATUS_MAP = {
            paid:       'paid',
            pending:    'pending',
            canceled:   'canceled',
            recognized: 'recognized',
        };
        const mappedStatus = STATUS_MAP[status] || 'pending';

        // Busca o valor atual ANTES de atualizar (para o diff log)
        const before = await Appointment.findById(appointmentId)
            .select('paymentStatus')
            .lean();

        await Appointment.findByIdAndUpdate(
            appointmentId,
            { paymentStatus: mappedStatus },
            { new: false }
        );

        // ── Divergence log (Phase 3 core) ────────────────────────────────────
        // Se o hook e o evento produziram resultados diferentes, isso aparece aqui.
        const hookWouldHaveSet = STATUS_MAP[status] || 'pending'; // mesmo mapa do hook
        const diverged = before?.paymentStatus !== undefined &&
                         before.paymentStatus !== hookWouldHaveSet &&
                         before.paymentStatus !== mappedStatus;

        if (diverged) {
            logger.warn(`[PHASE2_DIVERGENCE] appointment ${appointmentId}`, {
                paymentId,
                before:         before?.paymentStatus,
                hookWouldSet:   hookWouldHaveSet,
                eventSet:       mappedStatus,
                correlationId,
            });
        } else {
            logger.info(`[PHASE2_PARITY] appointment ${appointmentId} paymentStatus=${mappedStatus}`, {
                paymentId,
                correlationId,
            });
        }
    }

    return {
        operation:   'shadow_payment_created',
        viewVersion: view?.snapshot?.version,
        appointmentId: appointmentId || null,
    };
}

/**
 * PAYMENT_STATUS_CHANGED → atualiza appointment.paymentStatus + rebuilda view
 *
 * Cobre o ciclo: attended → paid (recebimento confirmado via webhook/manual)
 * PAYMENT_COMPLETED cuida do WhatsApp; este cuida do estado interno do DB.
 *
 * Mapa de status (igual ao hook removido):
 *   paid       → 'paid'
 *   pending    → 'pending'
 *   canceled   → 'canceled'
 *   recognized → 'recognized'
 *   default    → 'pending'
 */
async function handlePaymentStatusChanged(payload, correlationId) {
    const { patientId, appointmentId, status, paymentId } = payload;

    const STATUS_MAP = {
        paid:       'paid',
        pending:    'pending',
        canceled:   'canceled',
        recognized: 'recognized',
        attended:   'pending',  // attended = realizado, aguarda pagamento
    };
    const mappedStatus = STATUS_MAP[status] ?? 'pending';

    // Atualiza appointment se disponível
    if (appointmentId) {
        await Appointment.findByIdAndUpdate(
            appointmentId,
            { paymentStatus: mappedStatus },
            { new: false }
        );

        logger.info(`[${correlationId}] PAYMENT_STATUS_CHANGED → appointment ${appointmentId} = ${mappedStatus}`, {
            paymentId,
            status,
        });
    }

    // Rebuilda patient view (sempre)
    const view = await buildPatientView(patientId, { correlationId });

    return {
        operation:     'payment_status_changed',
        appointmentId: appointmentId || null,
        mappedStatus,
        viewVersion:   view?.snapshot?.version,
    };
}

async function handlePaymentEvent(patientId, eventType, correlationId) {
  logger.info(`[${correlationId}] 💰 Rebuilding view after payment event`, { 
    patientId, 
    eventType 
  });
  
  const view = await buildPatientView(patientId, { correlationId });
  
  return {
    operation: 'rebuild_payments',
    viewVersion: view.snapshot?.version,
    totalRevenue: view.stats?.totalRevenue,
    totalPending: view.stats?.totalPending,
    balance: view.balance?.current
  };
}

async function handlePackageEvent(patientId, eventType, correlationId) {
  logger.info(`[${correlationId}] 📦 Rebuilding view after package event`, { 
    patientId, 
    eventType 
  });
  
  const view = await buildPatientView(patientId, { correlationId });
  
  return {
    operation: 'rebuild_packages',
    viewVersion: view.snapshot?.version,
    totalPackages: view.stats?.totalPackages
  };
}

async function handleBalanceEvent(patientId, eventType, correlationId) {
  logger.info(`[${correlationId}] 💳 Rebuilding view after balance event`, { 
    patientId, 
    eventType 
  });
  
  const view = await buildPatientView(patientId, { correlationId });
  
  return {
    operation: 'rebuild_balance',
    viewVersion: view.snapshot?.version,
    balance: view.balance?.current
  };
}

async function handleManualRebuild(patientId, reason, correlationId) {
  logger.info(`[${correlationId}] 🔄 Manual rebuild requested`, { 
    patientId, 
    reason 
  });
  
  const view = await buildPatientView(patientId, { 
    correlationId,
    force: true 
  });
  
  return {
    operation: 'manual_rebuild',
    reason,
    viewVersion: view.snapshot?.version
  };
}

// ============================================
// EVENT LISTENERS (observabilidade)
// ============================================

patientProjectionWorker.on('completed', (job, result) => {
  logger.info(`✅ Job ${job.id} completed`, {
    eventType: job.data.eventType,
    patientId: job.data.payload?.patientId,
    operation: result?.operation,
    duration: result?.duration
  });
});

patientProjectionWorker.on('failed', (job, err) => {
  const attempts = job.attemptsMade;
  const maxAttempts = RETRY_CONFIG.maxRetries;
  
  logger.error(`❌ Job ${job.id} failed (attempt ${attempts}/${maxAttempts})`, {
    eventType: job.data?.eventType,
    patientId: job.data?.payload?.patientId,
    error: err.message,
    fatal: attempts >= maxAttempts
  });
  
  if (attempts >= maxAttempts) {
    logger.error(`🚨 FATAL: Job ${job.id} exhausted all retries — moving to DLQ`, {
      event: job.data,
      error: err.message
    });
    dlqQueue.add('failed-event', {
      originalJob: job.data,
      error: err.message,
      attempts,
      failedAt: new Date().toISOString()
    }, { removeOnComplete: false, removeOnFail: false }).catch(e =>
      logger.error('Failed to push to DLQ', { error: e.message })
    );
  }
});

patientProjectionWorker.on('stalled', (jobId) => {
  logger.warn(`⚠️ Job ${jobId} stalled`);
});

patientProjectionWorker.on('error', (error) => {
  logger.error('💥 Worker error', { error: error.message });
});

// ============================================
// HEALTH CHECK & MONITORING
// ============================================

export async function getProjectionWorkerStatus() {
  const queue = patientProjectionWorker.queue;
  
  const [
    waiting,
    active,
    completed,
    failed,
    delayed
  ] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount()
  ]);
  
  return {
    status: patientProjectionWorker.isRunning() ? 'running' : 'stopped',
    isPaused: await queue.isPaused(),
    queue: {
      waiting,
      active,
      completed,
      failed,
      delayed
    },
    timestamp: new Date().toISOString()
  };
}

// Métricas para dashboard
export async function getProjectionMetrics(timeWindow = 3600000) { // 1h default
  const queue = patientProjectionWorker.queue;
  const since = new Date(Date.now() - timeWindow);
  
  const completed = await queue.getCompleted(0, 1000);
  const failed = await queue.getFailed(0, 100);
  
  const recentCompleted = completed.filter(j => j.finishedOn > since);
  const recentFailed = failed.filter(j => j.finishedOn > since);
  
  const avgDuration = recentCompleted.length > 0
    ? recentCompleted.reduce((sum, j) => sum + (j.returnvalue?.duration || 0), 0) / recentCompleted.length
    : 0;
  
  return {
    timeWindow: `${timeWindow / 1000}s`,
    processed: recentCompleted.length,
    failed: recentFailed.length,
    successRate: recentCompleted.length / (recentCompleted.length + recentFailed.length) || 0,
    avgDuration: Math.round(avgDuration),
    timestamp: new Date().toISOString()
  };
}

export default patientProjectionWorker;
