// back/domains/clinical/workers/sessionWorker.js
/**
 * Session Worker
 * 
 * Papel: Consumir eventos de sessão e executar side effects
 * 
 * Eventos consumidos:
 * - SESSION_COMPLETED: Atualizar métricas de produção
 * - SESSION_CANCELLED: Atualizar métricas, liberar recursos
 * 
 * Este worker NÃO cria sessões (isso é papel do Orchestrator).
 * Ele apenas reage a mudanças de estado das sessões.
 */

import { Worker } from 'bullmq';
import { redisConnection } from '../../../infrastructure/queue/queueConfig.js';
import { createContextLogger } from '../../../utils/logger.js';

const _log = createContextLogger('SessionWorker');
const logger = {
  info: (msg, data) => _log.info('info', msg, data),
  warn: (msg, data) => _log.warn('warn', msg, data),
  error: (msg, data) => _log.error('error', msg, data),
};

/**
 * Cria o Session Worker
 * 
 * @param {Object} deps - Dependências
 * @param {Object} deps.analyticsService - Serviço de analytics/métricas
 * @param {Object} deps.calendarService - Serviço de calendário
 * @param {Object} deps.notificationService - Serviço de notificações
 */
export function createSessionWorker(deps) {
  const { analyticsService, calendarService, notificationService } = deps;

  return new Worker(
    'clinical-session',
    async (job) => {
      const { eventType, payload, metadata } = job.data;
      const correlationId = metadata?.correlationId || job.id;

      logger.info('[SessionWorker] Processing', {
        eventType,
        sessionId: payload?.sessionId,
        correlationId
      });

      try {
        switch (eventType) {
          case 'SESSION_COMPLETED':
            return await handleSessionCompleted(payload, deps, correlationId);

          case 'SESSION_CANCELED':   // EventType real do sistema
          case 'SESSION_CANCELLED':  // alias legado
            return await handleSessionCancelled(payload, deps, correlationId);
            
          default:
            logger.warn('[SessionWorker] Unknown event type', { eventType });
            return { status: 'ignored', reason: 'unknown_event_type' };
        }
      } catch (error) {
        logger.error('[SessionWorker] Error processing job', {
          eventType,
          sessionId: payload?.sessionId,
          error: error.message
        });
        throw error; // Requeue para retry
      }
    },
    {
      connection: redisConnection,
      concurrency: 10,
      limiter: {
        max: 200,
        duration: 1000
      }
    }
  );
}

// ============================================
// HANDLERS
// ============================================

/**
 * Handler: SESSION_COMPLETED
 * 
 * RN-SESSION-WORKER-001: Atualizar métricas de produção do médico
 * RN-SESSION-WORKER-002: Atualizar estatísticas de especialidade
 * RN-SESSION-WORKER-003: Notificar paciente (confirmação)
 * RN-SESSION-WORKER-004: Liberar slot do calendário (marcar como used)
 */
async function handleSessionCompleted(payload, deps, correlationId) {
  const { analyticsService, calendarService, notificationService } = deps;
  const { sessionId, patientId, doctorId, date, specialty, completedAt } = payload;

  logger.info('[SessionWorker] Handling SESSION_COMPLETED', {
    sessionId,
    doctorId,
    date
  });

  const results = await Promise.allSettled([
    // RN-SESSION-WORKER-001: Métricas de produção
    analyticsService.recordProduction({
      doctorId,
      date,
      specialty,
      sessionId,
      completedAt
    }),

    // RN-SESSION-WORKER-002: Estatísticas
    analyticsService.updateSpecialtyStats({
      specialty,
      date,
      action: 'completed'
    }),

    // RN-SESSION-WORKER-003: Notificação
    notificationService.sendSessionCompletedNotification({
      patientId,
      sessionId,
      date,
      specialty
    }),

    // RN-SESSION-WORKER-004: Calendário
    calendarService.markSlotAsUsed({
      doctorId,
      date,
      sessionId
    })
  ]);

  // Verificar falhas
  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length > 0) {
    logger.warn('[SessionWorker] Some side effects failed', {
      sessionId,
      failures: failures.map(f => f.reason?.message)
    });
  }

  // 🆕 V2: atualiza snapshot financeiro
  try {
    const { processFinancialEvent } = await import('../../../workers/financialSnapshotWorker.js');
    processFinancialEvent('SESSION_COMPLETED', payload).catch(() => {});
  } catch {}

  return {
    status: 'success',
    action: 'session_completed_processed',
    sessionId,
    sideEffects: {
      production: results[0].status === 'fulfilled',
      stats: results[1].status === 'fulfilled',
      notification: results[2].status === 'fulfilled',
      calendar: results[3].status === 'fulfilled'
    }
  };
}

/**
 * Handler: SESSION_CANCELLED
 * 
 * RN-SESSION-WORKER-005: Atualizar métricas (cancelamento)
 * RN-SESSION-WORKER-006: Liberar slot do calendário
 * RN-SESSION-WORKER-007: Notificar envolvidos (se necessário)
 */
async function handleSessionCancelled(payload, deps, correlationId) {
  const { analyticsService, calendarService, notificationService } = deps;
  const { sessionId, patientId, doctorId, date, specialty, cancelledBy, reason } = payload;

  logger.info('[SessionWorker] Handling SESSION_CANCELLED', {
    sessionId,
    doctorId,
    cancelledBy
  });

  const results = await Promise.allSettled([
    // RN-SESSION-WORKER-005: Métricas
    analyticsService.recordCancellation({
      doctorId,
      date,
      specialty,
      sessionId,
      cancelledBy,
      reason
    }),

    // RN-SESSION-WORKER-006: Calendário
    calendarService.releaseSlot({
      doctorId,
      date,
      sessionId
    }),

    // RN-SESSION-WORKER-007: Notificação (se cancelado por sistema)
    cancelledBy === 'system' 
      ? notificationService.sendCancellationNotification({
          patientId,
          sessionId,
          reason
        })
      : Promise.resolve()
  ]);

  // 🆕 V2: compensa snapshot financeiro
  try {
    const { processFinancialEvent } = await import('../../../workers/financialSnapshotWorker.js');
    processFinancialEvent('SESSION_CANCELLED', payload).catch(() => {});
  } catch {}

  return {
    status: 'success',
    action: 'session_cancelled_processed',
    sessionId,
    sideEffects: {
      cancellation: results[0].status === 'fulfilled',
      calendar: results[1].status === 'fulfilled',
      notification: results[2].status === 'fulfilled'
    }
  };
}

// ============================================
// WORKER RULES
// ============================================

export const SessionWorkerRules = {
  'RN-SESSION-WORKER-001': 'SESSION_COMPLETED → Atualizar métricas de produção do médico',
  'RN-SESSION-WORKER-002': 'SESSION_COMPLETED → Atualizar estatísticas de especialidade',
  'RN-SESSION-WORKER-003': 'SESSION_COMPLETED → Notificar paciente (confirmação)',
  'RN-SESSION-WORKER-004': 'SESSION_COMPLETED → Marcar slot como usado',
  'RN-SESSION-WORKER-005': 'SESSION_CANCELLED → Registrar cancelamento nas métricas',
  'RN-SESSION-WORKER-006': 'SESSION_CANCELLED → Liberar slot do calendário',
  'RN-SESSION-WORKER-007': 'SESSION_CANCELLED → Notificar se cancelado pelo sistema'
};

export default createSessionWorker;

// ============================================
// START WRAPPER (padrão workers/index.js)
// ============================================

// analyticsService e calendarService não existem ainda — stubs funcionais
const analyticsStub = {
  recordProduction: async () => {},
  updateSpecialtyStats: async () => {},
  recordCancellation: async () => {}
};
const calendarStub = {
  markSlotAsUsed: async () => {},
  releaseSlot: async () => {}
};
// notificationService existe mas com assinatura diferente — stub até adaptar
const notificationStub = {
  sendSessionCompletedNotification: async () => {},
  sendCancellationNotification: async () => {}
};

export function startSessionWorker() {
  const worker = createSessionWorker({
    analyticsService: analyticsStub,
    calendarService: calendarStub,
    notificationService: notificationStub
  });

  _log.info('worker_start', 'SessionWorker iniciado');
  return worker;
}
