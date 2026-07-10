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
import Session from '../models/Session.js';
import Convenio from '../models/Convenio.js';
import { generateInsurancePlanSessions } from '../services/schedule/generateInsurancePlanSessions.js';
import { recordAudit, pickInsurancePlanFields, getInsurancePlanAuditTrail } from '../services/auditLogService.js';
import { executeWithSession as bulkCancelAppointments } from '../services/appointment/commands/bulkCancelAppointmentsCommand.js';
import { GuideLifecycleService } from '../services/guideLifecycle/GuideLifecycleService.js';

const router = express.Router();

// Sessões restantes de uma guia = total autorizado - já faturadas (usedSessions) - já
// agendadas/pendentes (scheduled/pre_agendado/confirmed). Mesma regra usada dentro de
// generateInsurancePlanSessions.js para não deixar o guide ficar sobre-agendado.
async function getGuideRemainingCapacity(guideId, guideTotals, mongoSession) {
  const query = Appointment.countDocuments({
    insuranceGuide: guideId,
    operationalStatus: { $in: ['scheduled', 'pre_agendado', 'confirmed'] }
  });
  if (mongoSession) query.session(mongoSession);
  const reservedCount = await query;
  return Math.max(0, (guideTotals.totalSessions || 0) - (guideTotals.usedSessions || 0) - reservedCount);
}

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
      startDate,
      slots,
      sessionValue = 0,
      notes
    } = req.body;

    if (!guideId || !doctorId || !specialty || !startDate || !slots?.length) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        errorCode: 'VALIDATION_ERROR',
        message: 'Campos obrigatórios: guideId, doctorId, specialty, startDate, slots'
      });
    }

    // sessionsPerWeek nunca é confiado do body: deriva sempre de slots.length
    // (mesmo princípio do fix de 2026-07-07 no PATCH) para eliminar a possibilidade
    // do card "Plano ativo" mostrar uma frequência que não bate com os horários reais.
    const sessionsPerWeek = slots.length;

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

    // Resolve valor da sessão: prioridade 1) body (modal), 2) guia, 3) tabela do convênio
    const convenioValue = await Convenio.getSessionValue(guide.insurance).catch(() => null);
    const resolvedSessionValue = Number(sessionValue) || Number(guide.sessionValue) || convenioValue || 0;

    const lifecycle = await GuideLifecycleService.evaluate(guide, new Date());
    if (!lifecycle.eligibility.canSchedule) {
      await session.abortTransaction();
      const blockingAlert = lifecycle.alerts.find(a => a.severity === 'error');
      return res.status(400).json({
        success: false,
        errorCode: 'GUIDE_NOT_ELIGIBLE',
        message: blockingAlert?.message || 'Guia não elegível para agendamento',
        lifecycle
      });
    }

    const totalSessions = guide.totalSessions - guide.usedSessions;

    // 🔄 Se já existe plano para esta guia (qualquer status), remove o antigo e cria novo
    const existingPlan = await InsurancePlan.findOne({ guide: guideId }).session(session);
    let replacedPlanSnapshot = null;
    if (existingPlan) {
      replacedPlanSnapshot = pickInsurancePlanFields(existingPlan);
      const today = new Date().toISOString().split('T')[0];
      // Cancela appointments futuros do plano antigo
      const oldAppointments = await Appointment.find({
        _id: { $in: existingPlan.generatedAppointments },
        operationalStatus: 'scheduled',
        date: { $gte: today }
      }).session(session).select('_id');

      await bulkCancelAppointments(
        oldAppointments.map(a => a._id),
        { reason: 'plan_reset' },
        req.user,
        session
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
      sessionValue: resolvedSessionValue,
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

    // Audit: plano substituído (se havia um anterior) + plano criado
    if (replacedPlanSnapshot) {
      await recordAudit({
        user: req.user,
        action: 'insurance_plan_replaced',
        entityType: 'InsurancePlan',
        entityId: existingPlan._id,
        before: replacedPlanSnapshot,
        after: null,
        source: 'api:insurance_plans:post',
        pickFn: (x) => x,
        metadata: { guideId, replacedBy: planDoc._id },
      });
    }
    await recordAudit({
      user: req.user,
      action: 'insurance_plan_created',
      entityType: 'InsurancePlan',
      entityId: planDoc._id,
      before: null,
      after: pickInsurancePlanFields(planDoc),
      source: 'api:insurance_plans:post',
      pickFn: (x) => x,
      metadata: { guideId, generatedCount: result.count },
    });

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
      const indexMatch = error.message?.match(/index:\s+(\S+)/);
      const indexName = indexMatch ? indexMatch[1].trim() : '';
      const fieldMatch = error.message?.match(/dup key:\s*\{\s*([^:]+)/);
      const field = fieldMatch ? fieldMatch[1].trim() : 'registro';

      if (indexName.includes('unique_appointment_slot') || (field.includes('doctor') && error.message?.includes('date'))) {
        message = 'Conflito de horário: esta profissional já possui um agendamento em um dos dias/horários selecionados. Escolha outros horários ou datas.';
      } else if (field.includes('guide')) {
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
    } else if (error.code === 'APPOINTMENT_SLOT_CONFLICT') {
      const conflict = error.conflict || {};
      const prefix = conflict.type === 'doctor'
        ? 'Conflito de agenda: o profissional já possui um compromisso'
        : 'Conflito de agenda: o paciente já possui um compromisso';
      message = `${prefix} em ${conflict.date || 'data informada'} às ${conflict.time || 'horário informado'}. Escolha outro horário.`;
      statusCode = 409;
      errorCode = 'APPOINTMENT_SLOT_CONFLICT';
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
      .populate('doctor', 'fullName name specialty')
      .populate('generatedAppointments', 'date time operationalStatus specialty')
      .lean();

    if (!plan) {
      return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Plano não encontrado' });
    }

    // Planos antigos podem não ter sessionValue salvo. Recupera do primeiro payment pendente.
    if (!plan.sessionValue) {
      const payment = await Payment.findOne({
        insurancePlan: plan._id,
        status: 'pending',
        billingType: 'convenio'
      }).select('insurance.grossAmount').lean();

      plan.sessionValue = payment?.insurance?.grossAmount || 0;
    }

    res.json({ success: true, data: plan });
  } catch (error) {
    console.error('[InsurancePlansV2] Erro ao buscar:', error);
    res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * PATCH /api/v2/insurance-plans/:id
 * Atualiza plano de convênio e sincroniza appointments futuros pendentes.
 * Sessões já completadas NÃO são alteradas.
 */
router.patch('/:id', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;
    const { doctorId, sessionValue, slots, notes } = req.body;

    const plan = await InsurancePlan.findById(id).session(session);
    if (!plan) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Plano não encontrado' });
    }

    if (plan.status !== 'active') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, errorCode: 'PLAN_NOT_ACTIVE', message: 'Este plano não está ativo. Cancele e crie um novo.' });
    }

    const beforeSnapshot = pickInsurancePlanFields(plan);
    const today = new Date().toISOString().split('T')[0];

    // Appointments futuros pendentes gerados por este plano
    // 'confirmed' incluído: PATCH de sessionValue/doctor deve propagar mesmo após confirmação
    const affected = await Appointment.find({
      _id: { $in: plan.generatedAppointments },
      date: { $gte: today },
      operationalStatus: { $in: ['scheduled', 'pre_agendado', 'confirmed'] }
    }).select('_id date time patient').session(session).lean();

    // Sincronização de horário se slots mudaram
    const timeSyncMap = new Map();
    const toCancelIds = [];
    if (slots !== undefined) {
      const newDayToTime = new Map((slots || []).map(s => [s.dayOfWeek, s.time]));

      for (const a of affected) {
        const dow = new Date(a.date).getDay();
        const newTime = newDayToTime.get(dow);
        if (newTime) {
          if (newTime !== a.time) timeSyncMap.set(String(a._id), newTime);
        } else {
          toCancelIds.push(a._id);
        }
      }
    }

    // Pré-checagem de conflitos com novo profissional
    const SLOT_BLOCKING_STATUSES = [
      'pre_agendado', 'scheduled', 'confirmed', 'pending', 'paid',
      'missed', 'processing_create', 'processing_complete', 'processing_cancel', 'force_cancelled'
    ];

    if (doctorId && affected.length > 0) {
      const newDoctorObjId = new mongoose.Types.ObjectId(doctorId);
      const movingIds = affected.map(a => a._id);

      const conflicts = await Appointment.find({
        _id: { $nin: movingIds },
        doctor: newDoctorObjId,
        isJointSession: false,
        operationalStatus: { $in: SLOT_BLOCKING_STATUSES },
        $or: affected.map(a => ({
          date: a.date,
          time: timeSyncMap.get(String(a._id)) || a.time
        }))
      }).select('date time patient').populate('patient', 'fullName').session(session).lean();

      if (conflicts.length > 0) {
        await session.abortTransaction();

        const detalhes = conflicts.map(c => {
          const dataFmt = new Date(c.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
          const nomePaciente = c.patient?.fullName || 'paciente não identificado';
          return `${dataFmt} às ${c.time} (já ocupado com ${nomePaciente})`;
        });

        return res.status(409).json({
          success: false,
          errorCode: 'CONFLITO_AGENDA',
          message: `O profissional selecionado já tem agendamento em: ${detalhes.join('; ')}. Ajuste o horário ou escolha outro profissional antes de salvar.`,
          conflicts: conflicts.map(c => ({
            date: c.date,
            time: c.time,
            patientName: c.patient?.fullName || null
          }))
        });
      }
    }

    // Atualiza plano
    if (doctorId !== undefined) plan.doctor = new mongoose.Types.ObjectId(doctorId);
    if (sessionValue !== undefined) plan.sessionValue = Number(sessionValue) || 0;
    if (slots !== undefined) {
      plan.slots = slots;
      // 🚨 FIX (2026-07-07): sessionsPerWeek é campo independente (setado só na criação) e
      // não era recalculado ao editar slots — o card ficava mostrando a frequência antiga
      // (ex: "1x/semana") mesmo depois de adicionar um 2º horário na semana.
      plan.sessionsPerWeek = slots.length;
    }
    if (notes !== undefined) plan.notes = notes;

    await plan.save({ session });

    // Atualiza appointments pendentes (doctor, time e valores)
    const baseSet = {};
    if (doctorId !== undefined) baseSet.doctor = new mongoose.Types.ObjectId(doctorId);
    if (sessionValue !== undefined) {
      baseSet.sessionValue = Number(sessionValue) || 0;
      baseSet.insuranceValue = Number(sessionValue) || 0;
    }

    let appointmentsUpdated = 0;
    if (affected.length > 0 && (Object.keys(baseSet).length > 0 || timeSyncMap.size > 0)) {
      const bulkOps = affected
        .map(a => {
          const set = { ...baseSet };
          const newTime = timeSyncMap.get(String(a._id));
          if (newTime) set.time = newTime;
          return Object.keys(set).length > 0
            ? { updateOne: { filter: { _id: a._id }, update: { $set: set } } }
            : null;
        })
        .filter(Boolean);

      if (bulkOps.length > 0) {
        const result = await Appointment.bulkWrite(bulkOps, { session });
        appointmentsUpdated = result.modifiedCount;
      }
    }

    // Cancela appointments cujo dia da semana saiu do plano
    let appointmentsCanceled = 0;
    if (toCancelIds.length > 0) {
      const cancelRes = await bulkCancelAppointments(
        toCancelIds,
        { reason: 'plan_slot_removed' },
        req.user,
        session
      );
      appointmentsCanceled = cancelRes.canceled;

      await Session.updateMany(
        { appointmentId: { $in: toCancelIds }, status: { $ne: 'completed' } },
        { $set: { status: 'canceled', updatedAt: new Date() } },
        { session }
      );

      await Payment.updateMany(
        { appointment: { $in: toCancelIds }, status: 'pending' },
        { $set: { status: 'canceled', updatedAt: new Date() } },
        { session }
      );
    }

    // Atualiza doctor e sessionValue nas sessions futuras pendentes
    if ((doctorId !== undefined || sessionValue !== undefined) && affected.length > 0) {
      const affectedIds = affected.map(a => a._id);
      const sessionSet = {};
      if (doctorId !== undefined) sessionSet.doctor = new mongoose.Types.ObjectId(doctorId);
      if (sessionValue !== undefined) sessionSet.sessionValue = Number(sessionValue) || 0;

      await Session.updateMany(
        { appointmentId: { $in: affectedIds }, status: { $ne: 'completed' } },
        { $set: { ...sessionSet, updatedAt: new Date() } },
        { session }
      );
    }

    // 🚨 FIX (2026-07-07): sincroniza o novo horário também na Session vinculada.
    // O bloco acima só propagava doctor/sessionValue — time nunca era replicado pro Session,
    // então editar os slots (dia/horário) do plano deixava a Session travada no horário antigo
    // pra sempre, e o slot antigo continuava "fantasma" bloqueando a agenda do médico
    // (conflictDetection.js lê o horário direto da Session, não do Appointment).
    // Precisa ser bulkWrite (não updateMany) porque cada appointment pode ter um horário novo diferente.
    if (timeSyncMap.size > 0) {
      const sessionTimeBulkOps = Array.from(timeSyncMap.entries()).map(([apptId, newTime]) => ({
        updateOne: {
          filter: { appointmentId: new mongoose.Types.ObjectId(apptId), status: { $ne: 'completed' } },
          update: { $set: { time: newTime, updatedAt: new Date() } }
        }
      }));

      if (sessionTimeBulkOps.length > 0) {
        await Session.bulkWrite(sessionTimeBulkOps, { session });
      }
    }

    // Atualiza insurance.grossAmount nos payments pendentes vinculados aos appointments futuros
    let paymentsUpdated = 0;
    if (sessionValue !== undefined && affected.length > 0) {
      const affectedIds = affected.map(a => a._id);
      const paymentRes = await Payment.updateMany(
        {
          appointment: { $in: affectedIds },
          status: 'pending',
          billingType: 'convenio'
        },
        {
          $set: {
            'insurance.grossAmount': Number(sessionValue) || 0,
            updatedAt: new Date()
          }
        },
        { session }
      );
      paymentsUpdated = paymentRes.modifiedCount;
    }

    await session.commitTransaction();

    await recordAudit({
      user: req.user,
      action: 'insurance_plan_updated',
      entityType: 'InsurancePlan',
      entityId: plan._id,
      before: beforeSnapshot,
      after: pickInsurancePlanFields(plan),
      source: 'api:insurance_plans:patch',
      pickFn: (x) => x,
      metadata: { appointmentsUpdated, appointmentsCanceled, paymentsUpdated },
    });

    // 🚨 FIX (2026-07-09): "Salvar alterações" NUNCA gera sessão nova — só ajusta/cancela
    // as já existentes. Regenerar sessões é responsabilidade exclusiva do botão "Gerar",
    // que o usuário aciona explicitamente. Ter os dois botões criando appointments (Save
    // implicitamente + Gerar explicitamente) foi o que causou a guia sobre-agendada
    // (scheduledCount > totalSessions) reportada em 2026-07-09.
    res.json({
      success: true,
      data: {
        plan,
        appointmentsUpdated,
        appointmentsCanceled,
        paymentsUpdated
      }
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('[InsurancePlansV2] Erro ao atualizar plano:', error);

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        errorCode: 'CONFLITO_AGENDA',
        message: 'O horário ficou indisponível durante a operação. Tente novamente.'
      });
    }

    res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: error.message });
  } finally {
    session.endSession();
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

    const cancelBeforeSnapshot = pickInsurancePlanFields(plan);
    const today = new Date().toISOString().split('T')[0];

    // Cancela appointments futuros scheduled
    const appointmentsToCancel = await Appointment.find({
      _id: { $in: plan.generatedAppointments },
      operationalStatus: 'scheduled',
      date: { $gte: today }
    }).session(session).select('_id');

    await bulkCancelAppointments(
      appointmentsToCancel.map(a => a._id),
      { reason: 'plan_canceled' },
      req.user,
      session
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

    await recordAudit({
      user: req.user,
      action: 'insurance_plan_canceled',
      entityType: 'InsurancePlan',
      entityId: plan._id,
      before: cancelBeforeSnapshot,
      after: pickInsurancePlanFields(plan),
      source: 'api:insurance_plans:delete',
      pickFn: (x) => x,
    });

    res.json({ success: true, message: 'Plano cancelado com sucesso' });

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: error.message });
  } finally {
    session.endSession();
  }
});

/**
 * POST /api/v2/insurance-plans/:id/generate-sessions
 * Gera (ou regenera) appointments futuros com base na configuração do plano ativo.
 * Equivalente ao "Gerar sessões" do Liminar — separado da edição do plano.
 */
router.post('/:id/generate-sessions', auth, async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, errorCode: 'INVALID_ID', message: 'ID inválido' });
  }

  try {
    const plan = await InsurancePlan.findById(id).lean();
    if (!plan) return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Plano não encontrado' });
    if (plan.status !== 'active') return res.status(400).json({ success: false, errorCode: 'PLAN_NOT_ACTIVE', message: 'Plano não está ativo' });

    const guide = await InsuranceGuide.findById(plan.guide).lean();
    if (!guide) return res.status(404).json({ success: false, errorCode: 'GUIDE_NOT_FOUND', message: 'Guia não encontrada' });

    const lifecycle = await GuideLifecycleService.evaluate(guide, new Date());
    if (!lifecycle.eligibility.canSchedule) {
      const blockingAlert = lifecycle.alerts.find(a => a.severity === 'error');
      return res.status(400).json({
        success: false,
        errorCode: 'GUIDE_NOT_ELIGIBLE',
        message: blockingAlert?.message || 'Guia não elegível para gerar sessões',
        lifecycle
      });
    }

    const remaining = await getGuideRemainingCapacity(guide._id, guide);

    const result = await generateInsurancePlanSessions({
      planId: plan._id,
      guideId: guide._id,
      sessionValue: plan.sessionValue || 0,
      skipHolidays: true
    });

    return res.json({
      success: true,
      data: {
        appointmentsGenerated: result?.count || 0,
        remaining
      }
    });
  } catch (error) {
    console.error('[InsurancePlansV2] Erro ao gerar sessões:', error);
    return res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * GET /api/v2/insurance-plans/:id/changelog
 * Retorna o histórico de alterações (audit trail) de um plano
 */
router.get('/:id/changelog', auth, async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, errorCode: 'INVALID_ID', message: 'ID inválido' });
  }
  try {
    const entries = await getInsurancePlanAuditTrail(id, { limit: 50 });
    res.json({ success: true, data: entries });
  } catch (error) {
    console.error('[InsurancePlansV2] Erro ao buscar changelog:', error);
    res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: error.message });
  }
});

export default router;
