// routes/appointment.v2.js
/**
 * 🚀 ROTAS 4.0 - Event-Driven Architecture
 * 
 * Endpoint base: /api/v2/appointments
 * Mensagens padronizadas e tratamento de erros consistente
 */

import express from 'express';
import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { redisConnection } from '../infrastructure/queue/queueConfig.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { checkAppointmentConflicts, getAvailableTimeSlots } from '../middleware/conflictDetection.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import Package from '../models/Package.js';
import PatientsView from '../models/PatientsView.js';
import { Messages, formatSuccess, formatError, ErrorCodes } from '../utils/apiMessages.js';
import { createBusinessError, asyncHandler } from '../middleware/errorHandler.js';

// ======================================================================
// HELPER: Validação segura de datas (igual à V1)
// ======================================================================
function isValidDateString(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const date = new Date(dateStr);
  return !isNaN(date.getTime());
}

const router = express.Router();

/**
 * 🎯 POST /api/v2/appointments - Criar agendamento (Async)
 */
router.post('/', flexibleAuth, checkAppointmentConflicts, asyncHandler(async (req, res) => {
  const mongoSession = await mongoose.startSession();
  
  try {
    await mongoSession.startTransaction();

    const {
      patientId,
      doctorId,
      date,
      time,
      specialty = 'fonoaudiologia',
      serviceType = 'session',
      sessionType = null,
      packageId = null,
      insuranceGuideId = null,
      paymentMethod = 'dinheiro',
      amount = 0,
      paymentAmount = null, // Frontend envia paymentAmount
      notes = '',
      // ROI / origem
      leadId = null,
      source = null,
      preAgendamentoId = null,
      // Convênio extra
      insuranceProvider = null,
      insuranceValue = null,
      authorizationCode = null,
    } = req.body;
    
    // 🔄 MAPEAMENTO: paymentAmount (frontend) → amount (backend)
    const finalAmount = paymentAmount !== null ? parseFloat(paymentAmount) : (amount || 0);
    
    console.log(`[POST /v2/appointments] 💰 Valor recebido:`, {
      amount,
      paymentAmount,
      finalAmount
    });

    // Validações com mensagens claras
    if (!patientId) {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.VALIDATION.PATIENT_REQUIRED, 400, ErrorCodes.MISSING_REQUIRED_FIELD,
        { field: 'patientId' }
      );
    }

    if (!doctorId) {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.VALIDATION.DOCTOR_REQUIRED, 400, ErrorCodes.MISSING_REQUIRED_FIELD,
        { field: 'doctorId' }
      );
    }

    if (!date) {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.VALIDATION.DATE_REQUIRED, 400, ErrorCodes.MISSING_REQUIRED_FIELD,
        { field: 'date' }
      );
    }

    if (!time) {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.VALIDATION.TIME_REQUIRED, 400, ErrorCodes.MISSING_REQUIRED_FIELD,
        { field: 'time' }
      );
    }

    // 🛡️ VALIDAÇÃO CONVÊNIO: Guia obrigatória e válida
    const billingType = req.body.billingType || (insuranceGuideId ? 'convenio' : 'particular');
    
    if (billingType === 'convenio' || insuranceGuideId) {
      if (!insuranceGuideId) {
        await mongoSession.abortTransaction();
        throw createBusinessError('Guia de convênio é obrigatória para agendamentos de convênio', 400, ErrorCodes.MISSING_REQUIRED_FIELD,
          { field: 'insuranceGuideId' }
        );
      }
      
      // Verifica se guia existe e está ativa
      const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
      const guide = await InsuranceGuide.findById(insuranceGuideId).session(mongoSession);
      
      if (!guide) {
        await mongoSession.abortTransaction();
        throw createBusinessError('Guia de convênio não encontrada', 404, ErrorCodes.NOT_FOUND,
          { field: 'insuranceGuideId', value: insuranceGuideId }
        );
      }
      
      if (guide.status === 'canceled' || guide.status === 'expired') {
        await mongoSession.abortTransaction();
        throw createBusinessError(`Guia de convênio está ${guide.status === 'canceled' ? 'cancelada' : 'expirada'}`, 400, ErrorCodes.BUSINESS_RULE_VIOLATION,
          { field: 'insuranceGuideId', status: guide.status }
        );
      }
      
      if (guide.usedSessions >= guide.totalSessions) {
        await mongoSession.abortTransaction();
        throw createBusinessError('Guia de convênio esgotada (sem sessões disponíveis)', 422, ErrorCodes.INSUFFICIENT_CREDIT,
          { 
            field: 'insuranceGuideId', 
            used: guide.usedSessions, 
            total: guide.totalSessions 
          }
        );
      }
      
      // Verifica se paciente da guia bate com o do agendamento
      if (guide.patient?.toString() !== patientId?.toString()) {
        await mongoSession.abortTransaction();
        throw createBusinessError('Guia de convênio não pertence a este paciente', 400, ErrorCodes.BUSINESS_RULE_VIOLATION,
          { field: 'insuranceGuideId' }
        );
      }
      
      console.log(`[Create] ✅ Guia ${insuranceGuideId} validada: ${guide.usedSessions}/${guide.totalSessions} sessões`);
    }

    // 1. Cria Appointment com status de processamento
    const appointment = new Appointment({
      patient: patientId,
      doctor: doctorId,
      date,
      time,
      specialty,
      serviceType,
      sessionType: sessionType || specialty,
      package: packageId,
      insuranceGuide: insuranceGuideId,

      operationalStatus: 'processing_create',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',

      sessionValue: finalAmount,  // Model usa sessionValue (padrão do projeto)
      paymentMethod,
      billingType: billingType || (insuranceGuideId ? 'convenio' : 'particular'),

      // Convênio extras
      ...(insuranceProvider && { insuranceProvider }),
      ...(insuranceValue != null && { insuranceValue }),
      ...(authorizationCode && { authorizationCode }),

      notes,
      createdBy: req.user?._id,

      // Metadata ROI
      metadata: {
        origin: {
          source: source || 'crm',
          preAgendamentoId: preAgendamentoId || null,
          leadId: leadId || null,
        }
      },

      history: [{
        action: 'create_requested',
        newStatus: 'processing_create',
        changedBy: req.user?._id,
        timestamp: new Date(),
        context: 'Criação via 4.0'
      }]
    });

    await appointment.save({ session: mongoSession });

    const idempotencyKey = `${appointment._id}_create`;

    await mongoSession.commitTransaction();
    
    console.log(`[POST /v2/appointments] ✅ Transaction commitada`);
    console.log(`   Appointment ID: ${appointment._id}`);
    console.log(`   Status: ${appointment.operationalStatus}`);

    // 4. Publica evento
    console.log(`[POST /v2/appointments] 📤 Publicando evento...`);
    
    const eventResult = await publishEvent(
      EventTypes.APPOINTMENT_CREATE_REQUESTED,
      {
        appointmentId: appointment._id.toString(),
        patientId: patientId?.toString(),
        doctorId: doctorId?.toString(),
        date,
        time,
        specialty,
        serviceType,
        sessionType: sessionType || specialty,
        packageId: packageId?.toString() || null,
        insuranceGuideId: insuranceGuideId?.toString() || null,
        amount: finalAmount,
        paymentMethod,
        billingType: billingType || (insuranceGuideId ? 'convenio' : 'particular'),
        notes,
        // ROI / origem — worker usa para journey followups
        leadId: leadId?.toString() || null,
        source: source || 'crm',
        preAgendamentoId: preAgendamentoId?.toString() || null,
        userId: req.user?._id?.toString()
      },
      {
        correlationId: appointment._id.toString(),
        idempotencyKey
      }
    );
    
    console.log(`[POST /v2/appointments] ✅ Evento publicado!`);
    console.log(`   Event ID: ${eventResult.eventId}`);
    console.log(`   Queue: ${eventResult.queue}`);
    console.log(`   Job ID: ${eventResult.jobId}`);

    // 5. Retorna 202 com mensagem clara
    res.status(202).json(
      formatSuccess(
        {
          appointmentId: appointment._id.toString(),
          status: 'processing_create',
          correlationId: eventResult.correlationId,
          idempotencyKey: eventResult.idempotencyKey,
          eventId: eventResult.eventId
        },
        {
          message: Messages.PROCESSING.CREATE,
          processing: 'async',
          estimatedTime: '1-3s',
          checkStatus: `GET /api/v2/appointments/${appointment._id}/status`
        }
      )
    );

  } catch (error) {
    if (mongoSession.transaction.state !== 'TRANSACTION_ABORTED' && 
        mongoSession.transaction.state !== 'TRANSACTION_COMMITTED') {
      await mongoSession.abortTransaction();
    }
    throw error;
  } finally {
    mongoSession.endSession();
  }
}));

/**
 * 🎯 PATCH /api/v2/appointments/:id/cancel - Cancelar (Async)
 */
router.patch('/:id/cancel', flexibleAuth, asyncHandler(async (req, res) => {
  const mongoSession = await mongoose.startSession();

  try {
    await mongoSession.startTransaction();

    const { id } = req.params;
    const { reason, confirmedAbsence = false } = req.body;

    if (!reason) {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.VALIDATION.REASON_REQUIRED, 400, ErrorCodes.MISSING_REQUIRED_FIELD,
        { field: 'reason' }
      );
    }

    const appointment = await Appointment.findById(id).session(mongoSession);

    if (!appointment) {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.BUSINESS.APPOINTMENT_NOT_FOUND, 404, ErrorCodes.NOT_FOUND
      );
    }

    // Guards com mensagens claras
    if (appointment.operationalStatus === 'processing_cancel') {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.BUSINESS.ALREADY_PROCESSING_CANCEL, 409, ErrorCodes.ALREADY_PROCESSING,
        { status: 'processing_cancel' }
      );
    }

    if (appointment.operationalStatus === 'canceled') {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.BUSINESS.ALREADY_CANCELED, 409, ErrorCodes.CONFLICT_STATE
      );
    }

    if (appointment.clinicalStatus === 'completed') {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.BUSINESS.CANNOT_CANCEL_COMPLETED, 409, ErrorCodes.CONFLICT_STATE
      );
    }

    // Marca como processando
    appointment.operationalStatus = 'processing_cancel';
    appointment.history.push({
      action: 'cancel_requested',
      newStatus: 'processing_cancel',
      changedBy: req.user?._id,
      timestamp: new Date(),
      context: `Motivo: ${reason}`
    });

    await appointment.save({ session: mongoSession });

    const idempotencyKey = `${id}_cancel`;

    await mongoSession.commitTransaction();

    // Publica evento
    const eventResult = await publishEvent(
      EventTypes.APPOINTMENT_CANCEL_REQUESTED,
      {
        appointmentId: id,
        patientId: appointment.patient?.toString(),
        packageId: appointment.package?.toString(),
        reason,
        confirmedAbsence,
        userId: req.user?._id?.toString()
      },
      {
        correlationId: id,
        idempotencyKey
      }
    );

    res.status(202).json(
      formatSuccess(
        {
          appointmentId: id,
          status: 'processing_cancel',
          correlationId: eventResult.correlationId,
          idempotencyKey: eventResult.idempotencyKey
        },
        {
          message: Messages.PROCESSING.CANCEL,
          processing: 'async',
          checkStatus: `GET /api/v2/appointments/${id}/status`
        }
      )
    );

  } catch (error) {
    if (mongoSession.transaction.state !== 'TRANSACTION_ABORTED' && 
        mongoSession.transaction.state !== 'TRANSACTION_COMMITTED') {
      await mongoSession.abortTransaction();
    }
    throw error;
  } finally {
    mongoSession.endSession();
  }
}));

/**
 * 🔓 Helper: Verifica se existe job ativo na fila complete-orchestrator
 */
async function hasActiveJobInQueue(appointmentId) {
  try {
    const queue = new Queue('complete-orchestrator', { connection: redisConnection });
    const jobs = await queue.getJobs(['waiting', 'active', 'delayed']);
    return jobs.some(job => job.data?.payload?.appointmentId === appointmentId);
  } catch (error) {
    console.error('[hasActiveJobInQueue] Erro ao verificar fila:', error.message);
    return false; // Se não conseguir verificar, assume que não tem job
  }
}

/**
 * 🎯 PATCH /api/v2/appointments/:id/complete - Completar (Async)
 */
router.patch('/:id/complete', flexibleAuth, asyncHandler(async (req, res) => {
  const mongoSession = await mongoose.startSession();

  try {
    await mongoSession.startTransaction();

    const { id } = req.params;
    const { addToBalance = false, balanceAmount = 0, balanceDescription = '' } = req.body;

    const appointment = await Appointment.findById(id).session(mongoSession);

    if (!appointment) {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.BUSINESS.APPOINTMENT_NOT_FOUND, 404, ErrorCodes.NOT_FOUND
      );
    }

    // Guards - Verifica se está em processamento E se tem job ativo na fila
    if (appointment.operationalStatus === 'processing_complete') {
      // 🔴 VERIFICA SE TEM JOB ATIVO NA FILA - se não tiver, libera o lock automaticamente
      const hasActiveJob = await hasActiveJobInQueue(id);
      
      if (hasActiveJob) {
        await mongoSession.abortTransaction();
        throw createBusinessError(Messages.BUSINESS.ALREADY_PROCESSING_COMPLETE, 409, ErrorCodes.ALREADY_PROCESSING,
          { status: 'processing_complete', hasActiveJob: true }
        );
      } else {
        // Não tem job ativo - provavelmente o worker falhou ou foi reiniciado
        // Libera o lock automaticamente e continua o processamento
        console.log(`[complete] 🔓 Lock obsoleto detectado para ${id}, liberando automaticamente...`);
        appointment.operationalStatus = 'scheduled';
        appointment.history.push({
          action: 'auto_release_stale_lock',
          previousStatus: 'processing_complete',
          newStatus: 'scheduled',
          timestamp: new Date(),
          context: 'Lock liberado automaticamente - nenhum job ativo na fila'
        });
        await appointment.save({ session: mongoSession });
        // Continua o processamento normalmente...
      }
    }

    if (appointment.clinicalStatus === 'completed') {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.BUSINESS.ALREADY_COMPLETED, 409, ErrorCodes.CONFLICT_STATE,
        { idempotent: true }
      );
    }

    if (appointment.operationalStatus === 'canceled') {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.BUSINESS.CANNOT_COMPLETE_CANCELED, 409, ErrorCodes.CONFLICT_STATE
      );
    }

    // Marca como processando
    appointment.operationalStatus = 'processing_complete';
    appointment.history.push({
      action: 'complete_requested',
      newStatus: 'processing_complete',
      changedBy: req.user?._id,
      timestamp: new Date(),
      context: addToBalance ? `Fiado: ${balanceAmount}` : 'Complete normal'
    });

    await appointment.save({ session: mongoSession });

    const idempotencyKey = `${id}_complete_${addToBalance ? 'balance' : 'normal'}`;

    await mongoSession.commitTransaction();

    // Publica evento
    const eventResult = await publishEvent(
      EventTypes.APPOINTMENT_COMPLETE_REQUESTED,
      {
        appointmentId: id,
        patientId: appointment.patient?._id?.toString(),
        doctorId: appointment.doctor?._id?.toString(),
        packageId: appointment.package?._id?.toString(),
        sessionId: appointment.session?._id?.toString(),
        addToBalance,
        balanceAmount: balanceAmount || appointment.sessionValue,
        balanceDescription,
        userId: req.user?._id?.toString()
      },
      {
        correlationId: id,
        idempotencyKey
      }
    );

    res.status(202).json(
      formatSuccess(
        {
          appointmentId: id,
          status: 'processing_complete',
          correlationId: eventResult.correlationId,
          idempotencyKey: eventResult.idempotencyKey,
          lockReleased: appointment.operationalStatus === 'scheduled' // Indica se o lock foi liberado automaticamente
        },
        {
          message: Messages.PROCESSING.COMPLETE,
          processing: 'async',
          checkStatus: `GET /api/v2/appointments/${id}/status`
        }
      )
    );

  } catch (error) {
    // Só aborta se a transação ainda estiver ativa
    if (mongoSession.transaction.state !== 'TRANSACTION_ABORTED' && 
        mongoSession.transaction.state !== 'TRANSACTION_COMMITTED') {
      await mongoSession.abortTransaction();
    }
    throw error;
  } finally {
    mongoSession.endSession();
  }
}));

/**
 * 🎯 GET /api/v2/appointments - Listar agendamentos
 * 
 * Query params: startDate, endDate, patientId, doctorId, status
 */

/**
 * GET /api/v2/appointments/available-slots
 * Slots disponíveis — mesma lógica da V1
 */
router.get('/available-slots', flexibleAuth, getAvailableTimeSlots);

router.get('/', flexibleAuth, asyncHandler(async (req, res) => {
  const { 
    startDate, 
    endDate, 
    patientId, 
    doctorId,
    status,
    page = 1,
    limit = 100,
    light = 'false'  // 🆕 NOVO: Modo light para calendário (menos dados)
  } = req.query;
  
  console.log(`[GET /v2/appointments] Listando agendamentos`, { startDate, endDate, status, light, patientId, doctorId });
  
  // Build filter
  const filter = {};
  
  if (startDate && endDate) {
    // Suporta BSON Date (migrados) e string (legados) simultaneamente
    filter.$or = [
      { date: { $gte: new Date(startDate + 'T00:00:00-03:00'), $lte: new Date(endDate + 'T23:59:59-03:00') } },
      { date: { $gte: startDate, $lte: endDate + 'T23:59:59' } }
    ];
  }
  
  // 🆕 Se patientId for fornecido, verifica se é um ID de view ou ID real
  if (patientId) {
    const PatientsView = mongoose.model('PatientsView');
    const patientView = await PatientsView.findById(patientId).lean();
    
    if (patientView) {
      // É um ID de view, usa o patientId real
      console.log(`[GET /v2/appointments] PatientId é de view, usando patientId real: ${patientView.patientId}`);
      filter.patient = new mongoose.Types.ObjectId(patientView.patientId);
    } else {
      // É um ID real de paciente
      filter.patient = new mongoose.Types.ObjectId(patientId);
    }
  }
  
  if (doctorId) filter.doctor = new mongoose.Types.ObjectId(doctorId);
  
  // Status filter
  if (status) {
    if (status === 'completed') {
      filter.operationalStatus = 'completed';
    } else if (status === 'canceled') {
      filter.operationalStatus = 'canceled';
    } else if (status === 'confirmed') {
      filter.operationalStatus = 'confirmed';
    } else if (status === 'scheduled') {
      filter.operationalStatus = 'scheduled';
    }
  }
  
  const skip = (parseInt(page) - 1) * parseInt(limit);
  
  // 🆕 Build query base
  console.log(`[GET /v2/appointments] Filtro final:`, JSON.stringify(filter));
  
  let query = Appointment.find(filter);
  
  // 🆕 Se light=true, retorna apenas campos essenciais para o calendário
  if (light === 'true') {
    query = query
      .select('date time duration operationalStatus clinicalStatus paymentStatus sessionValue patient doctor billingType insuranceProvider package')
      .populate('patient', 'fullName')
      .populate('doctor', 'fullName specialty')
      .populate('package', 'type sessionValue financialStatus');
  } else {
    // Modo completo (padrão) - Mesmas regras da V1
    query = query
      .populate('patient', 'fullName dateOfBirth phone email')
      .populate('doctor', 'fullName specialty email phoneNumber crm')
      .populate('payment', 'status amount paymentMethod')
      .populate({
        path: 'advancedSessions',
        select: 'date time specialty operationalStatus clinicalStatus',
        populate: {
          path: 'doctor',
          select: 'fullName specialty'
        }
      })
      .populate({
        path: 'history.changedBy',
        select: 'name email role',
        options: { retainNullValues: true }
      })
      .populate({
        path: 'package',
        select: 'sessionType durationMonths sessionsPerWeek totalSessions sessionsDone',
        populate: {
          path: 'sessions',
          select: 'date status isPaid'
        }
      })
      .populate({
        path: 'session',
        select: 'date status isPaid confirmedAbsence paymentStatus sessionValue',
        populate: {
          path: 'package',
          select: 'sessionType durationMonths sessionsPerWeek'
        }
      });
  }
  
  let appointments = await query
    .sort({ date: 1, time: 1 })
    .skip(skip)
    .limit(parseInt(limit))
    .lean();
  
  // 🆕 Formatação igual à V1
  appointments = appointments.map(appt => {
    // Formatar sessões adiantadas
    if (appt.advancedSessions) {
      appt.advancedSessions = appt.advancedSessions.map(session => ({
        ...session,
        formattedDate: session.date && isValidDateString(session.date)
          ? new Date(session.date).toLocaleDateString('pt-BR')
          : 'Data não disponível',
        formattedTime: session.time || '--:--',
      }));
    }

    return {
      ...appt,
      paymentStatus: appt.package
        ? (appt.paymentStatus || 'package_paid')
        : (appt.paymentStatus === 'paid' ? 'paid' : appt.paymentStatus || 'pending'),
      source: appt.package ? 'package' : 'individual'
    };
  });
  
  const total = await Appointment.countDocuments(filter);
  
  console.log(`[GET /v2/appointments] Encontrados: ${appointments.length} de ${total}`);
  
  res.json(formatSuccess({
    appointments,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  }));
}));

/**
 * 🎯 GET /api/v2/appointments/:id - Buscar agendamento completo
 * 
 * Retorna igual ao legado: Appointment + Session + Payment populados
 */
router.get('/:id', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  console.log(`[GET /v2/appointments/:id] Buscando appointment: ${id}`);
  
  const appointment = await Appointment.findById(id)
    .populate('patient', 'fullName dateOfBirth phone email address healthPlan')
    .populate('doctor', 'fullName specialty email phoneNumber commissionRules')
    .populate('session')
    .populate('package', 'totalSessions sessionsDone totalPaid totalValue financialStatus sessionValue type')
    .populate('payment', 'status amount paymentMethod billingType kind insuranceValue');

  console.log(`[GET /v2/appointments/:id] Resultado:`, appointment ? 'ENCONTRADO' : 'NÃO ENCONTRADO');

  if (!appointment) {
    console.log(`[GET /v2/appointments/:id] Lançando erro 404`);
    throw createBusinessError(Messages.BUSINESS.APPOINTMENT_NOT_FOUND, 404, ErrorCodes.NOT_FOUND
    );
  }

  console.log(`[GET /v2/appointments/:id] Retornando sucesso`);
  res.json(formatSuccess({ appointment }));
}));

/**
 * 🎯 GET /api/v2/appointments/:id/status - Consultar status (Polling)
 */
router.get('/:id/status', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const appointment = await Appointment.findById(id)
    .select('operationalStatus clinicalStatus paymentStatus session package patient correlationId canceledReason');

  if (!appointment) {
    throw createBusinessError(Messages.BUSINESS.APPOINTMENT_NOT_FOUND, 404, ErrorCodes.NOT_FOUND
    );
  }

  const isProcessing =
    appointment.operationalStatus === 'processing_create' ||
    appointment.operationalStatus === 'processing_cancel' ||
    appointment.operationalStatus === 'processing_complete';

  // Estados terminais positivos (worker concluiu com sucesso)
  // 🚨 IMPORTANTE: Não pode estar em processamento!
  const isResolved =
    !isProcessing && (
      appointment.operationalStatus === 'scheduled' ||
      appointment.operationalStatus === 'confirmed' ||
      appointment.operationalStatus === 'paid' ||
      appointment.operationalStatus === 'missed' ||
      appointment.operationalStatus === 'completed' ||
      appointment.clinicalStatus === 'completed'
    );

  const statusMessages = {
    'processing_create':  Messages.PROCESSING?.CREATE  || 'Criando agendamento...',
    'processing_cancel':  Messages.PROCESSING?.CANCEL  || 'Cancelando...',
    'processing_complete':Messages.PROCESSING?.COMPLETE|| 'Completando sessão...',
    'scheduled':  'Agendamento confirmado',
    'confirmed':  'Agendamento confirmado pelo profissional',
    'paid':       'Agendamento pago',
    'missed':     'Paciente faltou',
    'completed':  'Sessão completada',
    'canceled':   'Agendamento cancelado',
  };

  res.json(
    formatSuccess(
      {
        appointmentId: id,
        operationalStatus: appointment.operationalStatus,
        clinicalStatus: appointment.clinicalStatus,
        paymentStatus: appointment.paymentStatus,
        statusMessage: statusMessages[appointment.operationalStatus] || appointment.operationalStatus,
        isProcessing,
        isResolved,   // ← front usa isso para saber que pode parar o polling
        isCompleted: appointment.clinicalStatus === 'completed' || appointment.operationalStatus === 'completed',
        isCanceled: appointment.operationalStatus === 'canceled',
        canCancel: 
          appointment.operationalStatus !== 'canceled' &&
          appointment.clinicalStatus !== 'completed' &&
          !isProcessing,
        canComplete:
          appointment.operationalStatus !== 'canceled' &&
          appointment.clinicalStatus !== 'completed' &&
          !isProcessing,
        canceledReason: appointment.canceledReason,
        correlationId: appointment.correlationId,
        hasSession: !!appointment.session,
        hasPackage: !!appointment.package
      },
      isProcessing ? {
        message: Messages.INFO.ASYNC_PROCESSING,
        retryIn: '2s'
      } : {}
    )
  );
}));

/**
 * 🧪 DEBUG: GET /api/v2/appointments/:id/process-manual
 * 
 * Endpoint para testar o processamento manual (sem worker)
 * Usar apenas em desenvolvimento!
 */
router.get('/:id/process-manual', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  console.log(`[DEBUG] Processamento manual solicitado: ${id}`);
  
  const appointment = await Appointment.findById(id);
  
  if (!appointment) {
    throw createBusinessError('Agendamento não encontrado', 404, ErrorCodes.NOT_FOUND);
  }
  
  // Se não tem sessão, cria
  if (!appointment.session) {
    const Session = (await import('../models/Session.js')).default;
    
    const session = new Session({
      patient: appointment.patient,
      doctor: appointment.doctor,
      appointment: appointment._id,
      date: appointment.date,
      time: appointment.time,
      specialty: appointment.specialty,
      status: 'scheduled',
      paymentStatus: 'pending',
      isPaid: false
    });
    
    await session.save();
    
    appointment.session = session._id;
    appointment.operationalStatus = 'scheduled';
    appointment.paymentStatus = 'pending';
    appointment.history.push({
      action: 'session_created_manual',
      newStatus: 'scheduled',
      timestamp: new Date(),
      context: 'Processamento manual via endpoint debug'
    });
    
    await appointment.save();
    
    console.log(`[DEBUG] ✅ Session criada: ${session._id}`);
    
    return res.json(formatSuccess({
      appointmentId: id,
      sessionId: session._id,
      status: 'scheduled',
      message: 'Sessão criada manualmente (DEBUG)'
    }));
  }
  
  // Se já tem sessão, completa
  const Session = (await import('../models/Session.js')).default;
  const session = await Session.findById(appointment.session);
  
  if (session && session.status !== 'completed') {
    session.status = 'completed';
    session.isPaid = true;
    session.paymentStatus = 'paid';
    session.paidAt = new Date();
    session.visualFlag = 'ok';
    await session.save();
    
    appointment.operationalStatus = 'confirmed';
    appointment.clinicalStatus = 'completed';
    appointment.paymentStatus = 'paid';
    appointment.history.push({
      action: 'complete_manual',
      newStatus: 'confirmed',
      timestamp: new Date(),
      context: 'Complete manual via endpoint debug'
    });
    
    await appointment.save();
    
    console.log(`[DEBUG] ✅ Sessão completada: ${session._id}`);
    
    return res.json(formatSuccess({
      appointmentId: id,
      sessionId: session._id,
      status: 'confirmed',
      message: 'Sessão completada manualmente (DEBUG)'
    }));
  }
  
  res.json(formatSuccess({
    appointmentId: id,
    status: appointment.operationalStatus,
    message: 'Nada a fazer - já processado'
  }));
}));

/**
 * 🧪 DEBUG: GET /api/v2/appointments/:id/complete-manual
 * 
 * Completa o agendamento manualmente (sem worker)
 */
router.get('/:id/complete-manual', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  console.log(`[DEBUG] Complete manual: ${id}`);
  
  const appointment = await Appointment.findById(id);
  
  if (!appointment) {
    throw createBusinessError('Agendamento não encontrado', 404, ErrorCodes.NOT_FOUND);
  }
  
  if (!appointment.session) {
    throw createBusinessError('Agendamento sem sessão', 400, ErrorCodes.BUSINESS_RULE_VIOLATION);
  }
  
  const Session = (await import('../models/Session.js')).default;
  const sessionId = appointment.session._id || appointment.session;
  const session = await Session.findById(sessionId);
  
  if (!session) {
    throw createBusinessError('Sessão não encontrada', 404, ErrorCodes.NOT_FOUND);
  }
  
  // Completa sessão
  session.status = 'completed';
  session.isPaid = true;
  session.paymentStatus = 'paid';
  session.paidAt = new Date();
  session.visualFlag = 'ok';
  await session.save();
  
  // Atualiza appointment
  appointment.operationalStatus = 'confirmed';
  appointment.clinicalStatus = 'completed';
  appointment.paymentStatus = 'paid';
  appointment.history.push({
    action: 'complete_manual',
    newStatus: 'confirmed',
    timestamp: new Date(),
    context: 'Complete manual via endpoint debug'
  });
  
  await appointment.save();
  
  console.log(`[DEBUG] ✅ Complete manual OK`);
  
  res.json(formatSuccess({
    appointmentId: id,
    sessionId: session._id,
    status: 'confirmed',
    message: 'Agendamento completado manualmente (DEBUG)'
  }));
}));

/**
 * 🧪 DEBUG: GET /api/v2/appointments/debug/queues
 * 
 * Verifica status das filas BullMQ
 */
router.get('/debug/queues', flexibleAuth, asyncHandler(async (req, res) => {
  const { getQueue } = await import('../infrastructure/queue/queueConfig.js');
  
  const queues = [
    'appointment-processing',
    'payment-processing',
    'cancel-orchestrator',
    'complete-orchestrator',
    'package-projection',
    'billing-orchestrator',
    'clinical-orchestrator'
  ];
  
  const status = {};
  
  for (const name of queues) {
    try {
      const queue = getQueue(name);
      const [waiting, active, completed, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount()
      ]);
      
      status[name] = { waiting, active, completed, failed };
    } catch (err) {
      status[name] = { error: err.message };
    }
  }
  
  res.json(formatSuccess({
    queues: status,
    message: 'Status das filas BullMQ'
  }));
}));

/**
 * 🎯 PUT /api/v2/appointments/:id - Atualizar agendamento (Sync)
 * 
 * Regras V2 (baseado no V1):
 * - Atualiza appointment, session e payment relacionados
 * - Se mudar data/hora → reagenda (atualiza session)
 * - Se mudar médico → atualiza patient.doctor
 * - Se receber dados de pagamento sem ter payment → cria novo
 */
router.put('/:id', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const mongoSession = await mongoose.startSession();
  let transactionCommitted = false;
  
  try {
    await mongoSession.startTransaction();
    
    // 1. Buscar agendamento
    const appointment = await Appointment.findById(id).session(mongoSession)
      .populate('session payment package');
    
    if (!appointment) {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.APPOINTMENT.NOT_FOUND, 404, ErrorCodes.NOT_FOUND);
    }
    
    // 2. Verificar permissões (médico só edita o próprio)
    if (req.user.role === 'doctor' && appointment.doctor.toString() !== req.user.id) {
      await mongoSession.abortTransaction();
      throw createBusinessError('Acesso não autorizado', 403, ErrorCodes.UNAUTHORIZED);
    }
    
    const updateData = {
      ...req.body,
      doctor: req.body.doctorId || appointment.doctor,
      updatedAt: new Date()
    };
    
    // 3. Atualizar appointment
    Object.assign(appointment, updateData);
    await appointment.validate();
    const updatedAppointment = await appointment.save({ session: mongoSession });
    
    // 4. Atualizar documentos relacionados
    const updatePromises = [];
    
    // Atualizar Session se existir
    if (appointment.session) {
      const sessionUpdate = Session.findByIdAndUpdate(
        appointment.session,
        {
          $set: {
            date: updateData.date || appointment.date,
            time: updateData.time || appointment.time,
            doctor: updateData.doctor || appointment.doctor,
            sessionType: updateData.sessionType || appointment.sessionType,
            sessionValue: updateData.paymentAmount || appointment.paymentAmount,
            notes: updateData.notes || appointment.notes,
            status: updateData.sessionStatus || updateData.operationalStatus || appointment.operationalStatus,
            updatedAt: new Date()
          }
        },
        { session: mongoSession, new: true }
      );
      updatePromises.push(sessionUpdate);
    }
    
    // Atualizar ou Criar Pagamento (somente se NÃO for pacote)
    if (!appointment.package && appointment.payment) {
      const paymentUpdate = Payment.findByIdAndUpdate(
        appointment.payment,
        {
          $set: {
            doctor: updateData.doctor || appointment.doctor,
            amount: (updateData.amount ?? updateData.paymentAmount ?? appointment.paymentAmount),
            paymentMethod: updateData.paymentMethod || appointment.paymentMethod,
            serviceDate: updateData.date || appointment.date,
            serviceType: updateData.serviceType || appointment.serviceType,
            billingType: updateData.billingType || appointment.billingType || 'particular',
            insuranceProvider: updateData.insuranceProvider || appointment.insuranceProvider,
            insuranceValue: updateData.insuranceValue || appointment.insuranceValue,
            authorizationCode: updateData.authorizationCode || appointment.authorizationCode,
            updatedAt: new Date()
          }
        },
        { session: mongoSession, new: true }
      );
      updatePromises.push(paymentUpdate);
    } else if (!appointment.package && (updateData.billingType || updateData.paymentAmount > 0)) {
      // Criar novo pagamento
      const newPayment = new Payment({
        patient: appointment.patient,
        doctor: updateData.doctor || appointment.doctor,
        appointment: appointment._id,
        amount: updateData.paymentAmount || 0,
        paymentMethod: updateData.paymentMethod || 'dinheiro',
        serviceDate: updateData.date || appointment.date,
        serviceType: updateData.serviceType || appointment.serviceType,
        billingType: updateData.billingType || 'particular',
        insuranceProvider: updateData.billingType === 'convenio' ? updateData.insuranceProvider : null,
        insuranceValue: updateData.billingType === 'convenio' ? updateData.insuranceValue : 0,
        authorizationCode: updateData.billingType === 'convenio' ? updateData.authorizationCode : null,
        status: updateData.billingType === 'convenio' ? 'pending' : 'paid',
        kind: 'manual',
        notes: `Pagamento registrado via edição V2 - ${new Date().toLocaleString('pt-BR')}`
      });
      
      await newPayment.save({ session: mongoSession });
      appointment.payment = newPayment._id;
      appointment.paymentStatus = updateData.billingType === 'convenio' ? 'pending' : 'paid';
      await appointment.save({ session: mongoSession });
    }
    
    // Atualizar Pacote se for sessão de pacote
    if (appointment.package && appointment.serviceType === 'package_session') {
      const packageUpdate = Package.findByIdAndUpdate(
        appointment.package,
        {
          $set: {
            doctor: updateData.doctor || appointment.doctor,
            sessionValue: updateData.paymentAmount || appointment.paymentAmount,
            updatedAt: new Date()
          }
        },
        { session: mongoSession, new: true }
      );
      updatePromises.push(packageUpdate);
    }
    
    // Atualizar Paciente se o médico foi alterado
    if (req.body.doctorId && appointment.doctor.toString() !== req.body.doctorId) {
      const patientUpdate = Patient.findByIdAndUpdate(
        appointment.patient,
        {
          $set: {
            doctor: req.body.doctorId,
            updatedAt: new Date()
          }
        },
        { session: mongoSession, new: true }
      );
      updatePromises.push(patientUpdate);
    }
    
    await Promise.all(updatePromises);
    await mongoSession.commitTransaction();
    transactionCommitted = true;  // ✅ Marca como commitado
    
    // Publicar evento de atualização
    await publishEvent(EventTypes.APPOINTMENT_UPDATED, {
      appointmentId: updatedAppointment._id,
      patientId: updatedAppointment.patient,
      doctorId: updatedAppointment.doctor,
      changes: Object.keys(updateData),
      previousDate: appointment.date,
      newDate: updateData.date,
      previousTime: appointment.time,
      newTime: updateData.time,
      updatedBy: req.user._id,
      timestamp: new Date()
    });
    
    res.json(formatSuccess({
      appointment: updatedAppointment,
      message: 'Agendamento atualizado com sucesso'
    }));
    
  } catch (error) {
    // ✅ Só aborta se a transação não foi commitada ainda
    if (!transactionCommitted) {
      await mongoSession.abortTransaction();
    }
    throw error;
  } finally {
    mongoSession.endSession();
  }
}));

/**
 * 🎯 DELETE /api/v2/appointments/:id - Deletar agendamento (Sync)
 * 
 * Regras V2:
 * - Deleta o appointment
 * - Publica evento para deleção em cascata (session, payment)
 */
router.delete('/:id', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const appointment = await Appointment.findById(id);
  
  if (!appointment) {
    throw createBusinessError(Messages.APPOINTMENT.NOT_FOUND, 404, ErrorCodes.NOT_FOUND);
  }
  
  // Verificar permissões
  if (req.user.role === 'doctor' && appointment.doctor.toString() !== req.user.id) {
    throw createBusinessError('Acesso não autorizado', 403, ErrorCodes.UNAUTHORIZED);
  }
  
  // Deletar
  await Appointment.findByIdAndDelete(id);
  
  // Publicar evento para orquestradores limparem relacionados
  await publishEvent(EventTypes.APPOINTMENT_DELETED, {
    appointmentId: appointment._id,
    patientId: appointment.patient,
    doctorId: appointment.doctor,
    sessionId: appointment.session,
    paymentId: appointment.payment,
    packageId: appointment.package,
    deletedBy: req.user._id,
    timestamp: new Date()
  });
  
  res.json(formatSuccess({
    message: 'Agendamento deletado com sucesso',
    appointmentId: id
  }));
}));

/**
 * 🎯 PATCH /api/v2/appointments/:id/confirm - Confirmar agendamento (Sync)
 * 
 * Regras V2 (baseado no V1):
 * - Pendente/Scheduled → Confirmed
 * - Atualiza session vinculada para 'completed'
 * - Registra no histórico
 */
router.patch('/:id/confirm', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const mongoSession = await mongoose.startSession();
  
  try {
    await mongoSession.startTransaction();
    
    const appointment = await Appointment.findById(id).session(mongoSession);
    
    if (!appointment) {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.APPOINTMENT.NOT_FOUND, 404, ErrorCodes.NOT_FOUND);
    }
    
    // Verificar permissões
    if (req.user.role === 'doctor' && appointment.doctor.toString() !== req.user.id) {
      await mongoSession.abortTransaction();
      throw createBusinessError('Acesso não autorizado', 403, ErrorCodes.UNAUTHORIZED);
    }
    
    // Validação: não confirmar se já está cancelado
    if (appointment.operationalStatus === 'canceled') {
      await mongoSession.abortTransaction();
      throw createBusinessError('Não é possível confirmar um agendamento cancelado', 400, ErrorCodes.BUSINESS_RULE_VIOLATION);
    }
    
    const oldStatus = appointment.operationalStatus;
    
    // Atualizar status
    appointment.operationalStatus = 'confirmed';
    appointment.clinicalStatus = 'pending';
    
    // Registrar histórico
    if (!appointment.history) appointment.history = [];
    appointment.history.push({
      action: 'confirmacao_v2',
      changedBy: req.user._id,
      timestamp: new Date(),
      context: 'operacional',
      details: { from: oldStatus, to: 'confirmed', notes: req.body.notes }
    });
    
    const updatedAppointment = await appointment.save({ session: mongoSession });
    
    // Atualizar Session vinculada
    if (appointment.session) {
      await Session.findByIdAndUpdate(
        appointment.session,
        {
          $set: {
            status: 'completed',
            updatedAt: new Date()
          }
        },
        { session: mongoSession }
      );
    }
    
    await mongoSession.commitTransaction();
    
    // Publicar evento
    await publishEvent(EventTypes.APPOINTMENT_CONFIRMED, {
      appointmentId: updatedAppointment._id,
      patientId: updatedAppointment.patient,
      doctorId: updatedAppointment.doctor,
      previousStatus: oldStatus,
      confirmedBy: req.user._id,
      timestamp: new Date()
    });
    
    res.json(formatSuccess({
      appointment: updatedAppointment,
      message: 'Agendamento confirmado com sucesso'
    }));
    
  } catch (error) {
    await mongoSession.abortTransaction();
    throw error;
  } finally {
    mongoSession.endSession();
  }
}));

/**
 * 🎯 PATCH /api/v2/appointments/:id/reschedule - Reagendar (Sync)
 * 
 * Endpoint específico para reagendamento (mudança de data/hora)
 * - Atualiza appointment.date e appointment.time
 * - Atualiza session vinculada
 * - Registra no histórico
 */
router.patch('/:id/reschedule', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { date, time, reason } = req.body;
  
  const mongoSession = await mongoose.startSession();
  
  try {
    await mongoSession.startTransaction();
    
    // Validações
    if (!date || !time) {
      await mongoSession.abortTransaction();
      throw createBusinessError('Data e hora são obrigatórios', 400, ErrorCodes.MISSING_REQUIRED_FIELD);
    }
    
    const appointment = await Appointment.findById(id).session(mongoSession)
      .populate('session');
    
    if (!appointment) {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.APPOINTMENT.NOT_FOUND, 404, ErrorCodes.NOT_FOUND);
    }
    
    // Verificar permissões
    if (req.user.role === 'doctor' && appointment.doctor.toString() !== req.user.id) {
      await mongoSession.abortTransaction();
      throw createBusinessError('Acesso não autorizado', 403, ErrorCodes.UNAUTHORIZED);
    }
    
    const oldDate = appointment.date;
    const oldTime = appointment.time;
    
    // Atualizar appointment
    appointment.date = date;
    appointment.time = time;
    
    // Registrar histórico
    if (!appointment.history) appointment.history = [];
    appointment.history.push({
      action: 'reagendamento_v2',
      changedBy: req.user._id,
      timestamp: new Date(),
      context: 'operacional',
      details: { 
        oldDate: oldDate,
        newDate: date,
        oldTime: oldTime,
        newTime: time,
        reason: reason || 'Reagendamento manual'
      }
    });
    
    const updatedAppointment = await appointment.save({ session: mongoSession });
    
    // Atualizar Session vinculada
    if (appointment.session) {
      await Session.findByIdAndUpdate(
        appointment.session,
        {
          $set: {
            date: date,
            time: time,
            updatedAt: new Date()
          }
        },
        { session: mongoSession }
      );
    }
    
    await mongoSession.commitTransaction();
    
    // Publicar evento
    await publishEvent(EventTypes.APPOINTMENT_RESCHEDULED, {
      appointmentId: updatedAppointment._id,
      patientId: updatedAppointment.patient,
      doctorId: updatedAppointment.doctor,
      oldDate: oldDate,
      newDate: date,
      oldTime: oldTime,
      newTime: time,
      reason: reason,
      rescheduledBy: req.user._id,
      timestamp: new Date()
    });
    
    res.json(formatSuccess({
      appointment: updatedAppointment,
      message: 'Agendamento reagendado com sucesso'
    }));
    
  } catch (error) {
    await mongoSession.abortTransaction();
    throw error;
  } finally {
    mongoSession.endSession();
  }
}));

/**
 * 🔓 POST /api/v2/appointments/:id/release-lock - Liberar lock manualmente
 * 
 * Endpoint para liberar o lock de um agendamento travado em processing_*
 * Útil quando o worker falhou e o agendamento ficou preso
 */
router.post('/:id/release-lock', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason = 'manual_release' } = req.body;
  
  console.log(`[release-lock] Solicitação para liberar lock: ${id}, motivo: ${reason}`);
  
  const appointment = await Appointment.findById(id);
  
  if (!appointment) {
    throw createBusinessError(Messages.BUSINESS.APPOINTMENT_NOT_FOUND, 404, ErrorCodes.NOT_FOUND);
  }
  
  // Só permite liberar se estiver em estado de processamento
  const processingStatuses = ['processing_complete', 'processing_cancel', 'processing_create'];
  if (!processingStatuses.includes(appointment.operationalStatus)) {
    res.json(formatSuccess({
      appointmentId: id,
      operationalStatus: appointment.operationalStatus,
      message: 'Agendamento não está em processamento',
      released: false
    }));
    return;
  }
  
  // Determina o status anterior
  let newStatus = 'scheduled';
  if (appointment.operationalStatus === 'processing_create') {
    newStatus = 'pending';
  }
  
  const previousStatus = appointment.operationalStatus;
  
  // Atualiza o agendamento
  await Appointment.findByIdAndUpdate(id, {
    $set: { 
      operationalStatus: newStatus,
      updatedAt: new Date()
    },
    $push: {
      history: {
        action: 'manual_lock_release',
        previousStatus: previousStatus,
        newStatus: newStatus,
        changedBy: req.user?._id,
        timestamp: new Date(),
        context: `Lock liberado manualmente via API. Motivo: ${reason}`
      }
    }
  });
  
  console.log(`[release-lock] ✅ Lock liberado: ${id} (${previousStatus} → ${newStatus})`);
  
  res.json(formatSuccess({
    appointmentId: id,
    previousStatus: previousStatus,
    newStatus: newStatus,
    released: true,
    message: `Lock liberado com sucesso. Status alterado de ${previousStatus} para ${newStatus}`
  }));
}));

export default router;
