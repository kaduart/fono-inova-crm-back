// back/domains/clinical/services/sessionService.js
/**
 * Session Service - Clinical Domain
 * 
 * Service responsável por operações de Session com event-driven.
 * Encapsula criação, conclusão e cancelamento de sessões.
 * 
 * NOTA: Session completion dispara evento SESSION_COMPLETED que é
 * consumido pelo billing domain (via SessionCompletedAdapter).
 */

import Session from '../../../models/Session.js';
import { appendEvent, processWithGuarantees } from '../../../infrastructure/events/eventStoreService.js';
import { createContextLogger } from '../../../utils/logger.js';
import crypto from 'crypto';

const log = createContextLogger('SessionService');

/**
 * Event Types específicos de Session
 */
export const SessionEventTypes = {
  SESSION_SCHEDULED: 'SESSION_SCHEDULED',
  SESSION_STARTED: 'SESSION_STARTED',
  SESSION_COMPLETED: 'SESSION_COMPLETED',
  SESSION_CANCELLED: 'SESSION_CANCELLED',
  SESSION_NO_SHOW: 'SESSION_NO_SHOW'
};

/**
 * Cria uma nova sessão e publica evento
 * 
 * @param {Object} data - Dados da sessão
 * @param {Object} context - Contexto
 * @returns {Promise<{session: Object, event: Object}>}
 */
export async function createSession(data, context = {}) {
  const { 
    userId, 
    correlationId = crypto.randomUUID(),
    appointmentId,
    patientId,
    doctorId
  } = context;
  
  log.info({ correlationId, patientId, doctorId }, 'Criando nova sessão');
  
  // 1. Cria sessão no MongoDB
  const session = await Session.create({
    ...data,
    patient: patientId,
    doctor: doctorId,
    appointment: appointmentId,
    status: 'scheduled',
    createdBy: userId,
    createdAt: new Date()
  });
  
  // 2. Publica evento
  const event = await appendEvent({
    eventId: `ss_create_${session._id}_${Date.now()}`,
    eventType: SessionEventTypes.SESSION_SCHEDULED,
    aggregateType: 'session',
    aggregateId: session._id.toString(),
    payload: {
      sessionId: session._id.toString(),
      appointmentId: appointmentId?.toString(),
      patientId: patientId?.toString(),
      doctorId: doctorId?.toString(),
      date: session.date,
      time: session.time,
      specialty: session.specialty,
      status: 'scheduled'
    },
    metadata: {
      correlationId,
      userId,
      source: 'sessionService.createSession'
    }
  });
  
  log.info({ 
    correlationId, 
    sessionId: session._id,
    eventId: event.eventId 
  }, 'Sessão criada e evento publicado');
  
  return { session, event };
}

/**
 * Completa uma sessão - dispara evento para billing
 * 
 * @param {string} sessionId - ID da sessão
 * @param {Object} data - Dados adicionais (notes, etc)
 * @param {Object} context - Contexto
 * @returns {Promise<{session: Object, event: Object}>}
 */
export async function completeSession(sessionId, data = {}, context = {}) {
  const { 
    userId, 
    correlationId = crypto.randomUUID(),
    addToBalance = false,
    balanceAmount = 0,
    balanceDescription = ''
  } = context;
  
  console.log(`[completeSession] INICIANDO - sessionId: ${sessionId}`, {
    paymentStatus: data?.paymentStatus,
    isPaid: data?.isPaid,
    visualFlag: data?.visualFlag,
    paymentId: data?.paymentId,
    addToBalance,
    correlationId
  });
  
  log.info({ correlationId, sessionId }, 'Completando sessão');
  
  // 1. Busca sessão atual
  const session = await Session.findById(sessionId);
  
  if (!session) {
    throw new Error('SESSAO_NAO_ENCONTRADA');
  }
  
  // 2. Idempotência: verifica se já está completa
  if (session.status === 'completed') {
    log.warn({ correlationId, sessionId }, 'Sessão já está completada');
    return { 
      session, 
      event: null,
      alreadyCompleted: true 
    };
  }
  
  // 3. Monta update da sessão
  const sessionUpdate = {
    status: 'completed',
    completedAt: new Date(),
    sessionConsumed: true,
    notes: data.notes || session.notes,
    updatedBy: userId,
    updatedAt: new Date(),
    // Dados de billing (se fornecidos)
    billing: {
      addToBalance,
      balanceAmount,
      balanceDescription
    }
  };
  
  // 3.1 DADOS DE PAGAMENTO (vindos do worker/orquestrador)
  if (data.paymentId) {
    sessionUpdate.payment = data.paymentId;
  }
  if (data.paymentStatus) {
    sessionUpdate.paymentStatus = data.paymentStatus;
  }
  if (data.isPaid !== undefined) {
    sessionUpdate.isPaid = data.isPaid;
  }
  if (data.visualFlag) {
    sessionUpdate.visualFlag = data.visualFlag;
  }
  
  // 3.2 Atualiza sessão
  const updatedSession = await Session.findByIdAndUpdate(
    sessionId,
    sessionUpdate,
    { new: true }
  ).populate('patient doctor');
  
  // 4. Publica evento SESSION_COMPLETED
  // Este evento é consumido pelo billing domain!
  const event = await appendEvent({
    eventId: `ss_complete_${sessionId}_${Date.now()}`,
    eventType: SessionEventTypes.SESSION_COMPLETED,
    aggregateType: 'session',
    aggregateId: sessionId,
    payload: {
      sessionId,
      appointmentId: session.appointment?.toString(),
      patientId: session.patient?._id?.toString() || session.patient?.toString(),
      doctorId: session.doctor?._id?.toString() || session.doctor?.toString(),
      date: session.date,
      specialty: session.specialty,
      completedAt: new Date(),
      paymentType: session.paymentType || 'individual',  // ✅ Usado pelo billing worker
      // Dados para billing
      billing: {
        addToBalance,
        balanceAmount,
        balanceDescription
      },
      // Dados do paciente para billing (convênio)
      patientData: session.patient ? {
        fullName: session.patient.fullName,
        healthPlan: session.patient.healthPlan,
        insuranceProvider: session.patient.insurance?.provider
      } : undefined
    },
    metadata: {
      correlationId,
      userId,
      source: 'sessionService.completeSession',
      // Importante: marca que precisa ser processado pelo billing
      requiresBillingProcessing: true
    }
  });
  
  console.log(`[completeSession] SUCESSO - sessionId: ${sessionId}`, {
    status: updatedSession?.status,
    paymentStatus: updatedSession?.paymentStatus,
    isPaid: updatedSession?.isPaid,
    eventId: event?.eventId
  });
  
  log.info({ 
    correlationId, 
    sessionId,
    eventId: event.eventId,
    patientId: session.patient?._id?.toString(),
    requiresBilling: true
  }, 'Sessão completada e evento publicado (billing será notificado)');
  
  return { session: updatedSession, event };
}

/**
 * Cancela uma sessão
 * 
 * @param {string} sessionId - ID da sessão
 * @param {Object} data - Motivo do cancelamento
 * @param {Object} context - Contexto
 * @returns {Promise<{session: Object, event: Object}>}
 */
export async function cancelSession(sessionId, data = {}, context = {}) {
  const { 
    userId, 
    correlationId = crypto.randomUUID(),
    reason = '',
    cancelledBy = 'user'
  } = context;
  
  log.info({ correlationId, sessionId, reason }, 'Cancelando sessão');
  
  const session = await Session.findByIdAndUpdate(
    sessionId,
    {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy,
      cancelReason: reason,
      updatedBy: userId,
      updatedAt: new Date()
    },
    { new: true }
  );
  
  if (!session) {
    throw new Error('SESSAO_NAO_ENCONTRADA');
  }
  
  const event = await appendEvent({
    eventId: `ss_cancel_${sessionId}_${Date.now()}`,
    eventType: SessionEventTypes.SESSION_CANCELLED,
    aggregateType: 'session',
    aggregateId: sessionId,
    payload: {
      sessionId,
      appointmentId: session.appointment?.toString(),
      patientId: session.patient?.toString(),
      doctorId: session.doctor?.toString(),
      cancelledAt: new Date(),
      reason,
      cancelledBy
    },
    metadata: {
      correlationId,
      userId,
      source: 'sessionService.cancelSession'
    }
  });
  
  log.info({ correlationId, sessionId, eventId: event.eventId }, 'Sessão cancelada');
  
  return { session, event };
}

/**
 * Busca sessão por ID
 * 
 * @param {string} sessionId - ID da sessão
 * @param {Object} context - Contexto
 * @returns {Promise<Object|null>}
 */
export async function findSessionById(sessionId, context = {}) {
  const { correlationId = crypto.randomUUID() } = context;
  
  log.debug({ correlationId, sessionId }, 'Buscando sessão por ID');
  
  const session = await Session.findById(sessionId)
    .populate('patient doctor appointment')
    .lean();
  
  return session;
}

/**
 * Busca sessões por paciente
 * 
 * @param {string} patientId - ID do paciente
 * @param {Object} filters - Filtros adicionais (status, date, etc)
 * @param {Object} context - Contexto
 * @returns {Promise<Array>}
 */
export async function findSessionsByPatient(patientId, filters = {}, context = {}) {
  const { correlationId = crypto.randomUUID() } = context;
  
  log.debug({ correlationId, patientId, filters }, 'Buscando sessões do paciente');
  
  const sessions = await Session.find({
    patient: patientId,
    ...filters
  })
    .populate('doctor appointment')
    .sort({ date: -1, time: -1 })
    .lean();
  
  return sessions;
}

/**
 * Busca sessões por médico
 * 
 * @param {string} doctorId - ID do médico
 * @param {Object} filters - Filtros (date range, status)
 * @param {Object} context - Contexto
 * @returns {Promise<Array>}
 */
export async function findSessionsByDoctor(doctorId, filters = {}, context = {}) {
  const { correlationId = crypto.randomUUID() } = context;
  
  log.debug({ correlationId, doctorId, filters }, 'Buscando sessões do médico');
  
  const query = { doctor: doctorId };
  
  if (filters.dateFrom || filters.dateTo) {
    query.date = {};
    if (filters.dateFrom) query.date.$gte = filters.dateFrom;
    if (filters.dateTo) query.date.$lte = filters.dateTo;
  }
  
  if (filters.status) {
    query.status = filters.status;
  }
  
  const sessions = await Session.find(query)
    .populate('patient')
    .sort({ date: 1, time: 1 })
    .lean();
  
  return sessions;
}

/**
 * Marca sessão como "não compareceu" (no-show)
 * 
 * @param {string} sessionId - ID da sessão
 * @param {Object} context - Contexto
 * @returns {Promise<{session: Object, event: Object}>}
 */
export async function markSessionNoShow(sessionId, context = {}) {
  const { userId, correlationId = crypto.randomUUID() } = context;
  
  log.info({ correlationId, sessionId }, 'Marcando sessão como no-show');
  
  const session = await Session.findByIdAndUpdate(
    sessionId,
    {
      status: 'no_show',
      noShowAt: new Date(),
      updatedBy: userId,
      updatedAt: new Date()
    },
    { new: true }
  );
  
  if (!session) {
    throw new Error('SESSAO_NAO_ENCONTRADA');
  }
  
  const event = await appendEvent({
    eventId: `ss_noshow_${sessionId}_${Date.now()}`,
    eventType: SessionEventTypes.SESSION_NO_SHOW,
    aggregateType: 'session',
    aggregateId: sessionId,
    payload: {
      sessionId,
      patientId: session.patient?.toString(),
      doctorId: session.doctor?.toString(),
      date: session.date,
      noShowAt: new Date()
    },
    metadata: {
      correlationId,
      userId,
      source: 'sessionService.markSessionNoShow'
    }
  });
  
  return { session, event };
}

// Exporta service completo
export const SessionService = {
  createSession,
  completeSession,
  cancelSession,
  findSessionById,
  findSessionsByPatient,
  findSessionsByDoctor,
  markSessionNoShow,
  SessionEventTypes
};

export default SessionService;
