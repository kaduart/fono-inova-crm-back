/**
 * Insurance Plans V2
 * Rotas para criar planos de atendimento de convênio
 * e gerar appointments + payments pendentes automaticamente
 */
import express from 'express';
import mongoose from 'mongoose';
import { auth } from '../middleware/auth.js';
import InsurancePlan from '../models/InsurancePlan.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import Convenio from '../models/Convenio.js';
import { generateInsurancePlanSessions } from '../services/schedule/generateInsurancePlanSessions.js';

const router = express.Router();

const VALID_SPECIALTIES = [
  'fonoaudiologia', 'psicologia', 'fisioterapia', 'psicomotricidade',
  'terapia_ocupacional', 'musicoterapia', 'psicopedagogia', 'neuropsicologia'
];

/**
 * POST /api/v2/insurance-plans
 * Cria plano de convênio e gera appointments + payments pendentes
 */
router.post('/', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      guideId,
      doctorId,
      specialty,
      sessionsPerWeek,
      startDate,
      slots,
      sessionValue = 0,
      notes
    } = req.body;

    if (!guideId || !doctorId || !specialty || !sessionsPerWeek || !startDate || !slots?.length) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        errorCode: 'VALIDATION_ERROR',
        message: 'Campos obrigatórios: guideId, doctorId, specialty, sessionsPerWeek, startDate, slots'
      });
    }

    if (!VALID_SPECIALTIES.includes(specialty)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_SPECIALTY',
        message: `Especialidade inválida. Válidas: ${VALID_SPECIALTIES.join(', ')}`
      });
    }

    const guide = await InsuranceGuide.findById(guideId).session(session);
    if (!guide) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, errorCode: 'GUIDE_NOT_FOUND', message: 'Guia não encontrada' });
    }

    // Busca valor real do convênio; usa sessionValue do body como fallback
    const convenioValue = await Convenio.getSessionValue(guide.insurance).catch(() => null);
    const resolvedSessionValue = convenioValue || Number(sessionValue) || 0;

    const totalSessions = guide.totalSessions - guide.usedSessions;
    if (totalSessions <= 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, errorCode: 'GUIDE_EXHAUSTED', message: 'Guia sem sessões disponíveis' });
    }

    // 🔄 Se já existe plano para esta guia (qualquer status), remove o antigo e cria novo
    const existingPlan = await InsurancePlan.findOne({ guide: guideId }).session(session);
    if (existingPlan) {
      const today = new Date().toISOString().split('T')[0];
      // Cancela appointments futuros do plano antigo
      await Appointment.updateMany(
        {
          _id: { $in: existingPlan.generatedAppointments },
          operationalStatus: 'scheduled',
          date: { $gte: today }
        },
        { $set: { operationalStatus: 'canceled', cancellationReason: 'plan_reset' } },
        { session }
      );
      // Remove payments pendentes do plano antigo
      await Payment.deleteMany(
        { insurancePlan: existingPlan._id, status: 'pending' },
        { session }
      );
      // Remove o plano antigo (hard delete) para liberar a unique index
      await InsurancePlan.deleteOne({ _id: existingPlan._id }, { session });
    }

    // Cria o novo plano
    const plan = await InsurancePlan.create([{
      patient: guide.patientId,
      guide: guideId,
      doctor: doctorId,
      specialty,
      totalSessions,
      sessionsPerWeek,
      startDate: new Date(startDate),
      slots,
      status: 'active',
      notes,
      createdBy: req.user?.id
    }], { session });

    const planDoc = plan[0];

    // Gera appointments + sessions + payments (padrão liminar: semana a semana, pula feriados)
    const result = await generateInsurancePlanSessions({
      planId: planDoc._id,
      guideId,
      sessionValue: resolvedSessionValue,
      mongoSession: session,
      skipHolidays: true
    });

    await session.commitTransaction();

    res.status(201).json({
      success: true,
      data: {
        plan: {
          _id: planDoc._id,
          guideId,
          doctorId,
          specialty,
          totalSessions,
          sessionsPerWeek,
          startDate,
          status: 'active',
          generatedAppointmentsCount: result.count
        },
        appointments: result.appointments.map(a => ({
          _id: a._id,
          date: a.date,
          time: a.time,
          status: a.operationalStatus
        }))
      }
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('[InsurancePlansV2] Erro:', error);

    // Mensagens amigáveis para erros conhecidos
    let message = 'Erro interno no servidor. Tente novamente em alguns instantes.';
    let statusCode = 500;
    let errorCode = 'INTERNAL_ERROR';

    if (error.code === 11000 || error.message?.includes('E11000')) {
      // Duplicate key — unique index violado
      const fieldMatch = error.message?.match(/dup key:\s*\{\s*([^:]+)/);
      const field = fieldMatch ? fieldMatch[1].trim() : 'registro';
      if (field.includes('guide')) {
        message = 'Já existe um plano para esta guia. Cancele o plano anterior antes de criar um novo.';
      } else {
        message = `Este ${field} já está em uso. Escolha outro valor.`;
      }
      statusCode = 409;
      errorCode = 'DUPLICATE_KEY';
    } else if (error.message === 'PLAN_NOT_FOUND') {
      message = 'Plano não encontrado. Recarregue a página e tente novamente.';
      statusCode = 404;
      errorCode = 'PLAN_NOT_FOUND';
    } else if (error.message?.startsWith('PLAN_NOT_ACTIVE')) {
      message = 'Este plano não está ativo. Cancele e crie um novo.';
      statusCode = 400;
      errorCode = 'PLAN_NOT_ACTIVE';
    } else if (error.message === 'GUIDE_NOT_FOUND') {
      message = 'Guia do convênio não encontrada. Verifique os dados e tente novamente.';
      statusCode = 404;
      errorCode = 'GUIDE_NOT_FOUND';
    } else if (error.message === 'GUIDE_EXHAUSTED') {
      message = 'Esta guia não tem mais sessões disponíveis.';
      statusCode = 400;
      errorCode = 'GUIDE_EXHAUSTED';
    } else if (error.message?.includes('ValidationError')) {
      message = 'Dados inválidos. Verifique os campos preenchidos e tente novamente.';
      statusCode = 400;
      errorCode = 'VALIDATION_ERROR';
    } else if (error.name === 'CastError') {
      message = 'Formato de dados inválido. Verifique os IDs informados.';
      statusCode = 400;
      errorCode = 'CAST_ERROR';
    }

    res.status(statusCode).json({ success: false, errorCode, message });
  } finally {
    session.endSession();
  }
});

/**
 * GET /api/v2/insurance-plans/guide/:guideId
 * Busca plano por guia
 */
router.get('/guide/:guideId', auth, async (req, res) => {
  try {
    const { guideId } = req.params;
    const plan = await InsurancePlan.findOne({ guide: guideId })
      .populate('generatedAppointments', 'date time operationalStatus specialty')
      .lean();

    if (!plan) {
      return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Plano não encontrado' });
    }

    res.json({ success: true, data: plan });
  } catch (error) {
    console.error('[InsurancePlansV2] Erro ao buscar:', error);
    res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * DELETE /api/v2/insurance-plans/:id
 * Cancela plano e cancela appointments futuros não completados
 */
router.delete('/:id', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;
    const plan = await InsurancePlan.findById(id).session(session);
    if (!plan) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Plano não encontrado' });
    }

    const today = new Date().toISOString().split('T')[0];

    // Cancela appointments futuros scheduled
    await Appointment.updateMany(
      {
        _id: { $in: plan.generatedAppointments },
        operationalStatus: 'scheduled',
        date: { $gte: today }
      },
      { $set: { operationalStatus: 'canceled', cancellationReason: 'plan_canceled' } },
      { session }
    );

    // Remove payments pendentes futuros
    await Payment.deleteMany(
      {
        insuranceGuide: plan.guide,
        status: 'pending',
        appointment: { $in: plan.generatedAppointments }
      },
      { session }
    );

    plan.status = 'canceled';
    await plan.save({ session });

    await session.commitTransaction();
    res.json({ success: true, message: 'Plano cancelado com sucesso' });

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: error.message });
  } finally {
    session.endSession();
  }
});

export default router;
