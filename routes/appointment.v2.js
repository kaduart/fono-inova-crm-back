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
import { syncEvent } from '../services/syncService.js';
import readRouter from './appointmentReads.js';
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

// Atualizar agendamento
router.put(
  '/:id',
  validateId,
  auth,
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
    let session = null;
    const startTime = Date.now();

    try {
        const { id } = req.params;
        const { addToBalance = false, balanceAmount = 0, balanceDescription = '' } = req.body;

        console.log(`[complete] Iniciando - addToBalance: ${addToBalance}, patientId: ${req.body.patientId || 'n/a'}`);

        const appointment = await Appointment.findById(id)
            .populate('session patient doctor payment')
            .populate({ path: 'package', populate: { path: 'payments' } })
            .lean();

        if (!appointment) {
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }

        const sessionId = appointment.session?._id || appointment.session;
        const paymentId = appointment.payment?._id || appointment.payment;
        const packageId = appointment.package?._id || appointment.package;
        const patientId = appointment.patient?._id || appointment.patient;

        const isConvenioSession = appointment.billingType === 'convenio' ||
                                  appointment.insuranceProvider ||
                                  appointment.paymentMethod === 'convenio';

        const shouldIncrementPackage = appointment.package && appointment.clinicalStatus !== 'completed';

        session = await mongoose.startSession();
        session.startTransaction();

        // 1️⃣ ATUALIZAR SESSÃO
        const sessionUpdateData = addToBalance ? {
            status: 'completed', isPaid: false, paymentStatus: 'pending',
            addedToBalance: true, balanceAmount: balanceAmount || appointment.sessionValue || 0,
            visualFlag: 'pending', updatedAt: new Date()
        } : isConvenioSession ? {
            status: 'completed', isPaid: false, paymentStatus: 'pending',
            visualFlag: 'pending', updatedAt: new Date()
        } : {
            status: 'completed', isPaid: true, paymentStatus: 'paid',
            visualFlag: 'ok', updatedAt: new Date()
        };

        if (sessionId) {
            await Session.findOneAndUpdate({ _id: sessionId }, sessionUpdateData, { session });
        }

        // 2️⃣ ATUALIZAR PAYMENT
        if (!addToBalance && !isConvenioSession) {
            let finalPaymentId = paymentId;

            if (!finalPaymentId && !packageId) {
                const orphanPayment = await Payment.findOne({ appointment: appointment._id }, { _id: 1 }, { session });
                if (orphanPayment) {
                    finalPaymentId = orphanPayment._id;
                    await Appointment.updateOne({ _id: appointment._id }, { $set: { payment: finalPaymentId } }, { session });
                }
            }

            if (finalPaymentId) {
                const existingPayment = await Payment.findOne({ _id: finalPaymentId }, { status: 1 }, { session });
                const updateData = existingPayment?.status === 'paid'
                    ? { status: 'paid', updatedAt: new Date() }
                    : { status: 'paid', paymentDate: moment().tz("America/Sao_Paulo").format("YYYY-MM-DD"), updatedAt: new Date() };
                await Payment.updateOne({ _id: finalPaymentId }, { $set: updateData }, { session });
            }
        }

        // 3️⃣ ATUALIZAR PACOTE
        let packageDoc = null;
        if (shouldIncrementPackage && packageId) {
            packageDoc = await Package.findOne({ _id: packageId }, { type: 1, sessionsDone: 1, totalSessions: 1 }, { session });
            await Package.updateOne(
                { _id: packageId, $expr: { $lt: ["$sessionsDone", "$totalSessions"] } },
                { $inc: { sessionsDone: 1 }, $set: { updatedAt: new Date() } },
                { session }
            );
        }

        // 4️⃣ ATUALIZAR AGENDAMENTO
        const historyEntry = {
            action: addToBalance ? 'confirmed_with_balance' : 'confirmed',
            newStatus: 'confirmed',
            changedBy: req.user._id,
            timestamp: new Date(),
            context: 'operacional',
            details: addToBalance ? { addedToBalance: true, amount: balanceAmount || appointment.sessionValue || 0 } : undefined
        };

        const updateData = {
            operationalStatus: 'confirmed',
            clinicalStatus: 'completed',
            completedAt: new Date(),
            updatedAt: new Date(),
            visualFlag: 'ok',
            $push: { history: historyEntry }
        };

        if (addToBalance) {
            updateData.paymentStatus = 'pending';
            updateData.visualFlag = 'pending';
            updateData.addedToBalance = true;
            updateData.balanceAmount = balanceAmount || appointment.sessionValue || 0;
            updateData.balanceDescription = balanceDescription || 'Sessão utilizada - pagamento pendente';
        } else if (packageId) {
            if (packageDoc && packageDoc.type === 'convenio') {
                updateData.paymentStatus = 'pending_receipt';
                updateData.visualFlag = 'pending';
            } else {
                updateData.paymentStatus = 'package_paid';
            }
        } else if (isConvenioSession) {
            updateData.paymentStatus = 'pending_receipt';
            updateData.visualFlag = 'pending';
        } else {
            updateData.paymentStatus = 'pending';
            updateData.visualFlag = 'pending';
        }

        await Appointment.updateOne({ _id: id }, updateData, { session });

        await session.commitTransaction();

        // 5️⃣ SALDO DEVEDOR (pós-commit)
        if (addToBalance && patientId) {
            try {
                const patientBalance = await PatientBalance.getOrCreate(patientId);
                const specialtyMap = {
                    'tongue_tie_test': 'fonoaudiologia',
                    'neuropsych_evaluation': 'psicologia',
                    'evaluation': appointment.specialty || 'fonoaudiologia'
                };
                const normalizedSpecialty = (appointment.serviceType && specialtyMap[appointment.serviceType])
                    ? specialtyMap[appointment.serviceType]
                    : appointment.specialty;
                await patientBalance.addDebit(
                    balanceAmount || appointment.sessionValue || 0,
                    balanceDescription || `Sessão ${appointment.date} - pagamento pendente`,
                    sessionId, appointment._id, req.user?._id,
                    normalizedSpecialty, appointment.correlationId
                );
            } catch (err) {
                console.error(`[complete] ❌ Erro ao atualizar saldo (não crítico): ${err.message}`);
            }
        }

        const finalAppointment = await Appointment.findById(id)
            .populate('session package patient doctor payment');

        setImmediate(async () => {
            try { await syncEvent(finalAppointment, 'appointment'); } catch (e) { /* não crítico */ }
        });

        res.json(finalAppointment);

    } catch (error) {
        if (session) {
            try { await session.abortTransaction(); } catch (e) { /* silenciar */ }
        }
        console.error(`[complete] ❌ Erro:`, error);
        res.status(500).json({
            error: 'Erro interno no servidor',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (session) {
            try { session.endSession(); } catch (e) { /* silenciar */ }
        }
    }
});

// ======================================================================
// READ ENDPOINTS (migrados para appointmentReads.js)
// ======================================================================

router.use('/', readRouter);

export default router;
