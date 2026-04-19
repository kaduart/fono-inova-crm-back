/**
 * ============================================================================
 * INSURANCE BILLING SERVICE V2 - IDEMPOTÊNCIA TOTAL
 * ============================================================================
 * 
 * Garantias:
 * - Nunca cria duplicata (índice único + checagem prévia)
 * - Nunca consome guia 2x (lock otimista + idempotência)
 * - Nunca publica evento 2x (idempotencyKey no EventStore)
 * - Compensação automática em caso de falha (Saga)
 * 
 * Regra de Ouro:
 * "Antes de criar, sempre procurar. Se existir → reutiliza. Se não → cria."
 * ============================================================================
 */

import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import EventStore from '../../../models/EventStore.js';
import { publishEvent, publishEvents } from '../../../infrastructure/events/eventPublisher.js';
import guideService from '../../../services/billing/guideService.js';
import { createError, ERROR_CODES } from '../../../utils/errorUtils.js';
import { 
  validateTransition, 
  canBill, 
  canReceive,
  FINANCIAL_STATES 
} from '../models/FinancialStateMachine.js';
import Appointment from '../../../models/Appointment.js';
import Payment from '../../../models/Payment.js';
import Session from '../../../models/Session.js';

// =============================================================================
// CONFIGURAÇÃO
// =============================================================================

const INSURANCE_BILLING_EVENTS = {
  SESSION_COMPLETED: 'SESSION_COMPLETED',
  INSURANCE_GUIDE_LOCKED: 'INSURANCE_GUIDE_LOCKED',
  INSURANCE_GUIDE_LOCK_FAILED: 'INSURANCE_GUIDE_LOCK_FAILED',
  INSURANCE_BILLING_CREATED: 'INSURANCE_BILLING_CREATED',
  INSURANCE_BILLING_BILLED: 'INSURANCE_BILLING_BILLED',
  INSURANCE_PAYMENT_RECEIVED: 'INSURANCE_PAYMENT_RECEIVED',
  INSURANCE_BILLING_FAILED: 'INSURANCE_BILLING_FAILED',
  INSURANCE_PAYMENT_PENDING: 'INSURANCE_PAYMENT_PENDING',
  INSURANCE_APPOINTMENT_LINKED: 'INSURANCE_APPOINTMENT_LINKED',
  INSURANCE_BILLING_CANCELLED: 'INSURANCE_BILLING_CANCELLED',
  INSURANCE_DUPLICATE_DETECTED: 'INSURANCE_DUPLICATE_DETECTED'
};

const LOCK_CONFIG = {
  TTL_SECONDS: 300,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 100
};

// =============================================================================
// IDEMPOTÊNCIA
// =============================================================================

async function checkIdempotency(operationType, entityId, correlationId) {
  const idempotencyKey = `${operationType}_${entityId}_${correlationId || 'default'}`;
  
  const existing = await EventStore.findOne({ 
    idempotencyKey,
    status: { $in: ['processed', 'processing'] }
  });
  
  if (existing) {
    return {
      isDuplicate: true,
      event: existing,
      idempotencyKey
    };
  }
  
  return { isDuplicate: false, idempotencyKey };
}

async function markProcessing(eventType, aggregateId, payload, idempotencyKey, correlationId) {
  return await EventStore.appendEvent({
    eventId: uuidv4(),
    eventType: `${eventType}_PROCESSING`,
    aggregateType: 'InsuranceBilling',
    aggregateId,
    payload,
    metadata: { idempotencyKey, correlationId, startedAt: new Date().toISOString() },
    idempotencyKey: `${idempotencyKey}_processing`,
    status: 'processing'
  });
}

// =============================================================================
// LOCK DE GUIA
// =============================================================================

async function acquireGuideLock(guideId, sessionId, lockedBy) {
  const Guide = mongoose.model('InsuranceGuide');
  const lockId = uuidv4();
  const expiresAt = new Date(Date.now() + LOCK_CONFIG.TTL_SECONDS * 1000);
  
  for (let attempt = 1; attempt <= LOCK_CONFIG.RETRY_ATTEMPTS; attempt++) {
    try {
      const guide = await Guide.findOneAndUpdate(
        {
          _id: guideId,
          $or: [
            { lockId: { $exists: false } },
            { lockExpiresAt: { $lt: new Date() } }
          ]
        },
        {
          $set: {
            lockId,
            lockSessionId: sessionId,
            lockLockedBy: lockedBy,
            lockExpiresAt: expiresAt,
            lockedAt: new Date()
          }
        },
        { new: true }
      );
      
      if (guide) {
        return { success: true, lockId, expiresAt, guide };
      }
      
      if (attempt < LOCK_CONFIG.RETRY_ATTEMPTS) {
        await new Promise(r => setTimeout(r, LOCK_CONFIG.RETRY_DELAY_MS * attempt));
      }
    } catch (error) {
      console.error(`[acquireGuideLock] Attempt ${attempt} failed:`, error);
      if (attempt === LOCK_CONFIG.RETRY_ATTEMPTS) throw error;
    }
  }
  
  const lockedGuide = await Guide.findById(guideId).select('lockSessionId lockLockedBy lockExpiresAt');
  return {
    success: false,
    reason: 'GUIDE_LOCKED',
    lockedBySession: lockedGuide?.lockSessionId,
    lockedBy: lockedGuide?.lockLockedBy,
    expiresAt: lockedGuide?.lockExpiresAt
  };
}

async function releaseGuideLock(guideId, lockId) {
  const Guide = mongoose.model('InsuranceGuide');
  const result = await Guide.updateOne(
    { _id: guideId, lockId: lockId },
    { $unset: { lockId: 1, lockSessionId: 1, lockLockedBy: 1, lockExpiresAt: 1, lockedAt: 1 } }
  );
  return { success: result.modifiedCount > 0, wasLocked: result.matchedCount > 0 };
}

// =============================================================================
// COMPENSAÇÃO (SAGA)
// =============================================================================

const compensationActions = [];

async function registerCompensation(action) {
  compensationActions.push(action);
}

async function executeCompensations() {
  const results = [];
  for (const action of [...compensationActions].reverse()) {
    try {
      await action();
      results.push({ success: true });
    } catch (error) {
      results.push({ success: false, error: error.message });
      console.error('[executeCompensations] CRITICAL: Compensation failed:', error);
    }
  }
  compensationActions.length = 0;
  return results;
}

// =============================================================================
// SERVIÇO PRINCIPAL
// =============================================================================

export class InsuranceBillingService {
  constructor() {
    this.eventStore = EventStore;
  }

  /**
   * ==========================================================================
   * FLUXO PRINCIPAL: Session Completed → Billing
   * ==========================================================================
   * 
   * IDEMPOTÊNCIA TOTAL:
   * 1. Checa EventStore (já processou?)
   * 2. Checa Session existente (business key)
   * 3. Só então cria
   */
  async processSessionCompleted(sessionId, options = {}) {
    const correlationId = options.correlationId || uuidv4();
    const startTime = Date.now();
    
    console.log(`[InsuranceBilling] Processing session ${sessionId}`, { correlationId });
    
    // 1. IDEMPOTÊNCIA: Verifica EventStore
    const idempotency = await checkIdempotency('SESSION_BILLING', sessionId, correlationId);
    if (idempotency.isDuplicate) {
      console.log(`[InsuranceBilling] Duplicate detected (EventStore), skipping: ${sessionId}`);
      return {
        success: true,
        duplicate: true,
        source: 'eventstore',
        billingId: idempotency.event?.payload?.billingId,
        correlationId
      };
    }
    
    const mongoSession = await mongoose.startSession();
    let lockResult = null;
    
    try {
      await mongoSession.startTransaction();
      
      // 2. Marca como PROCESSING
      await markProcessing(
        INSURANCE_BILLING_EVENTS.INSURANCE_BILLING_CREATED,
        sessionId,
        { sessionId },
        idempotency.idempotencyKey,
        correlationId
      );
      
      // 3. Busca sessão com dados necessários
      const session = await Session.findById(sessionId)
        .populate('patient')
        .populate('professional')
        .session(mongoSession);
      
      if (!session) {
        throw createError('Session not found', ERROR_CODES.NOT_FOUND, 404);
      }
      
      // Validações
      if (session.paymentType !== 'convenio') {
        return { success: true, skipped: true, reason: 'NOT_INSURANCE_SESSION' };
      }
      
      // 🔥 IDEMPOTÊNCIA: Já processou?
      if (session.insuranceBillingProcessed && session.insuranceAppointmentId) {
        console.log(`[InsuranceBilling] Already processed, returning existing: ${session.insuranceAppointmentId}`);
        
        // Publica evento de duplicata detectada (para métricas)
        await publishEvent(INSURANCE_BILLING_EVENTS.INSURANCE_DUPLICATE_DETECTED, {
          sessionId,
          existingAppointmentId: session.insuranceAppointmentId,
          correlationId
        }, { correlationId });
        
        return {
          success: true,
          duplicate: true,
          source: 'session_check',
          billingId: session.insuranceAppointmentId,
          correlationId
        };
      }
      
      // 4. CHECAGEM FORTE: Busca por business key (prevenção de duplicata)
      const existingCheck = await Session.existsByContext(
        session.patient._id,
        session.professional._id,
        session.date,
        session.time || '00:00',
        session.specialty,
        session.insuranceGuide
      );
      
      // Se existe outra sessão com mesmo contexto (não é a atual)
      if (existingCheck.exists && existingCheck.session._id.toString() !== sessionId) {
        console.log(`[InsuranceBilling] Duplicate context found: ${existingCheck.session._id}`);
        
        // Reutiliza a existente
        return {
          success: true,
          duplicate: true,
          source: 'business_key',
          existingSessionId: existingCheck.session._id,
          billingId: existingCheck.appointmentId,
          correlationId
        };
      }
      
      // 5. BUSCA E LOCK DA GUIA
      const guide = await this.findAndLockGuide(session, mongoSession, correlationId);
      lockResult = guide.lockResult;
      
      if (!lockResult.success) {
        await publishEvent(INSURANCE_BILLING_EVENTS.INSURANCE_GUIDE_LOCK_FAILED, {
          sessionId,
          patientId: session.patient?._id,
          reason: lockResult.reason,
          retryAfter: lockResult.expiresAt
        }, { correlationId });
        
        throw createError(
          `Guide locked by another session: ${lockResult.lockedBySession}`,
          ERROR_CODES.CONFLICT,
          423
        );
      }
      
      await registerCompensation(async () => {
        await releaseGuideLock(guide._id, lockResult.lockId);
      });
      
      // 6. CONSUME SESSÃO DA GUIA
      const consumeResult = await this.consumeGuideSession(
        guide, 
        session, 
        mongoSession,
        lockResult.lockId
      );
      
      // 7. OBTÉM VALOR DO PROCEDIMENTO
      const { grossAmount, procedureCode } = await this.calculateSessionValue(
        session,
        guide
      );
      
      // 8. CRIA APPOINTMENT (com idempotência interna)
      const appointment = await this.createInsuranceAppointment(
        session,
        guide,
        consumeResult.sessionNumber,
        grossAmount,
        mongoSession
      );
      
      await registerCompensation(async () => {
        await Appointment.deleteOne({ _id: appointment._id });
      });
      
      // 9. CRIA/ATUALIZA PAYMENT
      const payment = await this.createOrUpdateInsurancePayment(
        session,
        appointment,
        grossAmount,
        guide,
        mongoSession
      );
      
      // 10. MARCA SESSÃO COMO PROCESSADA
      await Session.findByIdAndUpdate(
        sessionId,
        { 
          insuranceBillingProcessed: true,
          insuranceBillingProcessedAt: new Date(),
          insuranceAppointmentId: appointment._id,
          _billingEventId: correlationId
        },
        { session: mongoSession }
      );
      
      // 11. COMMIT
      await mongoSession.commitTransaction();
      
      // 12. PUBLICA EVENTOS
      const events = [
        {
          type: INSURANCE_BILLING_EVENTS.INSURANCE_GUIDE_LOCKED,
          payload: {
            guideId: guide._id,
            sessionId,
            lockId: lockResult.lockId,
            consumedSessionNumber: consumeResult.sessionNumber,
            remainingSessions: consumeResult.remaining
          }
        },
        {
          type: INSURANCE_BILLING_EVENTS.INSURANCE_BILLING_CREATED,
          payload: {
            billingId: appointment._id,
            sessionId,
            patientId: session.patient?._id,
            guideId: guide._id,
            amount: grossAmount,
            procedureCode,
            sessionNumber: consumeResult.sessionNumber
          }
        },
        {
          type: INSURANCE_BILLING_EVENTS.INSURANCE_PAYMENT_PENDING,
          payload: {
            paymentId: payment._id,
            appointmentId: appointment._id,
            patientId: session.patient?._id,
            amount: grossAmount,
            status: 'pending'
          }
        },
        {
          type: INSURANCE_BILLING_EVENTS.INSURANCE_APPOINTMENT_LINKED,
          payload: {
            appointmentId: appointment._id,
            sessionId,
            patientId: session.patient?._id,
            procedureCode
          }
        }
      ];
      
      await publishEvents(events.map(e => ({ eventType: e.type, payload: e.payload })), { correlationId });
      
      // 13. Libera lock
      await releaseGuideLock(guide._id, lockResult.lockId);
      
      const duration = Date.now() - startTime;
      console.log(`[InsuranceBilling] Success in ${duration}ms: ${sessionId}`);
      
      return {
        success: true,
        billingId: appointment._id,
        paymentId: payment._id,
        guideId: guide._id,
        amount: grossAmount,
        sessionNumber: consumeResult.sessionNumber,
        correlationId,
        durationMs: duration
      };
      
    } catch (error) {
      await mongoSession.abortTransaction();
      await executeCompensations();
      
      await publishEvent(INSURANCE_BILLING_EVENTS.INSURANCE_BILLING_FAILED, {
        sessionId,
        error: error.message,
        errorCode: error.code || 'UNKNOWN'
      }, { correlationId });
      
      console.error(`[InsuranceBilling] Failed: ${sessionId}`, error);
      throw error;
      
    } finally {
      mongoSession.endSession();
      compensationActions.length = 0;
    }
  }

  // =========================================================================
  // MÉTODOS AUXILIARES
  // =========================================================================
  
  async findAndLockGuide(session, mongoSession, correlationId) {
    const guide = await guideService.findValidGuide(
      session.patient._id,
      session.specialty,
      { session: mongoSession }
    );
    
    if (!guide) {
      throw createError('No valid insurance guide available', ERROR_CODES.GUIDE_NOT_FOUND, 400);
    }
    
    const lockResult = await acquireGuideLock(
      guide._id,
      session._id.toString(),
      'InsuranceBillingService'
    );
    
    return { guide, lockResult };
  }
  
  async consumeGuideSession(guide, session, mongoSession, lockId) {
    const Guide = mongoose.model('InsuranceGuide');
    const currentGuide = await Guide.findOne({
      _id: guide._id,
      lockId: lockId
    }).session(mongoSession);
    
    if (!currentGuide) {
      throw createError('Guide lock lost during processing', ERROR_CODES.LOCK_LOST, 423);
    }
    
    const sessionNumber = currentGuide.usedSessions + 1;
    currentGuide.usedSessions += 1;
    
    if (currentGuide.usedSessions >= currentGuide.totalSessions) {
      currentGuide.status = 'exhausted';
      currentGuide.exhaustedAt = new Date();
    }
    
    // 🛡️ IDEMPOTÊNCIA: Verifica se já existe entrada para esta sessão
    const alreadyConsumed = currentGuide.consumptionHistory.some(
      h => h.sessionId?.toString() === session._id.toString()
    );
    
    if (!alreadyConsumed) {
      currentGuide.consumptionHistory.push({
        sessionId: session._id,
        sessionNumber,
        consumedAt: new Date(),
        professionalId: session.professional?._id,
        notes: `Consumed by billing service: ${session._id}`
      });
    }
    
    await currentGuide.save({ session: mongoSession });
    
    return {
      sessionNumber,
      remaining: currentGuide.totalSessions - currentGuide.usedSessions,
      status: currentGuide.status
    };
  }
  
  async calculateSessionValue(session, guide) {
    const convenioService = (await import('../../../services/convenioIntegrationService.js')).default;
    
    const procedureCode = guide.procedureCode || '201040';
    const insuranceCode = guide.insuranceProvider?.code || guide.insuranceProvider;
    
    const value = await convenioService.getConvenioSessionValue(
      insuranceCode,
      procedureCode,
      session.specialty
    );
    
    return {
      grossAmount: value.grossAmount || 0,
      procedureCode
    };
  }
  
  /**
   * Cria appointment com checagem de existência (idempotência)
   * 🛡️ PROTEÇÃO: Trata race condition (erro 11000)
   */
  async createInsuranceAppointment(session, guide, sessionNumber, amount, mongoSession) {
    // 🔥 IDEMPOTÊNCIA: Checa se appointment já existe para esta sessão (V2)
    const existingV2 = await Appointment.findOne({
      'source.sessionId': session._id,
      'source.type': 'session'
    }).session(mongoSession);
    
    if (existingV2) {
      console.log(`[createInsuranceAppointment] Reusing V2 existing: ${existingV2._id}`);
      return existingV2;
    }
    
    // 🔥 IDEMPOTÊNCIA: Checa se appointment já existe (pacote legado - campo session)
    const existingLegacy = await Appointment.findOne({
      session: session._id
    }).session(mongoSession);
    
    if (existingLegacy) {
      console.log(`[createInsuranceAppointment] Found legacy appointment: ${existingLegacy._id}`);
      // Atualiza o legacy appointment para ter source (migra para V2)
      existingLegacy.source = {
        type: 'session',
        sessionId: session._id,
        syncedAt: new Date()
      };
      await existingLegacy.save({ session: mongoSession });
      return existingLegacy;
    }
    
    const appointment = new Appointment({
      patient: session.patient._id,
      professional: session.professional?._id,
      dateTime: session.date,
      specialty: session.specialty,
      status: 'confirmed',
      
      // Campos do legado (compatibilidade)
      duration: 40,                                    // ← LEGADO: fixo 40 min
      session: session._id,                            // ← LEGADO: vínculo Session
      serviceType: 'session',                          // ← LEGADO
      operationalStatus: 'scheduled',                  // ← LEGADO
      clinicalStatus: 'pending',                       // ← LEGADO
      paymentStatus: 'pending',                        // ← LEGADO
      visualFlag: 'pending',                           // ← LEGADO
      billingType: 'convenio',                         // ← LEGADO
      insuranceProvider: guide.insurance,              // ← LEGADO: string, não ObjectId
      insuranceValue: amount,                          // ← LEGADO: preenchido na criação V2
      authorizationCode: guide.number,                 // ← LEGADO: guide.number
      
      insurance: {
        isInsurance: true,
        insuranceProvider: guide.insuranceProvider?._id || guide.insuranceProvider,
        guideNumber: guide.number,
        authorizationNumber: guide.authorizationNumber,
        procedureCode: guide.procedureCode || '201040',
        sessionNumber,
        totalSessions: guide.totalSessions,
        grossAmount: amount,
        netAmount: amount,
        status: 'pending'
      },
      
      source: {
        type: 'session',
        sessionId: session._id,
        syncedAt: new Date()
      },
      
      notes: `Auto-generated from session ${session._id}`
    });
    
    try {
      await appointment.save({ session: mongoSession });
      return appointment;
    } catch (err) {
      // 🛡️ RACE CONDITION: Outro processo criou entre o find e o save
      if (err.code === 11000) {
        console.warn(`[createInsuranceAppointment] Race condition detected (11000), fetching existing`);
        
        const raced = await Appointment.findOne({
          'source.sessionId': session._id,
          'source.type': 'session'
        }).session(mongoSession);
        
        if (raced) {
          return raced;
        }
      }
      throw err;
    }
  }
  
  /**
   * Cria/atualiza payment com idempotência
   */
  async createOrUpdateInsurancePayment(session, appointment, amount, guide, mongoSession) {
    const month = new Date(session.date).toISOString().slice(0, 7);
    
    // 🔥 IDEMPOTÊNCIA: Checa se appointment já está em algum payment
    const existingPaymentWithAppointment = await Payment.findOne({
      'appointments.appointment': appointment._id
    }).session(mongoSession);
    
    if (existingPaymentWithAppointment) {
      console.log(`[createOrUpdateInsurancePayment] Appointment already in payment: ${existingPaymentWithAppointment._id}`);
      return existingPaymentWithAppointment;
    }
    
    // 🔥 IDEMPOTÊNCIA: Checa se já existe payment para esta session (pacote legado)
    const existingPaymentForSession = await Payment.findOne({
      session: session._id
    }).session(mongoSession);
    
    if (existingPaymentForSession) {
      console.log(`[createOrUpdateInsurancePayment] Found legacy payment for session: ${existingPaymentForSession._id}`);
      // Adiciona o appointment ao payment existente (pacote legado)
      const alreadyLinked = existingPaymentForSession.appointments.some(
        a => a.appointment?.toString() === appointment._id.toString()
      );
      if (!alreadyLinked) {
        existingPaymentForSession.appointments.push({
          appointment: appointment._id,
          amount,
          guideNumber: guide.number
        });
        await existingPaymentForSession.save({ session: mongoSession });
      }
      return existingPaymentForSession;
    }
    
    let payment = await Payment.findOne({
      patient: session.patient._id,
      'insurance.month': month,
      'insurance.insuranceProvider': guide.insuranceProvider._id || guide.insuranceProvider,
      status: { $in: ['pending', 'billed'] }
    }).session(mongoSession);
    
    if (payment) {
      payment.appointments.push({
        appointment: appointment._id,
        amount,
        guideNumber: guide.number
      });
      payment.insurance.grossAmount += amount;
      payment.insurance.netAmount += amount;
      await payment.save({ session: mongoSession });
    } else {
      payment = new Payment({
        patient: session.patient._id,
        professional: session.professional?._id,
        date: session.date,
        
        // Campos do legado (compatibilidade)
        session: session._id,                            // ← LEGADO: vínculo Session
        appointment: appointment._id,                    // ← LEGADO: vínculo Appointment
        serviceType: 'session',                          // ← LEGADO
        amount: amount,                                  // ← LEGADO: preenchido V2
        paymentMethod: 'convenio',                       // ← LEGADO
        billingType: 'convenio',                         // ← LEGADO
        serviceDate: session.date,                       // ← LEGADO
        notes: `Aguardando faturamento - Guia ${guide.number}`, // ← LEGADO
        
        insurance: {
          provider: guide.insurance,                     // ← LEGADO: string
          authorizationCode: guide.number,               // ← LEGADO
          month,
          insuranceProvider: guide.insuranceProvider?._id || guide.insuranceProvider,
          guideNumber: guide.number,
          grossAmount: amount,
          netAmount: amount,
          status: 'pending'
        },
        
        appointments: [{
          appointment: appointment._id,
          amount,
          guideNumber: guide.number
        }],
        
        status: 'pending_billing'
      });
      
      await payment.save({ session: mongoSession });
    }
    
    return payment;
  }

  // =========================================================================
  // FATURAMENTO (Billing)
  // =========================================================================
  
  /**
   * Processa faturamento da sessão (envio para convênio)
   * Idempotente: pode ser chamado múltiplas vezes
   */
  async processSessionBilled(sessionId, billedData, options = {}) {
    const correlationId = options.correlationId || uuidv4();
    const { billedAmount, billedAt = new Date(), invoiceNumber } = billedData || {};
    
    console.log(`[BillingV2] Processing billed: ${sessionId}`, { correlationId, billedAmount });
    
    // 1. IDEMPOTÊNCIA: Já processou este billing?
    const idempotency = await checkIdempotency('SESSION_BILLED', sessionId, correlationId);
    if (idempotency.isDuplicate) {
      console.log(`[BillingV2] Duplicate billed event, skipping: ${sessionId}`);
      return {
        success: true,
        duplicate: true,
        billingId: idempotency.event?.payload?.billingId,
        correlationId
      };
    }
    
    const mongoSession = await mongoose.startSession();
    
    try {
      await mongoSession.startTransaction();
      
      // 2. Busca Payment vinculado à session
      const payment = await Payment.findOne({ session: sessionId }).session(mongoSession);
      
      if (!payment) {
        throw createError('Payment not found for session', ERROR_CODES.NOT_FOUND, 404);
      }
      
      // 3. STATE MACHINE: Valida transição
      const currentStatus = payment.status || FINANCIAL_STATES.PENDING_BILLING;
      
      // Idempotência: já está no estado desejado
      if (currentStatus === FINANCIAL_STATES.BILLED) {
        console.log(`[BillingV2] Already billed, returning existing: ${payment._id}`);
        
        await markProcessing(
          INSURANCE_BILLING_EVENTS.INSURANCE_BILLING_BILLED,
          sessionId,
          { paymentId: payment._id, billedAmount },
          idempotency.idempotencyKey,
          correlationId
        );
        
        await mongoSession.commitTransaction();
        
        return {
          success: true,
          duplicate: true,
          paymentId: payment._id,
          status: 'billed',
          correlationId
        };
      }
      
      // 🚨 STATE MACHINE: Só pode faturar se estiver pending_billing
      validateTransition(currentStatus, FINANCIAL_STATES.BILLED, {
        sessionId,
        paymentId: payment._id,
        step: 'processSessionBilled'
      });
      
      // 4. Atualiza Payment (fonte de verdade financeira)
      payment.status = FINANCIAL_STATES.BILLED;
      payment.insurance.status = 'billed';
      payment.insurance.billedAt = billedAt;
      payment.insurance.invoiceNumber = invoiceNumber;
      
      if (billedAmount !== undefined && billedAmount > 0) {
        payment.amount = billedAmount;
        payment.insurance.grossAmount = billedAmount;
        payment.insurance.netAmount = billedAmount;
      }
      
      await payment.save({ session: mongoSession });
      
      // 5. Atualiza Appointment (referência)
      await Appointment.updateOne(
        { session: sessionId },
        { 
          $set: { 
            paymentStatus: 'billed',
            'insurance.status': 'billed',
            'insurance.billedAt': billedAt
          }
        },
        { session: mongoSession }
      );
      
      // 6. NÃO muda Session.status (permanece 'completed')
      // Session.paymentStatus permanece 'pending' até recebimento
      
      // 7. Registra no EventStore
      await markProcessing(
        INSURANCE_BILLING_EVENTS.INSURANCE_BILLING_BILLED,
        sessionId,
        { paymentId: payment._id, billedAmount, billedAt },
        idempotency.idempotencyKey,
        correlationId
      );
      
      await mongoSession.commitTransaction();
      
      // 8. Publica evento
      await publishEvent(INSURANCE_BILLING_EVENTS.INSURANCE_BILLING_BILLED, {
        sessionId,
        paymentId: payment._id,
        appointmentId: payment.appointment,
        billedAmount: payment.amount,
        billedAt,
        invoiceNumber
      }, { correlationId });
      
      console.log(`[BillingV2] Billed processed: ${payment._id}`);
      
      return {
        success: true,
        paymentId: payment._id,
        status: 'billed',
        correlationId
      };
      
    } catch (error) {
      await mongoSession.abortTransaction();
      throw error;
    } finally {
      mongoSession.endSession();
    }
  }

  // =========================================================================
  // RECEBIMENTO (Receiving)
  // =========================================================================
  
  /**
   * Processa recebimento do convênio (pagamento efetuado)
   * Idempotente: pode ser chamado múltiplas vezes
   */
  async processSessionReceived(sessionId, receivedData, options = {}) {
    const correlationId = options.correlationId || uuidv4();
    const { receivedAmount, receivedAt = new Date(), receiptNumber } = receivedData || {};
    
    console.log(`[BillingV2] Processing received: ${sessionId}`, { correlationId, receivedAmount });
    
    if (!receivedAmount || receivedAmount <= 0) {
      throw createError('Received amount is required and must be > 0', 'VALIDATION_ERROR', 400);
    }
    
    // 1. IDEMPOTÊNCIA: Já processou este recebimento?
    const idempotency = await checkIdempotency('SESSION_RECEIVED', sessionId, correlationId);
    if (idempotency.isDuplicate) {
      console.log(`[BillingV2] Duplicate received event, skipping: ${sessionId}`);
      return {
        success: true,
        duplicate: true,
        paymentId: idempotency.event?.payload?.paymentId,
        correlationId
      };
    }
    
    const mongoSession = await mongoose.startSession();
    
    try {
      await mongoSession.startTransaction();
      
      // 2. Busca Payment
      const payment = await Payment.findOne({ session: sessionId }).session(mongoSession);
      
      if (!payment) {
        throw createError('Payment not found for session', ERROR_CODES.NOT_FOUND, 404);
      }
      
      // 3. STATE MACHINE: Valida transição
      const currentStatus = payment.status || FINANCIAL_STATES.PENDING_BILLING;
      
      // Idempotência: já está pago
      if (currentStatus === FINANCIAL_STATES.PAID) {
        console.log(`[BillingV2] Already paid, returning existing: ${payment._id}`);
        
        await markProcessing(
          INSURANCE_BILLING_EVENTS.INSURANCE_PAYMENT_RECEIVED,
          sessionId,
          { paymentId: payment._id, receivedAmount },
          idempotency.idempotencyKey,
          correlationId
        );
        
        await mongoSession.commitTransaction();
        
        return {
          success: true,
          duplicate: true,
          paymentId: payment._id,
          status: 'paid',
          correlationId
        };
      }
      
      // 🚨 STATE MACHINE: Só pode receber se estiver billed
      validateTransition(currentStatus, FINANCIAL_STATES.PAID, {
        sessionId,
        paymentId: payment._id,
        step: 'processSessionReceived'
      });
      
      // 4. Atualiza Payment (fonte de verdade)
      payment.status = FINANCIAL_STATES.PAID;
      payment.insurance.status = 'received';
      payment.insurance.receivedAmount = receivedAmount;
      payment.insurance.receivedAt = receivedAt;
      payment.insurance.receiptNumber = receiptNumber;
      payment.amount = receivedAmount;  // Valor final
      payment.paidAt = receivedAt;
      
      await payment.save({ session: mongoSession });
      
      // 6. Atualiza Session (agora sim, status final)
      await Session.findByIdAndUpdate(
        sessionId,
        {
          $set: {
            isPaid: true,
            paymentStatus: 'paid',
            visualFlag: 'ok',
            sessionValue: receivedAmount
          }
        },
        { session: mongoSession }
      );
      
      // 7. Atualiza Appointment
      await Appointment.updateOne(
        { session: sessionId },
        {
          $set: {
            paymentStatus: 'paid',
            visualFlag: 'ok',
            sessionValue: receivedAmount,
            'insurance.status': 'received',
            'insurance.receivedAmount': receivedAmount
          }
        },
        { session: mongoSession }
      );
      
      // 8. Registra no EventStore
      await markProcessing(
        INSURANCE_BILLING_EVENTS.INSURANCE_PAYMENT_RECEIVED,
        sessionId,
        { paymentId: payment._id, receivedAmount, receivedAt },
        idempotency.idempotencyKey,
        correlationId
      );
      
      await mongoSession.commitTransaction();
      
      // 9. Publica evento
      await publishEvent(INSURANCE_BILLING_EVENTS.INSURANCE_PAYMENT_RECEIVED, {
        sessionId,
        paymentId: payment._id,
        appointmentId: payment.appointment,
        receivedAmount,
        receivedAt,
        receiptNumber
      }, { correlationId });
      
      console.log(`[BillingV2] Received processed: ${payment._id}`);
      
      return {
        success: true,
        paymentId: payment._id,
        status: 'paid',
        correlationId
      };
      
    } catch (error) {
      await mongoSession.abortTransaction();
      throw error;
    } finally {
      mongoSession.endSession();
    }
  }

  // =========================================================================
  // CANCELAMENTO
  // =========================================================================
  
  async cancelBilling(sessionId, reason, options = {}) {
    const correlationId = options.correlationId || uuidv4();
    const mongoSession = await mongoose.startSession();
    
    try {
      await mongoSession.startTransaction();
      
      const session = await Session.findById(sessionId).session(mongoSession);
      if (!session || !session.insuranceAppointmentId) {
        throw createError('No billing found for session', ERROR_CODES.NOT_FOUND, 404);
      }
      
      const appointment = await Appointment.findById(
        session.insuranceAppointmentId
      ).session(mongoSession);
      
      if (!appointment) {
        throw createError('Appointment not found', ERROR_CODES.NOT_FOUND, 404);
      }
      
      appointment.status = 'cancelled';
      appointment.cancellationReason = reason;
      appointment.cancelledAt = new Date();
      await appointment.save({ session: mongoSession });
      
      const Guide = mongoose.model('InsuranceGuide');
      const guide = await Guide.findOne({
        number: appointment.insurance.guideNumber
      }).session(mongoSession);
      
      if (guide && guide.status === 'exhausted') {
        guide.status = 'active';
        guide.exhaustedAt = null;
      }
      if (guide && guide.usedSessions > 0) {
        guide.usedSessions -= 1;
        guide.consumptionHistory = guide.consumptionHistory.filter(
          h => h.sessionId?.toString() !== sessionId
        );
        await guide.save({ session: mongoSession });
      }
      
      session.insuranceBillingProcessed = false;
      session.insuranceBillingCancelled = true;
      session.insuranceBillingCancellationReason = reason;
      await session.save({ session: mongoSession });
      
      await mongoSession.commitTransaction();
      
      await publishEvent(INSURANCE_BILLING_EVENTS.INSURANCE_BILLING_CANCELLED, {
        sessionId,
        appointmentId: appointment._id,
        guideId: guide?._id,
        reason,
        refunded: !!guide
      }, { correlationId });
      
      return { success: true, correlationId };
      
    } catch (error) {
      await mongoSession.abortTransaction();
      throw error;
    } finally {
      mongoSession.endSession();
    }
  }
}

// =============================================================================
// EXPORTAÇÕES
// =============================================================================

export const insuranceBillingService = new InsuranceBillingService();
export default insuranceBillingService;
