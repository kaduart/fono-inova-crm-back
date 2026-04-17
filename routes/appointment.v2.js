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
import { dashboardCache } from '../services/adminDashboardCacheService.js';
import { redisConnection } from '../infrastructure/queue/queueConfig.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { checkAppointmentConflicts, getAvailableTimeSlots } from '../middleware/conflictDetection.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import PatientBalance from '../models/PatientBalance.js';
import Package from '../models/Package.js';
import PatientsView from '../models/PatientsView.js';
import Doctor from '../models/Doctor.js';
import { Messages, formatSuccess, formatError, ErrorCodes } from '../utils/apiMessages.js';
import { createBusinessError, asyncHandler } from '../middleware/errorHandler.js';
// 🔒 LOCK V2: Não usar appointmentCompleteService (legado)
import { completeSessionEventDrivenV2 } from '../services/completeSessionEventService.v2.js';
import { completeSessionV2 } from '../services/completeSessionService.v2.js';
import { completeSessionDtoMapper } from '../middleware/dtoMiddleware.js';
import FinancialGuard from '../services/financialGuard/index.js';
import { recordSessionCancellationReversal } from '../services/financialLedgerService.js';
import { normalizeSessionType } from '../utils/sessionTypeResolver.js';
import { buildIndividualSession, buildInsuranceSession } from '../domain/session/sessionFactory.js';
import { buildDateTime } from '../utils/datetime.js';
import moment from 'moment-timezone';
import { PRE_APPOINTMENT_STATUSES, CANCELED_STATUSES } from '../constants/appointmentStatus.js';
import { mapAppointmentDTO } from '../utils/appointmentDto.js';

// ======================================================================
// 🔥 CACHE RÁPIDO PARA LISTAGEM (30 segundos)
// ======================================================================
const listCache = new Map();
const CACHE_TTL = 30000;

function getCacheKey(query) {
  return JSON.stringify(query);
}

function getCached(key) {
  const item = listCache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL) {
    listCache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data) {
  listCache.set(key, { data, timestamp: Date.now() });
}

function clearCache() {
  listCache.clear();
}

// ======================================================================
// HELPER: Cria data no timezone correto (Brasília)
// ======================================================================
function parseDateInTimezone(dateStr, timeStr) {
  // Garante que a data seja interpretada no timezone de São Paulo
  // "2026-04-10" + "14:00" → 2026-04-10T14:00:00-03:00
  const dateTimeStr = `${dateStr} ${timeStr || '00:00'}`;
  const parsed = moment.tz(dateTimeStr, 'YYYY-MM-DD HH:mm', 'America/Sao_Paulo');
  
  if (!parsed.isValid()) {
    throw new Error(`Data inválida: ${dateStr} ${timeStr}`);
  }
  
  return parsed.toDate(); // Converte para Date (UTC internamente)
}

function isValidDateString(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const parsed = moment.tz(dateStr, 'YYYY-MM-DD', 'America/Sao_Paulo');
  return parsed.isValid();
}

const router = express.Router();

/**
 * 🎯 POST /api/v2/appointments - Criar agendamento (Async)
 * 🔥 SEM TRANSACTION - Event Store garante consistência
 */
router.post('/', flexibleAuth, checkAppointmentConflicts, asyncHandler(async (req, res) => {
  try {
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
      paymentAmount = null,
      notes = '',
      leadId = null,
      source = null,
      preAgendamentoId = null,
      insuranceProvider = null,
      insuranceValue = null,
      authorizationCode = null,
    } = req.body;
    
    const finalAmount = paymentAmount !== null ? parseFloat(paymentAmount) : (amount || 0);
    
    console.log(`[POST /v2/appointments] 💰 Valor recebido:`, {
      amount,
      paymentAmount,
      finalAmount
    });

    // ========== VALIDAÇÕES SÍNCRONAS ==========
    if (!patientId) {
      throw createBusinessError(Messages.VALIDATION.PATIENT_REQUIRED, 400, ErrorCodes.MISSING_REQUIRED_FIELD,
        { field: 'patientId' }
      );
    }

    if (!doctorId) {
      throw createBusinessError(Messages.VALIDATION.DOCTOR_REQUIRED, 400, ErrorCodes.MISSING_REQUIRED_FIELD,
        { field: 'doctorId' }
      );
    }

    if (!date) {
      throw createBusinessError(Messages.VALIDATION.DATE_REQUIRED, 400, ErrorCodes.MISSING_REQUIRED_FIELD,
        { field: 'date' }
      );
    }

    if (!time) {
      throw createBusinessError(Messages.VALIDATION.TIME_REQUIRED, 400, ErrorCodes.MISSING_REQUIRED_FIELD,
        { field: 'time' }
      );
    }

    // ========== VALIDAÇÃO CONVÊNIO ==========
    const billingType = req.body.billingType || (insuranceGuideId ? 'convenio' : 'particular');
    
    if (billingType === 'convenio' || insuranceGuideId) {
      if (!insuranceGuideId) {
        throw createBusinessError('Guia de convênio é obrigatória para agendamentos de convênio', 400, ErrorCodes.MISSING_REQUIRED_FIELD,
          { field: 'insuranceGuideId' }
        );
      }
      
      const InsuranceGuide = (await import('../models/InsuranceGuide.js')).default;
      const guide = await InsuranceGuide.findById(insuranceGuideId);
      
      if (!guide) {
        throw createBusinessError('Guia de convênio não encontrada', 404, ErrorCodes.NOT_FOUND,
          { field: 'insuranceGuideId', value: insuranceGuideId }
        );
      }
      
      if (guide.status === 'canceled' || guide.status === 'expired') {
        throw createBusinessError(`Guia de convênio está ${guide.status === 'canceled' ? 'cancelada' : 'expirada'}`, 400, ErrorCodes.BUSINESS_RULE_VIOLATION,
          { field: 'insuranceGuideId', status: guide.status }
        );
      }
      
      if (guide.usedSessions >= guide.totalSessions) {
        throw createBusinessError('Guia de convênio esgotada (sem sessões disponíveis)', 422, ErrorCodes.INSUFFICIENT_CREDIT,
          { 
            field: 'insuranceGuideId', 
            used: guide.usedSessions, 
            total: guide.totalSessions 
          }
        );
      }
      
      if (guide.patient?.toString() !== patientId?.toString()) {
        throw createBusinessError('Guia de convênio não pertence a este paciente', 400, ErrorCodes.BUSINESS_RULE_VIOLATION,
          { field: 'insuranceGuideId' }
        );
      }
      
      console.log(`[Create] ✅ Guia ${insuranceGuideId} validada: ${guide.usedSessions}/${guide.totalSessions} sessões`);
    }

    // ========== CRIAÇÃO SÍNCRONA ==========
    const parsedDate = parseDateInTimezone(date, time);
    const idempotencyKey = `${patientId}_${doctorId}_${date}_${time}`;
    
    // Check idempotência (mesmo paciente, mesmo horário = duplicado)
    const existingAppointment = await Appointment.findOne({
      patient: patientId,
      doctor: doctorId,
      date: parsedDate,
      time,
      operationalStatus: { $nin: ['canceled'] }
    });
    
    if (existingAppointment) {
      console.log(`[Create V2] ⚠️ DUPLICADO DETECTADO: ${existingAppointment._id}`, {
        patientId,
        doctorId,
        date,
        time,
        packageId,
        source: req.body.source || 'unknown'
      });
      return res.status(409).json(
        formatError('Agendamento duplicado para este paciente/horário', 409, 'DUPLICATE_APPOINTMENT', {
          existingAppointmentId: existingAppointment._id.toString(),
          message: 'Use PATCH /:id/complete ou PATCH /:id/cancel para atualizar'
        })
      );
    }
    
    // Cria Appointment direto como "scheduled"
    const appointment = new Appointment({
      patient: patientId,
      doctor: doctorId,
      date: parsedDate,
      time,
      specialty,
      serviceType,
      sessionType: normalizeSessionType(sessionType || specialty),
      package: packageId,
      insuranceGuide: insuranceGuideId,

      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      paymentStatus: req.body.paymentStatus || 'pending',

      sessionValue: req.body.sessionValue || finalAmount,
      paymentMethod: req.body.paymentMethod || 'dinheiro',
      billingType: billingType || (insuranceGuideId ? 'convenio' : 'particular'),

      ...(insuranceProvider && { insuranceProvider }),
      ...(insuranceValue != null && { insuranceValue }),
      ...(authorizationCode && { authorizationCode }),

      notes,
      createdBy: req.user?._id,

      metadata: {
        origin: {
          source: source || 'crm',
          preAgendamentoId: preAgendamentoId || null,
          leadId: leadId || null,
        }
      },

      history: [{
        action: 'create_requested',
        newStatus: 'scheduled',
        changedBy: req.user?._id,
        timestamp: new Date(),
        context: 'Criação via 4.0'
      }]
    });
    
    await appointment.save();

    // Popula patientInfo a partir do paciente (campo denormalizado para buscas rápidas)
    if (!appointment.patientInfo?.fullName) {
      try {
        const bodyInfo = req.body.patientInfo;
        const bodyName = req.body.patientName || req.body.patient;
        if (bodyInfo?.fullName || bodyName) {
          appointment.patientInfo = {
            fullName: bodyInfo?.fullName || bodyName || '',
            phone: bodyInfo?.phone || req.body.phone || '',
            birthDate: bodyInfo?.birthDate || req.body.birthDate || null,
            email: bodyInfo?.email || req.body.email || null,
          };
        } else {
          const pat = await Patient.findById(patientId).select('fullName name phone dateOfBirth email');
          if (pat) {
            appointment.patientInfo = {
              fullName: pat.fullName || pat.name || '',
              phone: pat.phone || '',
              birthDate: pat.dateOfBirth || null,
              email: pat.email || null,
            };
          }
        }
        if (appointment.patientInfo?.fullName) await appointment.save();
      } catch (err) {
        console.warn('[POST /v2/appointments] ⚠️ Falha ao popular patientInfo:', err.message);
      }
    }

    // 🎯 CRIAR SESSION SÍNCRONA para agendamentos AVULSOS (garantia de consistência)
    // Pacotes: Session é criada pelo packageController ou worker (lógica complexa de crédito)
    let session = null;
    if (!packageId) {
      try {
        const sessionData = (billingType === 'convenio' || insuranceGuideId)
          ? buildInsuranceSession(appointment)
          : buildIndividualSession(appointment);
        
        session = await Session.create(sessionData);
        appointment.session = session._id;
        await appointment.save();
        
        console.log(`[POST /v2/appointments] ✅ Session criada: ${session._id}`);
      } catch (sessionErr) {
        console.error(`[POST /v2/appointments] ⚠️ Falha ao criar session:`, sessionErr.message);
        // Não falha o request — worker pode tentar compensar, mas logamos
      }
    }
    
    console.log(`[POST /v2/appointments] ✅ Appointment criado: ${appointment._id}`);
    console.log(`   Status: ${appointment.operationalStatus} (SÍNCRONO)`);

    // ========== RESPOSTA RÁPIDA ==========
    clearCache();
    res.status(201).json(
      formatSuccess(
        {
          appointmentId: appointment._id.toString(),
          status: 'scheduled',
          operationalStatus: 'scheduled',
          clinicalStatus: 'pending',
          correlationId: appointment._id.toString(),
          sessionId: session?._id?.toString() || null
        },
        {
          message: 'Agendamento criado com sucesso',
          processing: 'async',
          estimatedTime: '1-3s'
        }
      )
    );

    // ========== BACKGROUND (NÃO BLOQUEIA) ==========
    setImmediate(async () => {
      try {
        console.log(`[Create BG] 🔄 Iniciando processamento background...`);
        
        // Publica evento
        await publishEvent(
          EventTypes.APPOINTMENT_CREATED,
          {
            appointmentId: appointment._id.toString(),
            patientId: patientId?.toString(),
            doctorId: doctorId?.toString(),
            date,
            time,
            specialty,
            serviceType,
            sessionType: normalizeSessionType(sessionType || specialty),
            packageId: packageId?.toString() || null,
            insuranceGuideId: insuranceGuideId?.toString() || null,
            amount: finalAmount,
            paymentMethod,
            billingType: billingType || (insuranceGuideId ? 'convenio' : 'particular'),
            notes,
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
        
        console.log(`[Create BG] ✅ Evento publicado`);
        
        // Update dashboard
        await dashboardCache.incrementOverview({
          'patients.total': 0,
        });
        
        console.log(`[Create BG] ✅ Background finalizado`);
      } catch (bgErr) {
        console.error(`[Create BG] ⚠️ Erro em background (não crítico):`, bgErr.message);
      }
    });

  } catch (error) {
    console.error(`[POST /v2/appointments] ❌ Erro:`, error.message);
    throw error;
  }
}));

/**
 * 🎯 PATCH /api/v2/appointments/:id/cancel - Cancelar (Async)
 * 🔥 SEM TRANSACTION - Event Store garante consistência
 */
router.patch('/:id/cancel', flexibleAuth, asyncHandler(async (req, res) => {
  const mongoSession = await mongoose.startSession();
  
  try {
    const { id } = req.params;
    const { reason, confirmedAbsence = false } = req.body;

    if (!reason) {
      throw createBusinessError(Messages.VALIDATION.REASON_REQUIRED, 400, ErrorCodes.MISSING_REQUIRED_FIELD,
        { field: 'reason' }
      );
    }

    await mongoSession.startTransaction();

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

    // 🎯 CRM: operationalStatus é a fonte da verdade
    if (appointment.operationalStatus === 'completed') {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.BUSINESS.CANNOT_CANCEL_COMPLETED, 409, ErrorCodes.CONFLICT_STATE
      );
    }

    // 🎯 V2 SÍNCRONO: Cancela imediatamente
    appointment.operationalStatus = 'canceled';
    appointment.status = 'canceled';
    appointment.canceledAt = new Date();
    appointment.cancellationReason = reason;
    appointment.history.push({
      action: 'canceled',
      newStatus: 'canceled',
      changedBy: req.user?._id,
      timestamp: new Date(),
      context: `Motivo: ${reason}`
    });

    await appointment.save({ session: mongoSession });

    // 💰 FINANCIAL GUARD: processa efeitos financeiros do cancelamento dentro da mesma transaction
    let financialResult = null;
    try {
      financialResult = await FinancialGuard.execute({
        context: 'CANCEL_APPOINTMENT',
        // 🎯 Se tem package, SEMPRE usar package guard (independentemente de billingType do appointment)
        billingType: appointment.package ? 'package' : (appointment.billingType || 'particular'),
        payload: {
          appointmentId: id,
          packageId: appointment.package?.toString(),
          paymentId: appointment.payment?.toString(),
          appointmentStatus: appointment.operationalStatus,
          paymentOrigin: appointment.paymentOrigin,
          sessionValue: appointment.sessionValue || 0,
          confirmedAbsence,
          reason,
          billingType: appointment.billingType
        },
        session: mongoSession
      });
      
      if (financialResult?.handled) {
        console.log(`[cancel] 💰 Financial Guard processado:`, financialResult);
      }
    } catch (financialErr) {
      console.error(`[cancel] ❌ ERRO CRÍTICO no Financial Guard:`, financialErr.message);
      await mongoSession.abortTransaction();
      throw createBusinessError(
        `Erro ao processar cancelamento financeiro: ${financialErr.message}`,
        500,
        'FINANCIAL_GUARD_FAILED'
      );
    }

    // 🔄 CANCELA PAYMENT se existir (independentemente do tipo de billing)
    if (appointment.payment) {
      const paymentId = appointment.payment._id || appointment.payment;
      const payment = await Payment.findById(paymentId).session(mongoSession);
      if (payment && payment.status !== 'canceled') {
        payment.status = 'canceled';
        payment.canceledAt = new Date();
        payment.canceledReason = reason;
        payment.updatedAt = new Date();
        await payment.save({ session: mongoSession });
        console.log(`[cancel] 💰 Payment ${paymentId} cancelado`);
      }
    }

    await mongoSession.commitTransaction();

    // 🔄 REBUILD SÍNCRONO da view (se houver pacote)
    let viewRebuilt = false;
    if (appointment.package) {
      try {
        const { buildPackageView } = await import('../domains/billing/services/PackageProjectionService.js');
        await buildPackageView(appointment.package.toString(), { correlationId: id });
        console.log(`[cancel] 🔄 View do pacote ${appointment.package} reconstruída (síncrono)`);
        viewRebuilt = true;
      } catch (viewErr) {
        console.warn(`[cancel] ⚠️ Erro ao reconstruir view (não crítico):`, viewErr.message);
      }
    }

    const idempotencyKey = `${id}_cancel`;

    // 🔥 Publica evento em background (garantia eventual + notificações)
    setImmediate(async () => {
      try {
        await publishEvent(
          EventTypes.APPOINTMENT_CANCEL_REQUESTED,
          {
            appointmentId: id,
            patientId: appointment.patient?.toString(),
            packageId: appointment.package?.toString(),
            reason,
            confirmedAbsence,
            userId: req.user?._id?.toString(),
            financialResult
          },
          {
            correlationId: id,
            idempotencyKey
          }
        );
      } catch (err) {
        console.error(`[cancel] ⚠️ Erro ao publicar evento (não crítico):`, err.message);
      }
    });

    clearCache();
    res.status(200).json(
      formatSuccess(
        {
          appointmentId: id,
          status: 'canceled',
          operationalStatus: 'canceled',
          correlationId: id,
          idempotencyKey,
          viewRebuilt,
          financialResult
        },
        {
          message: 'Agendamento cancelado com sucesso',
          processing: 'sync',
          note: 'Cancelamento síncrono - já refletido no dashboard'
        }
      )
    );

  } catch (error) {
    console.error(`[cancel] ❌ Erro:`, error.message);
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
    const { getQueue } = await import('../infrastructure/queue/queueConfig.js');
    const queue = getQueue('complete-orchestrator');
    const jobs = await queue.getJobs(['waiting', 'active', 'delayed']);
    return jobs.some(job => job.data?.payload?.appointmentId === appointmentId);
  } catch (error) {
    console.error('[hasActiveJobInQueue] Erro ao verificar fila:', error.message);
    return false; // Se não conseguir verificar, assume que não tem job
  }
}

/**
 * 🎯 PATCH /api/v2/appointments/:id/complete - Completar (USANDO SERVIÇO)
 * 
 * Usa AppointmentCompleteService que já centraliza toda a lógica:
 * - Atualiza Session
 * - Consome pacote (se houver)
 * - Processa pagamento
 * - Atualiza Appointment
 * - Publica eventos
 */
router.patch('/:id/complete', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { notes = '', evolution = '', addToBalance, balanceAmount, balanceDescription } = req.body;

  // 🚀 LOCK V2 MODE - Sempre usa V2, sem dualidade
  console.log(`[complete] 🔒 LOCK V2 - Completando ${id}`, { body: req.body });
  
  const result = await completeSessionV2(id, {
    notes,
    evolution,
    userId: req.user?._id?.toString(),
    addToBalance,
    balanceAmount,
    balanceDescription
  });

  console.log(`[complete] ✅ Appointment ${id} completado (V2)`);

  try {
    // ========================================
    // BUSCAR DADOS ATUALIZADOS PARA RESPOSTA
    // ========================================
    const updatedAppointment = await Appointment.findById(id);
    
    // ========================================
    // EMITIR SOCKET (fora da transação)
    // ========================================
    try {
      const { getIo } = await import('../config/socket.js');
      const io = getIo();
      if (io) {
        io.emit('appointmentUpdated', {
          _id: id,
          operationalStatus: updatedAppointment.operationalStatus,
          clinicalStatus: updatedAppointment.clinicalStatus,
          paymentStatus: updatedAppointment.paymentStatus,
          visualFlag: updatedAppointment.visualFlag,
          sessionId: result.sessionId,
          source: 'complete_service_v2'
        });
        console.log(`[complete] Socket emitido`);
      }
    } catch (socketErr) {
      console.error(`[complete] ⚠️ Socket erro (não crítico):`, socketErr.message);
    }

    // ========================================
    // RETORNAR SUCESSO COM DTO PADRONIZADO V2
    // ========================================
    const responseDto = completeSessionDtoMapper({
      appointmentId: id,
      sessionId: result.sessionId,
      packageId: result.packageId,
      paymentStatus: updatedAppointment.paymentStatus || 'unpaid',
      balanceAmount: updatedAppointment.balanceAmount || 0,
      sessionValue: result.sessionValue || updatedAppointment.sessionValue || 0,
      isPaid: updatedAppointment.paymentStatus === 'paid',
      correlationId: result.correlationId,
      idempotent: result.idempotent || false
    });
    
    clearCache();
    res.status(200).json(responseDto);

  } catch (error) {
    console.error(`[complete] ❌ Erro:`, error.message);
    throw error;
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

/**
 * 🗓️ GET /api/v2/appointments/weekly-availability
 * Disponibilidade semanal por especialidade — substitui /api/agenda-externa/disponibilidade
 */
router.get('/weekly-availability', flexibleAuth, asyncHandler(async (req, res) => {
  try {
    const { startDate, specialty, days = 7 } = req.query;

    if (!startDate || !specialty) {
      return res.status(400).json({
        success: false,
        error: 'startDate e specialty são obrigatórios'
      });
    }

    const daysCount = Math.min(parseInt(days) || 7, 14);

    const doctors = await Doctor.find({
      specialty: specialty.toLowerCase(),
      active: true
    }).lean();

    if (!doctors.length) {
      return res.status(404).json({
        success: false,
        error: `Nenhum profissional encontrado para: ${specialty}`
      });
    }

    const DAYS_PT = {
      sunday: 'Dom', monday: 'Seg', tuesday: 'Ter', wednesday: 'Qua',
      thursday: 'Qui', friday: 'Sex', saturday: 'Sáb'
    };
    const DAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    const weekDays = [];
    const start = new Date(`${startDate}T12:00:00-03:00`);

    for (let i = 0; i < daysCount; i++) {
      const currentDate = new Date(start);
      currentDate.setDate(start.getDate() + i);
      const dateStr = currentDate.toISOString().split('T')[0];
      const dayOfWeek = DAYS_EN[currentDate.getDay()];
      weekDays.push({ date: dateStr, dayOfWeek, dayLabel: DAYS_PT[dayOfWeek] });
    }

    const dates = weekDays.map(d => d.date);
    const doctorIds = doctors.map(d => d._id);

    const appointments = await Appointment.find({
      date: { $in: dates },
      doctor: { $in: doctorIds },
      operationalStatus: { $nin: [...CANCELED_STATUSES, 'no_show', 'missed', ...PRE_APPOINTMENT_STATUSES] },
      appointmentId: { $exists: false },
      isDeleted: { $ne: true }
    }).select('doctor date time').lean();

    const availability = weekDays.map(({ date, dayOfWeek, dayLabel }) => {
      const dayAppointments = appointments.filter(a => {
        const d = new Date(a.date).toISOString().split('T')[0];
        return d === date;
      });

      const professionals = doctors.map(doc => {
        const docAppointments = dayAppointments.filter(a => String(a.doctor) === String(doc._id));
        const occupiedSlots = docAppointments.map(a => a.time).filter(Boolean);

        // slots padrão: 08:00 às 18:00 de 40 em 40 min
        const slots = [];
        for (let h = 8; h < 18; h++) {
          for (let m = 0; m < 60; m += 40) {
            const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            slots.push({
              time,
              available: !occupiedSlots.includes(time),
              professional: doc.fullName,
              professionalId: doc._id
            });
          }
        }

        return {
          professionalId: doc._id,
          professionalName: doc.fullName,
          specialty: doc.specialty,
          slots
        };
      });

      return { date, dayOfWeek, dayLabel, professionals };
    });

    return res.json({
      success: true,
      count: availability.length,
      availability
    });
  } catch (error) {
    console.error('[AppointmentV2] Erro weekly-availability:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}));

router.get('/', flexibleAuth, asyncHandler(async (req, res) => {
  const startTime = Date.now();
  const { 
    startDate, 
    endDate, 
    patientId, 
    doctorId,
    status,
    page = 1,
    limit = 100,
    light = 'false',
    noCount = 'false',
    noCache = 'false'
  } = req.query;
  
  // 🔥 CACHE: Verifica se tem no cache (só se light=true e não pediu noCache)
  const cacheKey = light === 'true' && noCache !== 'true' ? getCacheKey(req.query) : null;
  if (cacheKey) {
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[GET /v2/appointments] ⚡ CACHE HIT: ${Date.now() - startTime}ms`);
      return res.json(formatSuccess(cached));
    }
  }
  
  // Build filter
  const filter = {};
  
  if (startDate && endDate) {
    filter.$or = [
      { date: { $gte: new Date(startDate + 'T00:00:00-03:00'), $lte: new Date(endDate + 'T23:59:59-03:00') } },
      { date: { $gte: startDate, $lte: endDate + 'T23:59:59' } }
    ];
  }
  
  // 🔥 OTIMIZAÇÃO: Só busca PatientsView se o ID parece ser de view (24 chars hex)
  if (patientId) {
    if (patientId.length === 24 && /^[a-f0-9]{24}$/i.test(patientId)) {
      // Provavelmente é ObjectId válido, usa direto
      filter.patient = new mongoose.Types.ObjectId(patientId);
    } else {
      // Pode ser view ID, tenta converter
      try {
        filter.patient = new mongoose.Types.ObjectId(patientId);
      } catch {
        filter.patient = patientId;
      }
    }
  }
  
  if (doctorId) filter.doctor = new mongoose.Types.ObjectId(doctorId);
  
  // Status filter
  if (status) {
    const statusMap = {
      'completed': 'completed',
      'canceled': 'canceled', 
      'confirmed': 'confirmed',
      'scheduled': 'scheduled',
      'pre_agendado': 'pre_agendado'
    };
    if (statusMap[status]) {
      filter.operationalStatus = statusMap[status];
    }
  }
  // Se não tem status, exclui pré-agendamentos pendentes e convertidos
  if (!status) {
    filter.operationalStatus = { $ne: 'pre_agendado' };
    filter.appointmentId = { $exists: false };
  }

  // 🛡️ Nunca retorna appointments soft-deletados
  filter.isDeleted = { $ne: true };
  
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const limitNum = parseInt(limit);
  
  // 🔥 OTIMIZAÇÃO: Query base - SEM POPULATES (mais rápido)
  let queryBuilder = Appointment.find(filter)
    .select(light === 'true' 
      ? 'date time duration operationalStatus clinicalStatus paymentStatus sessionValue patient doctor billingType insuranceProvider package serviceType specialty paymentMethod insuranceValue authorizationCode notes patientInfo professionalName metadata'
      : 'date time duration operationalStatus clinicalStatus paymentStatus sessionValue patient doctor billingType insuranceProvider package serviceType specialty paymentMethod insuranceValue authorizationCode notes createdAt patientInfo professionalName metadata'
    )
    .sort({ date: 1, time: 1 })
    .skip(skip)
    .limit(limitNum)
    .lean();
  
  // 🎯 SEMPRE popula nomes (essencial para o frontend identificar agendamentos)
  queryBuilder = queryBuilder
    .populate('patient', 'fullName')
    .populate('doctor', 'fullName specialty');
  
  // 🔥 OTIMIZAÇÃO: Roda query e count em PARALELO
  const queries = [queryBuilder];
  
  // Só faz count se não pediu para skip
  if (noCount !== 'true') {
    queries.push(Appointment.countDocuments(filter));
  }
  
  const [appointments, total] = await Promise.all(queries);
  
  // 🆕 CALCULAR FLAGS DE LIFECYCLE (isFirstVisit / isReturningAfter45Days)
  const patientIds = [
    ...new Set(
      appointments
        .filter(a => a.patient && typeof a.patient === 'object')
        .map(a => a.patient._id.toString())
    )
  ];
  
  let patientHistoryMap = new Map();
  if (patientIds.length > 0) {
    const histories = await Appointment.find({
      patient: { $in: patientIds.map(id => new mongoose.Types.ObjectId(id)) }
    })
      .select('patient date specialty createdAt')
      .lean();
    
    histories.forEach(h => {
      const pid = h.patient?.toString?.();
      if (!pid) return;
      if (!patientHistoryMap.has(pid)) patientHistoryMap.set(pid, []);
      patientHistoryMap.get(pid).push(h);
    });
  }
  
  const DAY_IN_MS = 1000 * 60 * 60 * 24;
  
  function computeFlags(appt) {
    const pid = appt.patient?._id?.toString?.() || appt.patient?.toString?.();
    
    if (!pid) {
      return { isFirstVisit: true, isReturningAfter45Days: false };
    }
    
    const history = patientHistoryMap.get(pid) || [];
    const ownId = appt._id.toString();
    
    // Ordenar por createdAt (fallback _id para empate)
    const sortedByCreated = [...history].sort((a, b) => {
      const diff = new Date(a.createdAt) - new Date(b.createdAt);
      if (diff !== 0) return diff;
      return a._id.toString().localeCompare(b._id.toString());
    });
    
    const earlierAppointments = sortedByCreated.filter(
      h => h._id.toString() !== ownId &&
        (new Date(h.createdAt) < new Date(appt.createdAt) ||
         (new Date(h.createdAt).getTime() === new Date(appt.createdAt).getTime() &&
          h._id.toString() < ownId))
    );
    const isFirstVisit = earlierAppointments.length === 0;
    
    const sameSpecialty = history
      .filter(h => h.specialty === appt.specialty && h._id.toString() !== ownId)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    
    const earlierSameSpecialty = sameSpecialty.filter(
      h => new Date(h.date) < new Date(appt.date) ||
        (new Date(h.date).getTime() === new Date(appt.date).getTime() &&
         h._id.toString() < ownId)
    );
    
    let isReturningAfter45Days = false;
    if (earlierSameSpecialty.length > 0) {
      const lastPrevious = earlierSameSpecialty[earlierSameSpecialty.length - 1];
      const diffDays = (new Date(appt.date) - new Date(lastPrevious.date)) / DAY_IN_MS;
      isReturningAfter45Days = diffDays >= 45;
    }
    
    return { isFirstVisit, isReturningAfter45Days };
  }
  
  // 🔥 DTO único: nunca mais construir response inline
  const formattedAppointments = appointments.map(appt => {
    const dto = mapAppointmentDTO(appt);
    
    // 🎯 CORREÇÃO: Garantir que o campo date reflita o horário real do agendamento (time)
    if (appt.time && appt.date) {
      try {
        const datePart = moment(appt.date).tz('America/Sao_Paulo').format('YYYY-MM-DD');
        const combined = moment.tz(`${datePart} ${appt.time}`, 'YYYY-MM-DD HH:mm', 'America/Sao_Paulo');
        if (combined.isValid()) {
          dto.date = combined.toDate();
        }
      } catch (e) {
        // fallback: mantém a data original
      }
    }
    
    const flags = computeFlags(appt);
    return {
      ...dto,
      // 🎯 Adicionar balance se existir (para pacotes)
      balance: appt.balance || 0,
      paymentStatus: appt.package
        ? (appt.paymentStatus || 'package_paid')
        : (appt.paymentStatus === 'paid' ? 'paid' : appt.paymentStatus || 'pending'),
      source: appt.package ? 'package' : (appt.metadata?.origin?.source || 'individual'),
      // 🆕 Lifecycle flags
      ...flags
    };
  });
  
  const responseData = {
    appointments: formattedAppointments,
    pagination: {
      page: parseInt(page),
      limit: limitNum,
      total: total || formattedAppointments.length,
      pages: total ? Math.ceil(total / limitNum) : 1
    }
  };
  
  // 🔥 CACHE: Salva no cache se aplicável
  if (cacheKey && Date.now() - startTime < 1000) { // Só cache se foi rápido
    setCached(cacheKey, responseData);
  }
  
  console.log(`[GET /v2/appointments] ⚡ ${Date.now() - startTime}ms | ${formattedAppointments.length} items`);
  
  res.json(formatSuccess(responseData));
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
    .select('operationalStatus clinicalStatus paymentStatus session package patient correlationId canceledReason history');

  if (!appointment) {
    throw createBusinessError(Messages.BUSINESS.APPOINTMENT_NOT_FOUND, 404, ErrorCodes.NOT_FOUND
    );
  }

  // Verifica se o lock foi liberado automaticamente (worker falhou)
  // Se sim, o usuário precisa tentar a operação novamente
  const lastHistoryEntry = appointment.history?.[appointment.history.length - 1];
  const wasLockReleasedAutomatically = lastHistoryEntry?.action === 'auto_release_stale_lock';
  const wasLockReleasedManually = lastHistoryEntry?.action === 'manual_lock_release';
  const wasLockReleased = wasLockReleasedAutomatically || wasLockReleasedManually;

  // Se estiver em processing_complete mas não tem job na fila, corrige o status
  let effectiveOperationalStatus = appointment.operationalStatus;
  if (appointment.operationalStatus === 'processing_complete') {
    const hasActiveJob = await hasActiveJobInQueue(id);
    if (!hasActiveJob) {
      effectiveOperationalStatus = 'scheduled';
    }
  }

  const isProcessing =
    effectiveOperationalStatus === 'processing_create' ||
    effectiveOperationalStatus === 'processing_cancel' ||
    effectiveOperationalStatus === 'processing_complete';

  // Estados terminais positivos (worker concluiu com sucesso)
  // 🚨 IMPORTANTE: 
  // - Não pode estar em processamento
  // - Não pode ter sido liberado por erro (lockReleased) - nesse caso o usuário precisa tentar de novo
  // 🎯 CRM: operationalStatus é a fonte da verdade para controle
  const isResolved =
    !isProcessing && 
    !wasLockReleased && (
      effectiveOperationalStatus === 'scheduled' ||
      effectiveOperationalStatus === 'confirmed' ||
      effectiveOperationalStatus === 'paid' ||
      effectiveOperationalStatus === 'missed' ||
      effectiveOperationalStatus === 'completed'
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
        operationalStatus: effectiveOperationalStatus,
        clinicalStatus: appointment.clinicalStatus,
        paymentStatus: appointment.paymentStatus,
        statusMessage: statusMessages[effectiveOperationalStatus] || effectiveOperationalStatus,
        isProcessing,
        isResolved,   // ← front usa isso para saber que pode parar o polling
        // 🎯 CRM: operationalStatus é a fonte da verdade
        isCompleted: effectiveOperationalStatus === 'completed',
        isCanceled: effectiveOperationalStatus === 'canceled',
        wasLockReleased,  // ← indica se o lock foi liberado por erro (usuário precisa tentar de novo)
        wasLockReleasedAutomatically,  // ← específico: liberado automaticamente porque não tinha job na fila
        canCancel: 
          effectiveOperationalStatus !== 'canceled' &&
          effectiveOperationalStatus !== 'completed' &&
          !isProcessing,
        canComplete:
          effectiveOperationalStatus !== 'canceled' &&
          effectiveOperationalStatus !== 'completed' &&
          !isProcessing,
        canceledReason: appointment.canceledReason,
        correlationId: appointment.correlationId,
        hasSession: !!appointment.session,
        hasPackage: !!appointment.package
      },
      isProcessing ? {
        message: Messages.INFO.ASYNC_PROCESSING,
        retryIn: '2s'
      } : wasLockReleased ? {
        message: 'Operação falhou. Por favor, tente novamente.',
        retry: true
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
      throw createBusinessError(Messages.BUSINESS.APPOINTMENT_NOT_FOUND, 404, ErrorCodes.NOT_FOUND);
    }
    
    // 2. Verificar permissões (médico só edita o próprio)
    if (req.user.role === 'doctor' && appointment.doctor.toString() !== req.user.id) {
      await mongoSession.abortTransaction();
      throw createBusinessError('Acesso não autorizado', 403, ErrorCodes.UNAUTHORIZED);
    }
    
    // 🛡️ PROTEÇÃO CRÍTICA: appointment completed só pode ter campos não-financeiros editados
    if (appointment.operationalStatus === 'completed') {
      const allowedFieldsWhenCompleted = ['notes', 'clinicalStatus', 'cancellationReason', 'metadata'];
      const attemptedChanges = Object.keys(req.body);
      const disallowedChanges = attemptedChanges.filter(f => !allowedFieldsWhenCompleted.includes(f));
      
      if (disallowedChanges.length > 0) {
        await mongoSession.abortTransaction();
        throw createBusinessError(
          `Não é possível editar campos de um agendamento já completado. Campos bloqueados: ${disallowedChanges.join(', ')}. Para alterar dados financeiros/operacionais, cancele e recrie o agendamento.`,
          409,
          'CANNOT_EDIT_COMPLETED_APPOINTMENT'
        );
      }
    }
    
    const updateData = {
      ...req.body,
      doctor: req.body.doctorId || appointment.doctor,
      updatedAt: new Date()
    };

    // Garante patientInfo — busca do paciente se veio vazio ou zerado (dos dois lados)
    const hasValidPatientInfo = updateData.patientInfo?.fullName && updateData.patientInfo.fullName.trim() !== '';
    if (!hasValidPatientInfo) {
      const pid = appointment.patient || updateData.patientId || req.body.patientId;
      if (pid) {
        try {
          const pat = await Patient.findById(pid).select('fullName name phone dateOfBirth email').lean();
          if (pat) {
            updateData.patientInfo = {
              fullName: pat.fullName || pat.name || '',
              phone: pat.phone || updateData.patientInfo?.phone || '',
              birthDate: pat.dateOfBirth || updateData.patientInfo?.birthDate || null,
              email: pat.email || updateData.patientInfo?.email || null,
            };
            console.log('[PUT /appointments] patientInfo reconstruído do Patient:', pid, updateData.patientInfo.fullName);
          }
        } catch (e) {
          console.warn('[PUT /appointments] falha ao buscar paciente para patientInfo:', e.message);
        }
      }
    } else if (updateData.patientInfo && !updateData.patientInfo.phone && appointment.patientInfo?.phone) {
      updateData.patientInfo.phone = appointment.patientInfo.phone;
    }

    // 🎯 CAPTURAR DADOS PARA SIDE EFFECTS (antes de alterar)
    // Importante: capturar o estado ANTES da atualização
    const previousDoctorId = appointment.doctor?.toString();
    const newDoctorId = req.body.doctorId;
    const patientIdForSideEffect = appointment.patient;
    const shouldUpdatePatient = !!(newDoctorId && previousDoctorId !== newDoctorId);
    
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
      // 🔒 Verifica se payment já está pago - se sim, não atualiza campos financeiros
      const existingPayment = await Payment.findById(appointment.payment).session(mongoSession).lean();
      
      if (existingPayment?.status === 'paid') {
        // Payment já pago: só atualiza campos não-financeiros (doctor, serviceDate, serviceType)
        console.log(`[PUT /appointments/${id}] Payment já pago (${existingPayment._id}), ignorando alterações financeiras`);
        const paymentUpdate = Payment.findByIdAndUpdate(
          appointment.payment,
          {
            $set: {
              doctor: updateData.doctor || appointment.doctor,
              serviceDate: updateData.date || appointment.date,
              serviceType: updateData.serviceType || appointment.serviceType,
              updatedAt: new Date()
            }
          },
          { session: mongoSession, new: true }
        );
        updatePromises.push(paymentUpdate);
      } else {
        // Payment pendente: pode atualizar tudo
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
      }
    } else if (!appointment.package && !appointment.payment && (updateData.paymentAmount > 0 || updateData.billingType === 'convenio')) {
      // 🛡️ HARDENING: Só cria Payment no PUT se NÃO existir anterior E houver valor real ou convenio
      console.warn(`[PUT /appointments/${id}] ⚠️ Criando novo payment via fluxo de edição. Idealmente payment só deveria ser criado no complete.`, {
        appointmentId: appointment._id,
        amount: updateData.paymentAmount,
        billingType: updateData.billingType
      });
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
        paymentDate: new Date(),
        paidAt: updateData.billingType === 'convenio' ? undefined : new Date(),
        kind: 'session_payment',
        notes: `Pagamento registrado via edição V2 - ${new Date().toLocaleString('pt-BR')}`
      });
      
      await newPayment.save({ session: mongoSession });
      appointment.payment = newPayment._id;
      appointment.paymentStatus = updateData.billingType === 'convenio' ? 'pending' : 'paid';
      await appointment.save({ session: mongoSession });
    }
    
    // 🚀 FASE 2 EXTRAÇÃO: Package movido para side effects async
    // Antes: Atualização síncrona na transaction
    // Agora: Processado por appointment-integration worker
    
    // 🚀 FASE 1 EXTRAÇÃO: Patient movido para side effects async
    // Antes: Atualização síncrona na transaction
    // Agora: Processado por appointment-integration worker
    // Motivo: Baixo risco, não afeta dados financeiros críticos
    // Validação: Verificar logs do worker para confirmar atualização
    
    await Promise.all(updatePromises);
    await mongoSession.commitTransaction();
    transactionCommitted = true;  // ✅ Marca como commitado
    
    // 🚀 EVENT ENRICHED: Inclui dados para side effects async
    // FASE 1: Enriquecer evento (preparação para extração)
    // FASE 2: Mover side effects para worker (próximo passo)
    
    const sideEffectsPayload = {
      // Payment update data
      payment: {
        shouldUpdate: !appointment.package && !!appointment.payment,
        paymentId: appointment.payment,
        isNewPayment: !appointment.package && (updateData.billingType || updateData.paymentAmount > 0) && !appointment.payment,
        updateData: {
          doctor: updateData.doctor || appointment.doctor,
          amount: updateData.paymentAmount || updateData.amount,
          paymentMethod: updateData.paymentMethod || appointment.paymentMethod,
          serviceDate: updateData.date || appointment.date,
          serviceType: updateData.sessionType || appointment.serviceType,
          billingType: updateData.billingType || appointment.billingType,
          insuranceProvider: updateData.insuranceProvider,
          insuranceValue: updateData.insuranceValue,
          authorizationCode: updateData.authorizationCode
        }
      },
      // Package update data (EXTRAÍDO - FASE 2)
      // Processado async por appointment-integration worker
      package: {
        shouldUpdate: !!(appointment.package && appointment.serviceType === 'package_session'),
        packageId: appointment.package,
        updateData: {
          doctor: updateData.doctor || appointment.doctor,
          sessionValue: updateData.paymentAmount || appointment.paymentAmount
        },
        _extracted: true,  // 🚀 Marcador FASE 2
        _extractionPhase: 'FASE_2_PACKAGE'
      },
      // Patient update data (EXTRAÍDO - FASE 1)
      // Processado async por appointment-integration worker
      // Usa variáveis capturadas ANTES da atualização do appointment
      patient: {
        shouldUpdate: shouldUpdatePatient,
        patientId: patientIdForSideEffect,
        newDoctorId: newDoctorId,
        _extracted: true,  // 🚀 Marcador de extração
        _extractionPhase: 'FASE_1_PATIENT',
        _previousDoctorId: previousDoctorId  // Debug
      }
    };
    
    // 🚀 LOG PARA DEBUG
    console.log(`[PUT Appointment V2] Publicando APPOINTMENT_UPDATED:`, {
      appointmentId: updatedAppointment._id.toString(),
      shouldUpdatePatient: shouldUpdatePatient,
      patientId: patientIdForSideEffect?.toString(),
      newDoctorId: newDoctorId,
      sideEffects: {
        patient: sideEffectsPayload.patient.shouldUpdate,
        package: sideEffectsPayload.package.shouldUpdate,
        payment: sideEffectsPayload.payment.shouldUpdate
      }
    });
    
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
      timestamp: new Date(),
      // 🎯 SIDE EFFECTS DATA (para processamento async)
      sideEffects: sideEffectsPayload,
      _meta: {
        version: '2.1-event-enriched',
        extractedAt: new Date().toISOString()
      }
    });
    
    clearCache();
    await updatedAppointment.populate('patient', 'fullName name phone dateOfBirth email');
    res.json(formatSuccess({
      appointment: mapAppointmentDTO(updatedAppointment),
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
  
  clearCache();
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
    
    clearCache();
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
    
    clearCache();
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
  
  clearCache();
  res.json(formatSuccess({
    appointmentId: id,
    previousStatus: previousStatus,
    newStatus: newStatus,
    released: true,
    message: `Lock liberado com sucesso. Status alterado de ${previousStatus} para ${newStatus}`
  }));
}));

/**
 * 🔄 POST /api/v2/appointments/:id/revert-complete - Reverter uma sessão completada
 *
 * Regras:
 * - Só permite reverter appointments com operationalStatus === 'completed'
 * - Restaura Session para 'scheduled'
 * - Restaura Appointment para 'scheduled'
 * - Se tiver package: restaura crédito/sessão via FinancialGuard
 * - Se tiver payment: cancela o payment
 * - Registra reversão no Ledger
 * - Reverte débito no PatientBalance se existir
 */
router.post('/:id/revert-complete', flexibleAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason = 'Reversão de agendamento completado' } = req.body;
  const mongoSession = await mongoose.startSession();

  try {
    await mongoSession.startTransaction();

    const appointment = await Appointment.findById(id)
      .session(mongoSession)
      .populate('session patient');

    if (!appointment) {
      await mongoSession.abortTransaction();
      throw createBusinessError(Messages.APPOINTMENT.NOT_FOUND, 404, ErrorCodes.NOT_FOUND);
    }

    if (appointment.operationalStatus !== 'completed') {
      await mongoSession.abortTransaction();
      throw createBusinessError('Só é possível reverter agendamentos concluídos', 409, ErrorCodes.CONFLICT_STATE);
    }

    // 1. Reverte Session
    if (appointment.session) {
      await Session.findByIdAndUpdate(
        appointment.session._id,
        {
          $set: {
            status: 'scheduled',
            completedAt: null,
            isPaid: false,
            paymentStatus: 'unpaid',
            paymentOrigin: null,
            paidAt: null,
            updatedAt: new Date()
          }
        },
        { session: mongoSession }
      );
    }

    // 2. Reverte Appointment
    appointment.operationalStatus = 'scheduled';
    appointment.clinicalStatus = 'pending';
    appointment.completedAt = null;
    appointment.isPaid = false;
    appointment.paymentStatus = 'unpaid';
    appointment.balanceAmount = 0;
    appointment.updatedAt = new Date();
    if (!appointment.history) appointment.history = [];
    appointment.history.push({
      action: 'revert_complete',
      changedBy: req.user?._id,
      timestamp: new Date(),
      context: 'operacional',
      details: { reason, previousStatus: 'completed', newStatus: 'scheduled' }
    });
    await appointment.save({ session: mongoSession });

    // 3. Cancela payment se existir (independentemente do tipo)
    let paymentCanceled = false;
    if (appointment.payment) {
      const paymentId = appointment.payment._id || appointment.payment;
      const payment = await Payment.findById(paymentId).session(mongoSession);
      if (payment && payment.status !== 'canceled') {
        payment.status = 'canceled';
        payment.canceledAt = new Date();
        payment.canceledReason = reason;
        payment.updatedAt = new Date();
        await payment.save({ session: mongoSession });
        paymentCanceled = true;
      }
    }

    // 4. Restaura package via FinancialGuard (usa contexto CANCEL_APPOINTMENT pois semântica é a mesma)
    let packageRestored = false;
    if (appointment.package) {
      const guardResult = await FinancialGuard.execute({
        context: 'CANCEL_APPOINTMENT',
        billingType: 'package',
        payload: {
          appointmentId: id,
          packageId: appointment.package.toString(),
          appointmentStatus: 'completed',
          paymentOrigin: appointment.paymentOrigin,
          sessionValue: appointment.sessionValue || 0,
          confirmedAbsence: false,
          reason
        },
        session: mongoSession
      });
      packageRestored = guardResult?.handled || false;
    }

    // 5. Ledger reversal
    let ledgerReversed = false;
    if (appointment.session) {
      const sessionForReversal = {
        _id: appointment.session._id,
        patient: appointment.patient?._id,
        appointmentId: id,
        sessionValue: appointment.sessionValue || 0,
        paymentMethod: appointment.paymentMethod,
        sessionType: appointment.sessionType,
        insuranceGuide: appointment.insuranceGuide,
        correlationId: appointment.session.correlationId || `complete_${appointment.session._id}`
      };
      await recordSessionCancellationReversal(sessionForReversal, {
        userId: req.user?._id?.toString(),
        userName: req.user?.name,
        correlationId: `revert_${id}_${Date.now()}`,
        reason
      }, mongoSession);
      ledgerReversed = true;
    }

    // 6. Reverte PatientBalance
    let balanceReverted = false;
    if (appointment.patient) {
      const balanceUpdate = await PatientBalance.findOneAndUpdate(
        {
          patient: appointment.patient._id,
          'transactions.appointmentId': appointment._id,
          'transactions.type': 'debit',
          'transactions.isDeleted': false
        },
        {
          $set: {
            'transactions.$.isDeleted': true,
            'transactions.$.deletedAt': new Date(),
            'transactions.$.deleteReason': reason
          },
          $inc: {
            currentBalance: -Math.abs(appointment.sessionValue || 0),
            totalDebited: -Math.abs(appointment.sessionValue || 0)
          }
        },
        { session: mongoSession }
      );
      if (balanceUpdate) balanceReverted = true;
    }

    await mongoSession.commitTransaction();

    // 🔄 Rebuild síncrono da view do pacote
    let viewRebuilt = false;
    if (appointment.package) {
      try {
        const { buildPackageView } = await import('../domains/billing/services/PackageProjectionService.js');
        await buildPackageView(appointment.package.toString(), { correlationId: id });
        viewRebuilt = true;
      } catch (viewErr) {
        console.warn(`[revert-complete] ⚠️ Erro ao reconstruir view:`, viewErr.message);
      }
    }

    clearCache();
    res.json(formatSuccess({
      appointmentId: id,
      status: 'scheduled',
      paymentCanceled,
      packageRestored,
      ledgerReversed,
      balanceReverted,
      viewRebuilt,
      message: 'Agendamento revertido com sucesso'
    }));
  } catch (error) {
    await mongoSession.abortTransaction();
    throw error;
  } finally {
    mongoSession.endSession();
  }
}));

export default router;
