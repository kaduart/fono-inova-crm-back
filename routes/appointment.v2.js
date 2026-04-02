// routes/appointment.v2.js
/**
 * 🚀 ROTAS 4.0 - Event-Driven Architecture
 * 
 * Endpoint base: /api/v2/appointments
 * Mensagens padronizadas e tratamento de erros consistente
 */

import express from 'express';
import mongoose from 'mongoose';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { completeSessionEventDriven } from '../services/completeSessionEventService.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import { Messages, formatSuccess, formatError, ErrorCodes } from '../utils/apiMessages.js';
import { createBusinessError, asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

/**
 * 🎯 POST /api/v2/appointments - Criar agendamento (Async)
 */
router.post('/', flexibleAuth, asyncHandler(async (req, res) => {
  const mongoSession = await mongoose.startSession();
  
  try {
    await mongoSession.startTransaction();

    const {
      patientId,
      doctorId,
      date,
      time,
      specialty = 'fonoaudiologia',
      packageId = null,
      serviceType = packageId ? 'package_session' : 'session',
      insuranceGuideId = null,
      paymentMethod = 'dinheiro',
      amount = req.body.paymentAmount || 0,  // 🐛 FIX: suporta paymentAmount (front/collection)
      notes = ''
    } = req.body;

    if (packageId) {
      paymentMethod = 'package';
    }

    // Validações com mensagens claras
    if (!patientId) {
      await mongoSession.abortTransaction();
      throw createBusinessError(
        ErrorCodes.MISSING_REQUIRED_FIELD,
        Messages.VALIDATION.PATIENT_REQUIRED,
        400,
        { field: 'patientId' }
      );
    }

    if (!doctorId) {
      await mongoSession.abortTransaction();
      throw createBusinessError(
        ErrorCodes.MISSING_REQUIRED_FIELD,
        Messages.VALIDATION.DOCTOR_REQUIRED,
        400,
        { field: 'doctorId' }
      );
    }

    if (!date) {
      await mongoSession.abortTransaction();
      throw createBusinessError(
        ErrorCodes.MISSING_REQUIRED_FIELD,
        Messages.VALIDATION.DATE_REQUIRED,
        400,
        { field: 'date' }
      );
    }

    if (!time) {
      await mongoSession.abortTransaction();
      throw createBusinessError(
        ErrorCodes.MISSING_REQUIRED_FIELD,
        Messages.VALIDATION.TIME_REQUIRED,
        400,
        { field: 'time' }
      );
    }

    // 🔥 DETERMINAR BILLINGTYPE CORRETAMENTE (respeita tipo do pacote)
    let billingType = req.body.billingType;
    if (!billingType && packageId) {
      const pkg = await Package.findById(packageId).session(mongoSession).select('type');
      if (pkg) {
        billingType = pkg.type === 'convenio' ? 'convenio' : (pkg.type === 'liminar' ? 'liminar' : 'particular');
      }
    }
    if (!billingType) {
      billingType = insuranceGuideId ? 'convenio' : 'particular';
    }

    // 🛡️ VALIDAÇÃO CONVÊNIO: Guia obrigatória e válida
    
    if (billingType === 'convenio' || insuranceGuideId) {
      if (!insuranceGuideId) {
        await mongoSession.abortTransaction();
        throw createBusinessError(
          ErrorCodes.MISSING_REQUIRED_FIELD,
          'Guia de convênio é obrigatória para agendamentos de convênio',
          400,
          { field: 'insuranceGuideId' }
        );
      }
      
      // Verifica se guia existe e está ativa
      const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
      const guide = await InsuranceGuide.findById(insuranceGuideId).session(mongoSession);
      
      if (!guide) {
        await mongoSession.abortTransaction();
        throw createBusinessError(
          ErrorCodes.NOT_FOUND,
          'Guia de convênio não encontrada',
          404,
          { field: 'insuranceGuideId', value: insuranceGuideId }
        );
      }
      
      if (guide.status === 'canceled' || guide.status === 'expired') {
        await mongoSession.abortTransaction();
        throw createBusinessError(
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          `Guia de convênio está ${guide.status === 'canceled' ? 'cancelada' : 'expirada'}`,
          400,
          { field: 'insuranceGuideId', status: guide.status }
        );
      }
      
      if (guide.usedSessions >= guide.totalSessions) {
        await mongoSession.abortTransaction();
        throw createBusinessError(
          ErrorCodes.INSUFFICIENT_CREDIT,
          'Guia de convênio esgotada (sem sessões disponíveis)',
          422,
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
        throw createBusinessError(
          ErrorCodes.BUSINESS_RULE_VIOLATION,
          'Guia de convênio não pertence a este paciente',
          400,
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
      package: packageId,
      insuranceGuide: insuranceGuideId,
      
      operationalStatus: 'processing_create',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',
      
      sessionValue: amount,
      paymentMethod,
      billingType,
      
      notes,
      createdBy: req.user?._id,
      
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
        packageId: packageId?.toString(),
        insuranceGuideId: insuranceGuideId?.toString(),
        amount,
        billingType,  // 🐛 FIX: inclui billingType
        paymentMethod,
        notes,
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
      throw createBusinessError(
        ErrorCodes.MISSING_REQUIRED_FIELD,
        Messages.VALIDATION.REASON_REQUIRED,
        400,
        { field: 'reason' }
      );
    }

    const appointment = await Appointment.findById(id).session(mongoSession);

    if (!appointment) {
      await mongoSession.abortTransaction();
      throw createBusinessError(
        ErrorCodes.NOT_FOUND,
        Messages.BUSINESS.APPOINTMENT_NOT_FOUND,
        404
      );
    }

    // Guards com mensagens claras
    if (appointment.operationalStatus === 'processing_cancel') {
      await mongoSession.abortTransaction();
      throw createBusinessError(
        ErrorCodes.ALREADY_PROCESSING,
        Messages.BUSINESS.ALREADY_PROCESSING_CANCEL,
        409,
        { status: 'processing_cancel' }
      );
    }

    if (appointment.operationalStatus === 'canceled') {
      await mongoSession.abortTransaction();
      throw createBusinessError(
        ErrorCodes.CONFLICT_STATE,
        Messages.BUSINESS.ALREADY_CANCELED,
        409
      );
    }

    if (appointment.clinicalStatus === 'completed') {
      await mongoSession.abortTransaction();
      throw createBusinessError(
        ErrorCodes.CONFLICT_STATE,
        Messages.BUSINESS.CANNOT_CANCEL_COMPLETED,
        409
      );
    }

    // Marca como processando
    appointment.operationalStatus = 'processing_cancel';
    appointment.canceledReason = reason;
    appointment.canceledBy = req.user?._id;
    appointment.canceledAt = new Date();
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
      throw createBusinessError(
        ErrorCodes.NOT_FOUND,
        Messages.BUSINESS.APPOINTMENT_NOT_FOUND,
        404
      );
    }

    // Guards
    if (appointment.operationalStatus === 'processing_complete') {
      await mongoSession.abortTransaction();
      throw createBusinessError(
        ErrorCodes.ALREADY_PROCESSING,
        Messages.BUSINESS.ALREADY_PROCESSING_COMPLETE,
        409,
        { status: 'processing_complete' }
      );
    }

    if (appointment.clinicalStatus === 'completed') {
      await mongoSession.abortTransaction();
      throw createBusinessError(
        ErrorCodes.CONFLICT_STATE,
        Messages.BUSINESS.ALREADY_COMPLETED,
        409,
        { idempotent: true }
      );
    }

    if (appointment.operationalStatus === 'canceled') {
      await mongoSession.abortTransaction();
      throw createBusinessError(
        ErrorCodes.CONFLICT_STATE,
        Messages.BUSINESS.CANNOT_COMPLETE_CANCELED,
        409
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

    // Executa complete síncrono (igual V1) + publica eventos
    const result = await completeSessionEventDriven(id, {
      addToBalance,
      balanceAmount,
      balanceDescription,
      userId: req.user?._id,
      correlationId: id
    });

    res.status(200).json(
      formatSuccess(
        {
          appointmentId: id,
          status: 'confirmed',
          correlationId: result.correlationId,
          eventsPublished: result.eventsPublished
        },
        {
          message: result.message || Messages.PROCESSING.COMPLETE,
          processing: 'sync'
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
  
  console.log(`[GET /v2/appointments] Listando agendamentos`, { startDate, endDate, status, light });
  
  // Build filter
  const filter = {};
  
  if (startDate && endDate) {
    // Date pode ser string ou Date - usar comparação de string
    filter.date = {
      $gte: startDate,
      $lte: endDate
    };
  }
  
  if (patientId) filter.patient = patientId;
  if (doctorId) filter.doctor = doctorId;
  
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
  let query = Appointment.find(filter);
  
  // 🆕 Se light=true, retorna apenas campos essenciais para o calendário
  if (light === 'true') {
    query = query
      .select('date time duration operationalStatus clinicalStatus paymentStatus sessionValue patient doctor')
      .populate('patient', 'fullName')
      .populate('doctor', 'fullName specialty');
  } else {
    // Modo completo (padrão)
    query = query
      .populate('patient', 'fullName dateOfBirth phone email')
      .populate('doctor', 'fullName specialty email phoneNumber')
      .populate('session', 'status paymentStatus sessionValue')
      .populate('package', 'totalSessions sessionsDone sessionValue type')
      .populate('payment', 'status amount paymentMethod');
  }
  
  const appointments = await query
    .sort({ date: 1, time: 1 })
    .skip(skip)
    .limit(parseInt(limit));
  
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
    throw createBusinessError(
      ErrorCodes.NOT_FOUND,
      Messages.BUSINESS.APPOINTMENT_NOT_FOUND,
      404
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
    throw createBusinessError(
      ErrorCodes.NOT_FOUND,
      Messages.BUSINESS.APPOINTMENT_NOT_FOUND,
      404
    );
  }

  const isProcessing = 
    appointment.operationalStatus === 'processing_create' ||
    appointment.operationalStatus === 'processing_cancel' ||
    appointment.operationalStatus === 'processing_complete';

  const statusMessages = {
    'processing_create': Messages.PROCESSING.CREATE,
    'processing_cancel': Messages.PROCESSING.CANCEL,
    'processing_complete': Messages.PROCESSING.COMPLETE,
    'scheduled': 'Agendamento confirmado',
    'canceled': 'Agendamento cancelado',
    'confirmed': 'Sessão completada'
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
        isCompleted: appointment.clinicalStatus === 'completed',
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
    throw createBusinessError(ErrorCodes.NOT_FOUND, 'Agendamento não encontrado', 404);
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
    throw createBusinessError(ErrorCodes.NOT_FOUND, 'Agendamento não encontrado', 404);
  }
  
  if (!appointment.session) {
    throw createBusinessError(ErrorCodes.BUSINESS_RULE_VIOLATION, 'Agendamento sem sessão', 400);
  }
  
  const Session = (await import('../models/Session.js')).default;
  const sessionId = appointment.session._id || appointment.session;
  const session = await Session.findById(sessionId);
  
  if (!session) {
    throw createBusinessError(ErrorCodes.NOT_FOUND, 'Sessão não encontrada', 404);
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
 * PUT /api/v2/appointments/:id
 * 
 * Atualiza agendamento existente (event-driven)
 */
router.put('/:id', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;
  
  console.log(`[AppointmentV2] Update solicitado: ${id}`, updateData);
  
  // Verifica se existe
  const existing = await Appointment.findById(id);
  if (!existing) {
    return res.status(404).json(formatError('Agendamento não encontrado'));
  }
  
  // Verifica conflito se mudou horário/médico
  if (updateData.doctorId && updateData.date && updateData.time) {
    const conflict = await Appointment.findOne({
      _id: { $ne: id },
      doctorId: updateData.doctorId,
      date: updateData.date,
      time: updateData.time,
      status: { $nin: ['cancelled', 'completed'] }
    });
    
    if (conflict) {
      return res.status(409).json(formatError('Conflito de agenda médica', {
        conflict: {
          appointmentId: conflict._id,
          patientName: conflict.patientName,
          existingAppointment: {
            _id: conflict._id,
            time: conflict.time,
            patient: conflict.patientId
          }
        },
        suggestion: 'Por favor, escolha outro horário ou médico'
      }));
    }
  }
  
  // Atualiza diretamente (não precisa de evento para update simples)
  const updated = await Appointment.findByIdAndUpdate(
    id,
    { $set: updateData },
    { new: true }
  );
  
  res.json(formatSuccess({
    appointment: updated,
    message: 'Agendamento atualizado com sucesso'
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
    'complete-orchestrator'
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

export default router;
