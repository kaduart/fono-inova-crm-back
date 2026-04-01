// back/domains/clinical/workers/clinicalOrchestrator.js
/**
 * Clinical Orchestrator Worker
 * 
 * Papel: Decisão e orquestração do fluxo clínico
 * 
 * Este é o "cérebro" do domínio clínico. Ele:
 * 1. Consome eventos de appointment
 * 2. Decide quando criar/atualizar/cancelar sessões
 * 3. Emite eventos de sessão correspondentes
 * 4. Mantém consistência entre Appointment e Session
 * 
 * Arquitetura inspirada no whatsapp/orchestrator.js
 * mas simplificada para o domínio clínico.
 * 
 * @see ../../whatsapp/orchestrator.js - Padrão a seguir
 */

import { Worker } from 'bullmq';
import { redisConnection } from '../../../infrastructure/queue/queueConfig.js';
import { createContextLogger } from '../../../utils/logger.js';
import { appendEvent } from '../../../infrastructure/events/eventStoreService.js';
import SessionService from '../services/sessionService.js';
import AppointmentService from '../services/appointmentService.js';

const _log = createContextLogger('ClinicalOrchestrator');
const logger = {
  info: (msg, data) => _log.info('info', msg, data),
  warn: (msg, data) => _log.warn('warn', msg, data),
  error: (msg, data) => _log.error('error', msg, data),
};

/**
 * Cria o Clinical Orchestrator Worker
 * 
 * @param {Object} deps - Dependências injetadas
 * @param {Object} deps.sessionService - Serviço de sessões
 * @param {Object} deps.appointmentService - Serviço de agendamentos
 * @param {Object} deps.eventStore - Instância do Event Store
 */
export function createClinicalOrchestrator(deps) {
  const { sessionService, appointmentService, eventStore } = deps;

  return new Worker(
    'clinical-orchestrator',
    async (job) => {
      const { eventType, payload, metadata } = job.data;
      const correlationId = metadata?.correlationId || job.id;

      logger.info('[ClinicalOrchestrator] Processing', {
        eventType,
        appointmentId: payload?.appointmentId,
        correlationId
      });

      switch (eventType) {
        case 'APPOINTMENT_CREATED':    // evento real do sistema
        case 'APPOINTMENT_SCHEDULED':  // alias legado
          return await handleAppointmentScheduled(payload, deps, correlationId);

        case 'APPOINTMENT_RESCHEDULED':
          return await handleAppointmentRescheduled(payload, deps, correlationId);

        case 'APPOINTMENT_CANCELED':   // EventType real do sistema
        case 'APPOINTMENT_CANCELLED':  // alias legado
          return await handleAppointmentCancelled(payload, deps, correlationId);
          
        default:
          logger.warn('[ClinicalOrchestrator] Unknown event type', { eventType });
          return { status: 'ignored', reason: 'unknown_event_type' };
      }
    },
    {
      connection: redisConnection,
      concurrency: 5,
      limiter: {
        max: 100,
        duration: 1000
      }
    }
  );
}

// ============================================
// HANDLERS
// ============================================

/**
 * Handler: APPOINTMENT_SCHEDULED
 * 
 * Regra: Quando um appointment é criado, decidir se cria sessão automaticamente
 * 
 * RN-ORCHESTRATOR-001: Se serviceType='session' → criar SESSION
 * RN-ORCHESTRATOR-002: Se serviceType='evaluation' → criar SESSION (avaliação)
 * RN-ORCHESTRATOR-003: Se vinculado a package → verificar créditos primeiro
 */
async function handleAppointmentScheduled(payload, deps, correlationId) {
  const { sessionService, eventStore } = deps;
  const { appointmentId, patientId, doctorId, date, time, specialty, serviceType, packageId } = payload;

  logger.info('[ClinicalOrchestrator] Handling APPOINTMENT_SCHEDULED', {
    appointmentId,
    serviceType,
    hasPackage: !!packageId
  });

  // Verificar se deve criar sessão
  const shouldCreateSession = ['session', 'evaluation', 'package_session'].includes(serviceType);
  
  if (!shouldCreateSession) {
    return {
      status: 'skipped',
      reason: 'service_type_does_not_require_session',
      serviceType
    };
  }

  // Se tem package, verificar créditos (RN-ORCHESTRATOR-003)
  if (packageId) {
    const hasCredits = await checkPackageCredits(packageId, deps);
    if (!hasCredits) {
      throw new Error(`Package ${packageId} has no available credits`);
    }
  }

  // Criar sessão vinculada ao appointment
  const session = await sessionService.createSession({
    appointmentId,
    patientId,
    doctorId,
    date,
    time,
    specialty,
    status: 'scheduled',
    source: 'appointment_scheduled'
  }, { correlationId });

  logger.info('[ClinicalOrchestrator] Session created', {
    sessionId: session._id,
    appointmentId
  });

  return {
    status: 'success',
    action: 'session_created',
    sessionId: session._id,
    appointmentId
  };
}

/**
 * Handler: APPOINTMENT_RESCHEDULED
 * 
 * Regra: Quando appointment é remarcado, atualizar sessão vinculada
 * 
 * RN-ORCHESTRATOR-004: Buscar SESSION por appointmentId
 * RN-ORCHESTRATOR-005: Se SESSION existe → atualizar data/hora
 * RN-ORCHESTRATOR-006: Se SESSION não existe → logar warning (consistência)
 */
async function handleAppointmentRescheduled(payload, deps, correlationId) {
  const { sessionService } = deps;
  const { appointmentId, newDate, newTime, previousDate, previousTime } = payload;

  logger.info('[ClinicalOrchestrator] Handling APPOINTMENT_RESCHEDULED', {
    appointmentId,
    from: `${previousDate} ${previousTime}`,
    to: `${newDate} ${newTime}`
  });

  // Buscar sessão vinculada (RN-ORCHESTRATOR-004)
  const session = await sessionService.findByAppointmentId(appointmentId);

  if (!session) {
    logger.warn('[ClinicalOrchestrator] No session found for rescheduled appointment', {
      appointmentId
    });
    return {
      status: 'warning',
      reason: 'no_session_found',
      appointmentId
    };
  }

  // Atualizar sessão (RN-ORCHESTRATOR-005)
  const updatedSession = await sessionService.rescheduleSession(
    session._id,
    { date: newDate, time: newTime },
    { correlationId }
  );

  logger.info('[ClinicalOrchestrator] Session rescheduled', {
    sessionId: session._id,
    appointmentId
  });

  return {
    status: 'success',
    action: 'session_rescheduled',
    sessionId: session._id,
    appointmentId
  };
}

/**
 * Handler: APPOINTMENT_CANCELLED
 * 
 * Regra: Quando appointment é cancelado, cancelar sessão vinculada
 * 
 * RN-ORCHESTRATOR-007: Buscar SESSION por appointmentId
 * RN-ORCHESTRATOR-008: Se SESSION existe e status≠completed → cancelar
 * RN-ORCHESTRATOR-009: Se SESSION já completed → logar erro (inconsistência)
 */
async function handleAppointmentCancelled(payload, deps, correlationId) {
  const { sessionService } = deps;
  const { appointmentId, reason, cancelledBy } = payload;

  logger.info('[ClinicalOrchestrator] Handling APPOINTMENT_CANCELLED', {
    appointmentId,
    cancelledBy
  });

  // Buscar sessão vinculada (RN-ORCHESTRATOR-007)
  const session = await sessionService.findByAppointmentId(appointmentId);

  if (!session) {
    return {
      status: 'skipped',
      reason: 'no_session_found',
      appointmentId
    };
  }

  // Verificar se sessão já foi completada (RN-ORCHESTRATOR-009)
  if (session.status === 'completed') {
    logger.error('[ClinicalOrchestrator] Cannot cancel completed session', {
      sessionId: session._id,
      appointmentId
    });
    return {
      status: 'error',
      reason: 'session_already_completed',
      sessionId: session._id
    };
  }

  // Cancelar sessão (RN-ORCHESTRATOR-008)
  await sessionService.cancelSession(
    session._id,
    { reason, cancelledBy },
    { correlationId }
  );

  logger.info('[ClinicalOrchestrator] Session cancelled', {
    sessionId: session._id,
    appointmentId
  });

  return {
    status: 'success',
    action: 'session_cancelled',
    sessionId: session._id,
    appointmentId
  };
}

// ============================================
// HELPERS
// ============================================

async function checkPackageCredits(packageId, deps) {
  // TODO: Implementar verificação de créditos do pacote
  // Por enquanto, assumir que tem créditos
  return true;
}

// ============================================
// WORKER RULES DOCUMENTATION
// ============================================

export const OrchestratorRules = {
  'RN-ORCHESTRATOR-001': 'Se serviceType=session → criar SESSION',
  'RN-ORCHESTRATOR-002': 'Se serviceType=evaluation → criar SESSION',
  'RN-ORCHESTRATOR-003': 'Se vinculado a package → verificar créditos primeiro',
  'RN-ORCHESTRATOR-004': 'Buscar SESSION por appointmentId',
  'RN-ORCHESTRATOR-005': 'Se SESSION existe → atualizar data/hora',
  'RN-ORCHESTRATOR-006': 'Se SESSION não existe → logar warning',
  'RN-ORCHESTRATOR-007': 'Buscar SESSION por appointmentId (cancelamento)',
  'RN-ORCHESTRATOR-008': 'Se SESSION existe e status≠completed → cancelar',
  'RN-ORCHESTRATOR-009': 'Se SESSION já completed → logar erro'
};

export default createClinicalOrchestrator;

// ============================================
// START WRAPPER (padrão workers/index.js)
// ============================================

export function startClinicalOrchestratorWorker() {
  // Adapter: SessionService não tem findByAppointmentId nem rescheduleSession
  const sessionServiceAdapter = {
    createSession: SessionService.createSession,
    findByAppointmentId: async (appointmentId) => {
      const Session = (await import('../../../models/Session.js')).default;
      return Session.findOne({ appointment: appointmentId });
    },
    rescheduleSession: async (sessionId, { date, time }) => {
      const Session = (await import('../../../models/Session.js')).default;
      return Session.findByIdAndUpdate(sessionId, { $set: { date, time } }, { new: true });
    },
    cancelSession: SessionService.cancelSession
  };

  const worker = createClinicalOrchestrator({
    sessionService: sessionServiceAdapter,
    appointmentService: AppointmentService,
    eventStore: { appendEvent }
  });

  _log.info('worker_start', 'ClinicalOrchestratorWorker iniciado');
  return worker;
}
