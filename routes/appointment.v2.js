/**
 * ROTAS V2 - Appointments
 *
 * Sistema único de escrita para agendamentos.
 *
 * Regras:
 * - Writes (POST, PUT, PATCH, DELETE) são implementados aqui via appointmentV2Service
 * - Reads (GET) foram migrados para appointmentReads.js
 * - Rotas específicas devem vir antes das genéricas
 */

import express from 'express';
import mongoose from 'mongoose';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import { auth } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import { checkPackageAvailability } from '../middleware/checkPackageAvailability.js';
import { checkAppointmentConflicts } from '../middleware/conflictDetection.js';
import { handleAdvancePayment } from '../helpers/handleAdvancePayment.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import Package from '../models/Package.js';
import PatientBalance from '../models/PatientBalance.js';
import moment from 'moment-timezone';
import { clearCashflowCache } from './cashflow.v2.js';
import { completeSessionV2 } from '../services/completeSessionService.v2.js';
import { recordAudit } from '../services/auditLogService.js';
import { normalizeAdminEditPayload } from '../utils/adminEditPayloadNormalizer.js';
import completeInsuranceAppointmentCommand from '../services/appointment/commands/completeInsuranceAppointmentCommand.js';
import { getInsuranceFlowConfig } from '../config/insuranceFlowConfig.js';
import { logMetric } from '../utils/logMetric.js';

/**
 * Normaliza método de pagamento do appointment para o schema Payment.
 */
function mapPaymentMethod(method) {
  const map = {
    'dinheiro': 'cash',
    'pix': 'pix',
    'credit_card': 'credit_card',
    'cartao_credito': 'credit_card',
    'cartao_debito': 'debit_card',
    'debit_card': 'debit_card',
    'cartao': 'credit_card',
    'transferencia': 'bank_transfer',
    'convenio': 'convenio',
    'liminar_credit': 'liminar_credit'
  };
  return map[method] || method || 'pix';
}
import { execute as rescheduleAppointment } from '../services/appointment/commands/rescheduleAppointmentCommand.js';
import readRouter from './appointmentReads.js';
import { isInsuranceAppointment } from '../utils/appointmentMapper.js';
import {
  createAppointment,
  updateAppointment,
  cancelAppointment,
  confirmAppointment,
  updateClinicalStatus,
  deleteAppointment,
  postAppointment,
} from '../services/appointmentV2Service.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const router = express.Router();

// ======================================================================
// Lista de convênios para o select da agenda (somente leitura).
// Devolve só o necessário para a agenda preencher o valor: tabela por terapia
// existe apenas no convênio Base (resolveConvenioSessionValue).
// ======================================================================
router.get('/convenio-options', flexibleAuth, async (req, res) => {
  try {
    const { default: Convenio } = await import('../models/Convenio.js');
    const convenios = await Convenio.find({ active: true })
      .select('code name sessionValue specialtyValues')
      .sort({ name: 1 })
      .lean();
    res.json({
      success: true,
      data: convenios.map((c) => ({
        code: c.code,
        name: c.name,
        sessionValue: c.sessionValue || 0,
        specialtyValues: c.code === 'base' ? (c.specialtyValues || []) : [],
        supportsAba: c.code === 'base',
      })),
    });
  } catch (error) {
    sendApiError(res, error, req);
  }
});

// ======================================================================
// V2-ONLY: status polling para criação async
// ======================================================================
router.get('/:id/status', flexibleAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'ID inválido', { status: 400 }), req);
    }
    const appt = await Appointment.findById(id)
      .select('_id operationalStatus clinicalStatus paymentStatus date specialty patient')
      .lean();
    if (!appt) {
      return sendApiError(res, new AppError('NOT_FOUND', 'Agendamento não encontrado', { status: 404 }), req);
    }
    return res.json({ success: true, data: appt });
  } catch (err) {
    return sendApiError(res, err, req);
  }
});

// ======================================================================
// V2-ONLY: sugestões de agenda
// ======================================================================
router.post('/agenda/suggestions', flexibleAuth, async (req, res) => {
  try {
    const { specialty, doctorId, preferredDates, patientId } = req.body;
    const now = new Date();
    const until = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const existingAppts = await Appointment.find({
      ...(doctorId ? { doctor: doctorId } : {}),
      ...(specialty ? { specialty } : {}),
      date: { $gte: now, $lte: until },
      operationalStatus: { $in: ['scheduled', 'confirmed'] },
    })
      .select('date time doctor specialty')
      .lean();

    return res.json({
      success: true,
      data: {
        suggestions: [],
        occupied: existingAppts.length,
        note: 'Use GET /available-slots para slots detalhados',
      },
    });
  } catch (err) {
    return sendApiError(res, err, req);
  }
});

// ======================================================================
// WRITE ENDPOINTS
// ======================================================================

// Criar agendamento
router.post('/', flexibleAuth, checkPackageAvailability, checkAppointmentConflicts, async (req, res) => {
  try {
    // Pagamento adiantado continua usando helper legado especializado
    if (req.body.isAdvancePayment || (req.body.advanceSessions && req.body.advanceSessions.length > 0)) {
      return await handleAdvancePayment(req, res);
    }

    const result = await createAppointment(req.body, req.user);
    return res.status(201).json({
      success: true,
      data: result.data,
      message: result.message,
    });
  } catch (err) {
    console.error('[POST /api/v2/appointments] erro:', err);

    const errorMap = {
      NO_INSURANCE_GUIDE: 400,
      GUIDE_DEPLETED: 400,
      GUIDE_EXPIRED: 400,
      SCHEDULE_CONFLICT: 409,
      MISSING_FIELDS: 400,
      MISSING_PACKAGE_ID: 400,
      PACKAGE_NOT_FOUND: 404,
      MISSING_DATE_TIME: 400,
      SESSION_NOT_FOUND: 404,
      WRITE_CONFLICT: 409,
      VALIDATION_ERROR: 400,
      INVALID_ID: 400,
    };

    if (!err.status && errorMap[err.code]) err.status = errorMap[err.code];
    if (err.fields) err.extra = { ...(err.extra || {}), fields: err.fields };
    return sendApiError(res, err, req);
  }
});

// Edição administrativa de agendamento (usada pela Agenda Externa para appointments completed)
// Fase 1: mesmo command de update, com adapter de payload para manter uma única regra de domínio.
router.patch(
  '/:id/admin-edit',
  validateId,
  flexibleAuth,
  checkPackageAvailability,
  checkAppointmentConflicts,
  async (req, res) => {
    try {
      const { id } = req.params;
      const normalizedPayload = normalizeAdminEditPayload(req.body);

      const result = await updateAppointment(id, normalizedPayload, req.user);
      return res.json({
        success: true,
        data: result.data,
        message: result.message || 'Agendamento atualizado administrativamente',
      });
    } catch (err) {
      console.error(`[PATCH /api/v2/appointments/${req.params.id}/admin-edit] erro:`, err);

      if (err.fields) err.extra = { ...(err.extra || {}), fields: err.fields };
      return sendApiError(res, err, req);
    }
  }
);

// Remarcação rápida (botão "Mudar data" / arrastar no calendário).
// Body: { date: 'YYYY-MM-DD', time: 'HH:mm', reason? }. Só valida regras de remarcação
// (status, passado, validade de guia/liminar) e delega ao mesmo updateAppointmentCommand
// do PUT — Session/Payment/Pacote/outbox/socket continuam numa única regra de domínio.
// checkPackageAvailability fica de fora de propósito: pacote só consome no complete (#17).
async function injectRescheduleContext(req, res, next) {
  try {
    const existing = await Appointment.findById(req.params.id)
      .select('doctor patient duration isJointSession operationalStatus')
      .lean();
    if (!existing) {
      return sendApiError(
        res,
        new AppError('APPOINTMENT_NOT_FOUND', 'Agendamento não encontrado', {
          status: 404,
        }),
        req
      );
    }
    // checkAppointmentConflicts lê doctor/patient/duration do body — o cliente só envia date/time.
    req.body.doctorId = existing.doctor?.toString();
    req.body.patientId = existing.patient?.toString();
    req.body.duration = existing.duration;
    req.body.isJointSession = existing.isJointSession;
    if (existing.operationalStatus === 'pre_agendado') {
      req.body.operationalStatus = 'pre_agendado'; // pré-agendamento pode não ter patientId
    }
    return next();
  } catch (err) {
    console.error(`[PATCH /api/v2/appointments/${req.params.id}/reschedule] contexto:`, err);
    return sendApiError(
      res,
      new AppError('INTERNAL_SERVER_ERROR', 'Erro ao preparar remarcação', {
        status: 500,
      }),
      req
    );
  }
}

router.patch(
  '/:id/reschedule',
  validateId,
  flexibleAuth,
  injectRescheduleContext,
  checkAppointmentConflicts,
  async (req, res) => {
    try {
      const { date, time, reason } = req.body;
      const result = await rescheduleAppointment(req.params.id, { date, time, reason }, req.user);
      return res.json({
        success: true,
        data: result.data,
        message: result.message,
      });
    } catch (err) {
      console.error(`[PATCH /api/v2/appointments/${req.params.id}/reschedule] erro:`, err);

      if (err.fields) err.extra = { ...(err.extra || {}), fields: err.fields };
      return sendApiError(res, err, req);
    }
  }
);

// Atualizar agendamento
router.put(
  '/:id',
  validateId,
  flexibleAuth,
  checkPackageAvailability,
  checkAppointmentConflicts,
  async (req, res) => {
    try {
      const result = await updateAppointment(req.params.id, req.body, req.user);
      return res.json({
        success: true,
        data: result.data,
        message: result.message,
      });
    } catch (err) {
      console.error(`[PUT /api/v2/appointments/${req.params.id}] erro:`, err);

      if (err.fields) err.extra = { ...(err.extra || {}), fields: err.fields };
      return sendApiError(res, err, req);
    }
  }
);

// Cancelar agendamento
router.patch('/:id/cancel', validateId, flexibleAuth, async (req, res) => {
  try {
    const { reason, confirmedAbsence = false } = req.body;
    const result = await cancelAppointment(req.params.id, { reason, confirmedAbsence,
      requestContext: { method: req.method, path: req.originalUrl,
        correlationId: req.correlationId || req.get('x-correlation-id') || null }
    }, req.user);
    return res.json({
      success: true,
      data: result.data,
      message: result.message,
    });
  } catch (err) {
    console.error(`[PATCH /api/v2/appointments/${req.params.id}/cancel] erro:`, err);

    return sendApiError(res, err, req);
  }
});

// Confirmar agendamento
router.patch('/:id/confirm', validateId, flexibleAuth, async (req, res) => {
  try {
    const result = await confirmAppointment(req.params.id, req.user);
    return res.json({
      success: true,
      data: result.data,
      message: result.message,
    });
  } catch (err) {
    console.error(`[PATCH /api/v2/appointments/${req.params.id}/confirm] erro:`, err);

    return sendApiError(res, err, req);
  }
});

// Atualizar status clínico
router.patch('/:id/clinical-status', validateId, auth, async (req, res) => {
  try {
    const { status } = req.body;
    const result = await updateClinicalStatus(req.params.id, status, req.user);
    return res.json({
      success: true,
      data: result.data,
      message: result.message,
    });
  } catch (err) {
    console.error(`[PATCH /api/v2/appointments/${req.params.id}/clinical-status] erro:`, err);

    return sendApiError(res, err, req);
  }
});

// Registrar envio pós-atendimento
router.patch('/:id/post-appointment', validateId, flexibleAuth, async (req, res) => {
  try {
    const { step } = req.body;
    const result = await postAppointment(req.params.id, step);
    return res.json({
      success: true,
      data: result.data,
      message: result.message,
    });
  } catch (err) {
    console.error(`[PATCH /api/v2/appointments/${req.params.id}/post-appointment] erro:`, err);

    return sendApiError(res, err, req);
  }
});

// Deletar agendamento
router.delete('/:id', validateId, flexibleAuth, async (req, res) => {
  try {
    const result = await deleteAppointment(req.params.id, req.user);
    return res.json({
      success: true,
      data: result.data,
      message: result.message,
    });
  } catch (err) {
    console.error(`[DELETE /api/v2/appointments/${req.params.id}] erro:`, err);

    return sendApiError(res, err, req);
  }
});

// ======================================================================
// COMPLETAR AGENDAMENTO
// ======================================================================

router.patch('/:id/complete', auth, async (req, res) => {
    const startTime = Date.now();
    const requestId = req.id || req.headers['x-correlation-id'] || `complete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
        const { id } = req.params;
        const { addToBalance = false, balanceAmount = 0, balanceDescription = '' } = req.body;
        const userId = req.user?._id?.toString();

        console.log(`[complete] Iniciando - addToBalance: ${addToBalance}, patientId: ${req.body.patientId || 'n/a'}`);

        logMetric('appointment', 'complete_request_received', {
            requestId,
            appointmentId: id,
            userId,
            addToBalance,
            balanceAmount,
            path: req.path,
            method: req.method,
            userAgent: req.headers['user-agent'],
            ip: req.ip
        });

        const appointment = await Appointment.findById(id).lean();
        if (!appointment) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Agendamento não encontrado', { status: 404 }), req);
        }

        let serviceResult;
        let correlationId = req.headers['x-correlation-id'] || req.id;
        let transitions = [];

        // 🏥 Roteamento financeiro: backend decide se é convênio e usa orquestrador dedicado
        if (isInsuranceAppointment(appointment)) {
            console.log(`[complete] 🏥 Detectado agendamento de convênio — delegando para orquestrador`, {
                appointmentId: id,
                requestId
            });

            if (getInsuranceFlowConfig().useOrchestrator) {
                const commandResult = await completeInsuranceAppointmentCommand.execute(id, {
                    userId: req.user?._id?.toString(),
                    notes: req.body.notes,
                    evolution: req.body.evolution,
                    sessionValue: req.body.sessionValue,
                    forceReconfirm: req.body.forceReconfirm,
                    excludeFromProfessionalPayment: req.body.excludeFromProfessionalPayment,
                    exclusionReason: req.body.exclusionReason,
                    correlationId
                });

                serviceResult = commandResult.completeResult;
                correlationId = commandResult.correlationId || correlationId;
                transitions = commandResult.transitions || [];
            } else {
                serviceResult = await completeSessionV2(id, {
                    notes: req.body.notes,
                    evolution: req.body.evolution,
                    sessionValue: req.body.sessionValue,
                    userId: req.user?._id?.toString(),
                    excludeFromProfessionalPayment: req.body.excludeFromProfessionalPayment,
                    exclusionReason: req.body.exclusionReason,
                    correlationId
                });
            }
        } else {
            serviceResult = await completeSessionV2(id, {
                addToBalance,
                balanceAmount,
                balanceDescription,
                sessionValue: req.body.sessionValue,
                splitMethods: req.body.splitMethods,
                paymentMethod: req.body.paymentMethod,
                notes: req.body.notes,
                evolution: req.body.evolution,
                userId: req.user?._id?.toString(),
                excludeFromProfessionalPayment: req.body.excludeFromProfessionalPayment,
                exclusionReason: req.body.exclusionReason,
                correlationId
            });
        }

        // Preserva contrato de resposta do frontend: Appointment populado
        const populatedAppointment = await Appointment.findById(id)
            .populate('session patient doctor payment package')
            .lean();

        if (populatedAppointment?.date) {
            const apptDateStr = moment.tz(populatedAppointment.date, 'America/Sao_Paulo').format('YYYY-MM-DD');
            clearCashflowCache(apptDateStr);
        }

        const durationMs = Date.now() - startTime;
        console.log(`[complete] ✅ Completo via serviço oficial`, {
            appointmentId: id,
            serviceResult: !!serviceResult.success,
            durationMs
        });

        logMetric('appointment', 'complete_request_success', {
            requestId,
            appointmentId: id,
            userId,
            durationMs,
            serviceSuccess: !!serviceResult.success,
            operationalStatus: populatedAppointment?.operationalStatus,
            clinicalStatus: populatedAppointment?.clinicalStatus,
            paymentStatus: populatedAppointment?.paymentStatus,
            paymentId: populatedAppointment?.payment?._id?.toString?.() || populatedAppointment?.payment?.toString?.()
        });

        return res.json({
            success: true,
            appointment: populatedAppointment,
            processing: {
                async: false,
                status: 'completed',
                correlationId
            },
            billing: {
                type: populatedAppointment?.billingType || serviceResult?.billingType || 'particular'
            },
            transitions
        });

    } catch (error) {
        const durationMs = Date.now() - startTime;
        console.error(`[complete] ❌ Erro:`, error);

        logMetric('appointment', 'complete_request_error', {
            requestId,
            appointmentId: req.params?.id,
            userId: req.user?._id?.toString(),
            durationMs,
            error: error.message,
            stack: error.stack,
            statusCode: error.statusCode || 500
        });

        const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
        const isBusinessError = statusCode < 500;

        // 5xx não expõe a mensagem original ao cliente (só em desenvolvimento, em details).
        const safeError = isBusinessError
            ? Object.assign(error, { status: statusCode })
            : new AppError('INTERNAL_ERROR', 'Erro interno no servidor', {
                status: 500,
                ...(process.env.NODE_ENV === 'development' ? { details: error.message } : {}),
            });
        return sendApiError(res, safeError, req);
    }
});


// ======================================================================
// COMPLETAR AGENDAMENTO DE CONVÊNIO
//
// ✅ ROTEAMENTO UNIFICADO
// O completo de convênio foi unificado em PATCH /:id/complete.
// Não existe mais rota separada POST /:id/complete-insurance.
//
// Fluxo oficial: docs/architecture/CANONICAL_FLOW.md
// ======================================================================

// ======================================================================
// ALTERAR STATUS DE REMUNERAÇÃO DO PROFISSIONAL
// ======================================================================

router.patch('/:id/professional-payment-status', validateId, auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;
    const userId = req.user?._id?.toString();

    if (!['payable', 'non_payable'].includes(status)) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'Status inválido. Use "payable" ou "non_payable".', {
          status: 400,
        }),
        req
      );
    }

    if (!reason || reason.trim().length === 0) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'Motivo é obrigatório ao alterar o status de remuneração.', {
          status: 400,
        }),
        req
      );
    }

    const appointment = await Appointment.findById(id).select('session patient doctor').lean();
    if (!appointment) {
      return sendApiError(res, new AppError('NOT_FOUND', 'Agendamento não encontrado', { status: 404 }), req);
    }

    if (!appointment.session) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'Agendamento não possui sessão vinculada', {
          status: 400,
        }),
        req
      );
    }

    const sessionId = appointment.session.toString();
    const beforeSession = await Session.findById(sessionId).lean();
    if (!beforeSession) {
      return sendApiError(res, new AppError('NOT_FOUND', 'Sessão não encontrada', { status: 404 }), req);
    }

    const update = {
      professionalPaymentStatus: status,
      professionalPaymentOverride: {
        excluded: status === 'non_payable',
        reason: status === 'non_payable' ? reason.trim() : null,
        excludedAt: status === 'non_payable' ? new Date() : null,
        excludedBy: status === 'non_payable' && userId ? new mongoose.Types.ObjectId(userId) : null
      },
      $push: {
        professionalPaymentOverrideHistory: {
          status,
          reason: reason.trim(),
          changedAt: new Date(),
          changedBy: userId ? new mongoose.Types.ObjectId(userId) : null
        }
      }
    };

    const updatedSession = await Session.findByIdAndUpdate(
      sessionId,
      update,
      { new: true }
    ).lean();

    await recordAudit({
      user: userId ? { _id: userId } : null,
      action: 'professional_payment_status_changed',
      entityType: 'Session',
      entityId: sessionId,
      before: beforeSession,
      after: updatedSession,
      source: 'appointment.v2:professional-payment-status',
      correlationId: req.headers['x-correlation-id'] || `pps_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    });

    return res.json({
      success: true,
      data: updatedSession,
      message: `Remuneração do profissional ${status === 'non_payable' ? 'desabilitada' : 'habilitada'} com sucesso.`
    });
  } catch (err) {
    console.error(`[PATCH /api/v2/appointments/${req.params.id}/professional-payment-status] erro:`, err);
    return sendApiError(res, new AppError('INTERNAL_SERVER_ERROR', err.message, { status: 500 }), req);
  }
});

// ======================================================================
// READ ENDPOINTS (migrados para appointmentReads.js)
// ======================================================================

router.use('/', readRouter);

export default router;
