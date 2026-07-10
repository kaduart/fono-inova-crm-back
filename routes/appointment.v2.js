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

const router = express.Router();

// ======================================================================
// V2-ONLY: status polling para criação async
// ======================================================================
router.get('/:id/status', flexibleAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'ID inválido' });
    }
    const appt = await Appointment.findById(id)
      .select('_id operationalStatus clinicalStatus paymentStatus date specialty patient')
      .lean();
    if (!appt) {
      return res.status(404).json({ success: false, error: 'Agendamento não encontrado' });
    }
    return res.json({ success: true, data: appt });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
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
    return res.status(500).json({ success: false, error: err.message });
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

    const status = err.status || errorMap[err.code] || 500;
    return res.status(status).json({
      success: false,
      error: err.message,
      code: err.code || 'INTERNAL_SERVER_ERROR',
      ...(err.fields ? { fields: err.fields } : {}),
    });
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

      const status = err.status || 500;
      return res.status(status).json({
        success: false,
        error: err.message,
        code: err.code || 'INTERNAL_SERVER_ERROR',
        ...(err.fields ? { fields: err.fields } : {}),
      });
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

      const status = err.status || 500;
      return res.status(status).json({
        success: false,
        error: err.message,
        code: err.code || 'INTERNAL_SERVER_ERROR',
        ...(err.fields ? { fields: err.fields } : {}),
      });
    }
  }
);

// Cancelar agendamento
router.patch('/:id/cancel', validateId, flexibleAuth, async (req, res) => {
  try {
    const { reason, confirmedAbsence = false } = req.body;
    const result = await cancelAppointment(req.params.id, { reason, confirmedAbsence }, req.user);
    return res.json({
      success: true,
      data: result.data,
      message: result.message,
    });
  } catch (err) {
    console.error(`[PATCH /api/v2/appointments/${req.params.id}/cancel] erro:`, err);

    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      error: err.message,
      code: err.code || 'INTERNAL_SERVER_ERROR',
    });
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

    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      error: err.message,
      code: err.code || 'INTERNAL_SERVER_ERROR',
    });
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

    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      error: err.message,
      code: err.code || 'INTERNAL_SERVER_ERROR',
    });
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

    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      error: err.message,
      code: err.code || 'INTERNAL_SERVER_ERROR',
    });
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

    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      error: err.message,
      code: err.code || 'INTERNAL_SERVER_ERROR',
    });
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
            return res.status(404).json({ success: false, error: 'Agendamento não encontrado' });
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
                notes: req.body.notes,
                evolution: req.body.evolution,
                userId: req.user?._id?.toString(),
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

        res.status(500).json({
            error: 'Erro interno no servidor',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
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
// READ ENDPOINTS (migrados para appointmentReads.js)
// ======================================================================

router.use('/', readRouter);

export default router;
