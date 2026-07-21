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
import { replanInsurancePlanSessions } from '../services/schedule/replanInsurancePlanSessions.js';
import { recordAudit, pickInsurancePlanFields, getInsurancePlanAuditTrail } from '../services/auditLogService.js';
import { executeWithSession as bulkCancelAppointments } from '../services/appointment/commands/bulkCancelAppointmentsCommand.js';
import { GuideLifecycleService } from '../services/guideLifecycle/GuideLifecycleService.js';

const router = express.Router();

// Lock em memória para evitar execuções simultâneas de generate-sessions no mesmo plano.
// O frontend também desabilita o botão, mas o lock protege contra double-click races
// e requisições paralelas (ex: refresh + clique manual).
const generateSessionsLocks = new Map();
const LOCK_TTL_MS = 60_000; // 1 minuto de segurança — libera automaticamente se algo travar

function acquireGenerateSessionsLock(planId) {
  const existing = generateSessionsLocks.get(planId);
  if (existing && Date.now() - existing < LOCK_TTL_MS) {
    console.log(`[InsurancePlansV2][generate-sessions] Lock ativo para plano ${planId}. Requisição rejeitada.`);
    return false;
  }
  generateSessionsLocks.set(planId, Date.now());
  console.log(`[InsurancePlansV2][generate-sessions] Lock adquirido para plano ${planId}`);
  return true;
}

function releaseGenerateSessionsLock(planId) {
  generateSessionsLocks.delete(planId);
  console.log(`[InsurancePlansV2][generate-sessions] Lock liberado para plano ${planId}`);
}

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
      // 🚨 FIX (2026-07-20): 'scheduled' sozinho não pega appointments 'pre_agendado'
      // (todo appointment nasce pre_agendado desde a migração 2026-05-07 — ver
      // CLAUDE.md, invariante 6). Um plano/guia substituído deixava os appointments
      // pre_agendado do plano antigo órfãos, ainda ocupando a agenda.
      const oldAppointments = await Appointment.find({
        _id: { $in: existingPlan.generatedAppointments },
        operationalStatus: { $in: ['scheduled', 'pre_agendado', 'confirmed'] },
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
    // 🚨 FIX (2026-07-20): sem filtro de status, um plano CANCELADO continuava sendo
    // devolvido aqui pra sempre — o front renderiza qualquer plano retornado como
    // "PLANO ATIVO" (não checa plan.status), então cancelar um plano nunca tirava o
    // card fantasma da tela (achado real: guia #319995, Daiane, após cancelamento).
    const plan = await InsurancePlan.findOne({ guide: guideId, status: 'active' })
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
// POST /api/v2/insurance-plans/:id/replan-preview
// Só leitura — não cancela nem gera nada. Calcula o impacto de uma mudança de
// slots ANTES do usuário confirmar, usando a mesma fórmula de `remaining` que
// generateInsurancePlanSessions.js usa de verdade (reservedCount excluindo os
// appointments que seriam cancelados). Ver auditoria-output/diagnostico-alteracao-
// -frequencia-plano-convenio-2026-07-20.md, seção 8.2/8.5.
router.post('/:id/replan-preview', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { slots } = req.body;

    if (!Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ success: false, errorCode: 'INVALID_SLOTS', message: 'Informe ao menos um dia/horário.' });
    }

    const plan = await InsurancePlan.findById(id).lean();
    if (!plan) {
      return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Plano não encontrado' });
    }
    if (plan.status !== 'active') {
      return res.status(400).json({ success: false, errorCode: 'PLAN_NOT_ACTIVE', message: 'Este plano não está ativo.' });
    }

    const slotFullSignature = (arr) => (arr || [])
      .map(s => `${s.dayOfWeek}-${s.time}`)
      .slice()
      .sort()
      .join('|');
    const slotsChanged = slotFullSignature(plan.slots) !== slotFullSignature(slots);

    if (!slotsChanged) {
      return res.json({
        success: true,
        data: { slotsChanged: false, appointmentsToCancel: { count: 0, dates: [] }, estimatedGenerated: 0 }
      });
    }

    const guide = await InsuranceGuide.findById(plan.guide).lean();
    if (!guide) {
      return res.status(404).json({ success: false, errorCode: 'GUIDE_NOT_FOUND', message: 'Guia não encontrada' });
    }

    const today = new Date().toISOString().split('T')[0];
    const futureNonCompleted = await Appointment.find({
      _id: { $in: plan.generatedAppointments },
      date: { $gte: today },
      operationalStatus: { $in: ['scheduled', 'pre_agendado', 'confirmed'] }
    }).select('_id date').sort({ date: 1 }).lean();

    const idsToCancel = futureNonCompleted.map(a => a._id);

    // reservedCount "depois de cancelar" = reservedCount atual da guia, excluindo
    // exatamente os appointments que este replanejamento cancelaria.
    const reservedCountAfterCancel = await Appointment.countDocuments({
      insuranceGuide: guide._id,
      operationalStatus: { $in: ['scheduled', 'pre_agendado', 'confirmed'] },
      _id: { $nin: idsToCancel }
    });
    const estimatedGenerated = Math.max(0, (guide.totalSessions - guide.usedSessions) - reservedCountAfterCancel);

    const lifecycle = await GuideLifecycleService.evaluate(guide, new Date());

    res.json({
      success: true,
      data: {
        slotsChanged: true,
        appointmentsToCancel: {
          count: idsToCancel.length,
          dates: futureNonCompleted.map(a => a.date)
        },
        estimatedGenerated,
        guide: {
          totalSessions: guide.totalSessions,
          usedSessions: guide.usedSessions
        },
        eligible: lifecycle.eligibility.canSchedule,
        eligibilityMessage: lifecycle.eligibility.canSchedule
          ? null
          : (lifecycle.alerts.find(a => a.severity === 'error')?.message || null)
      }
    });
  } catch (error) {
    console.error('[InsurancePlans][replan-preview] Erro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/:id', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;
    const { doctorId, sessionValue, slots, notes, startDate } = req.body;

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

    console.log('[InsurancePlansV2][PATCH] Iniciando edição do plano', {
      planId: plan._id.toString(),
      guideId: plan.guide?.toString(),
      payload: { doctorId, sessionValue: sessionValue != null ? 'present' : 'absent', slots: slots?.length ?? 'absent', notes: notes != null ? 'present' : 'absent' },
      currentSlots: plan.slots,
      sessionsPerWeek: plan.sessionsPerWeek
    });
    // 'confirmed' incluído: PATCH de sessionValue/doctor deve propagar mesmo após confirmação
    const affected = await Appointment.find({
      _id: { $in: plan.generatedAppointments },
      date: { $gte: today },
      operationalStatus: { $in: ['scheduled', 'pre_agendado', 'confirmed'] }
    }).select('_id date time patient').session(session).lean();

    // 🚨 FIX (2026-07-20): detecta mudança ESTRUTURAL de frequência (conjunto de dias
    // da semana), não só de horário. Achado real: guia #319995 foi criada com 1 slot/semana,
    // consumindo os 14 appointments autorizados 1x/semana ao longo de 14 semanas. Ao editar
    // o plano para 3 slots/semana, o sync incremental abaixo só ajustava o horário dos
    // appointments que JÁ existiam nos dias antigos — os dias novos nunca ganhavam appointment,
    // e "Gerar sessões" retornava 0 porque a guia já estava 100% reservada pelo padrão antigo.
    // Quando os slots mudam (dia e/ou horário), a agenda futura precisa ser
    // recriada para refletir a nova configuração. Marca o plano como pendente
    // de regeneração e não atualiza/cancela nada automaticamente no PATCH — a
    // sincronização acontece no botão "Gerar sessões".
    const slotFullSignature = (arr) => (arr || [])
      .map(s => `${s.dayOfWeek}-${s.time}`)
      .slice()
      .sort()
      .join('|');
    const slotsChanged = slots !== undefined && slotFullSignature(plan.slots) !== slotFullSignature(slots);

    // 🚨 FIX (2026-07-20): a ordem do array `slots` é a prioridade que
    // generateInsurancePlanSessions.js usa pra decidir qual slot ganha sessão primeiro
    // quando o orçamento restante da guia não cobre a semana inteira (ex: 2 sessões
    // sobrando pra 3 slots/semana). Reordenar via drag-and-drop no front (sem alterar o
    // CONJUNTO de pares dayOfWeek/time) já é persistido corretamente e já vale pra
    // qualquer geração futura — mas antes disso o usuário não tinha nenhum sinal de que
    // a reordenação "pegou". orderSignature (sem sort) detecta isso e também marca
    // needsSessionRegeneration, mesmo quando slotsChanged (que ignora ordem) é false.
    const orderSignature = (arr) => (arr || []).map(s => `${s.dayOfWeek}-${s.time}`).join('|');
    const orderChanged = slots !== undefined && orderSignature(plan.slots) !== orderSignature(slots);

    console.log('[InsurancePlansV2][PATCH] Slots alterados?', {
      slotsChanged,
      orderChanged,
      oldSlots: slotFullSignature(plan.slots),
      newSlots: slots !== undefined ? slotFullSignature(slots) : 'n/a'
    });

    // Sincronização de horário se slots mudaram (só quando a frequência NÃO mudou —
    // mudança de frequência é tratada via cancelar+regenerar, ver bloco abaixo)
    const timeSyncMap = new Map();
    const toCancelIds = [];
    if (slots !== undefined && !slotsChanged) {
      // 🚨 FIX (2026-07-20): dayOfWeek -> time só é 1:1 quando há no máximo 1 slot por dia.
      // Planos com múltiplos horários no mesmo dia (ex: 2x Terça) faziam o Map colapsar
      // pra um único horário (o último do array vence), sincronizando TODOS os appointments
      // daquele dia da semana pro mesmo horário — dois appointments diferentes acabavam
      // setados pra data+hora idênticas, violando o índice único (unique_appointment_slot)
      // e retornando E11000 disfarçado de "horário ficou indisponível" (achado real: guia
      // #319995, Daiane, 2 slots de Terça, 10:40 e 11:20).
      //
      // Como slotsChanged é false nesta branch, o CONJUNTO de pares (dayOfWeek,time) do
      // plano não mudou — só a ordem do array pode ter mudado. Logo, o horário atual de
      // cada appointment já deveria bater com um dos pares vigentes daquele dia: cada um
      // sincroniza pro PRÓPRIO horário (a.time), não pro horário de um slot vizinho. Isso
      // preserva os 2 appointments de Terça em horários distintos e ainda propaga o valor
      // pra Session (self-heal de drift legado, ver fix 2026-07-16 abaixo).
      // Só quando o horário do appointment não bate com NENHUM slot vigente daquele dia
      // (drift real) é que precisamos escolher um valor novo — o que só é seguro fazer
      // quando há um único slot possível naquele dia (senão não há como saber pra qual
      // dos vários horários migrar).
      const timesByDay = new Map();
      for (const s of (slots || [])) {
        if (!timesByDay.has(s.dayOfWeek)) timesByDay.set(s.dayOfWeek, new Set());
        timesByDay.get(s.dayOfWeek).add(s.time);
      }

      for (const a of affected) {
        const dow = new Date(a.date).getDay();
        const dayTimes = timesByDay.get(dow);

        if (!dayTimes || dayTimes.size === 0) {
          toCancelIds.push(a._id);
          continue;
        }

        if (dayTimes.has(a.time)) {
          // 🚨 FIX (2026-07-16): sempre sincroniza, mesmo se newTime === Appointment.time.
          // O check "newTime !== a.time" comparava só contra o Appointment — mas o Appointment
          // já podia estar correto (atualizado numa edição anterior a este fix) enquanto a
          // Session ficava presa no horário antigo pra sempre, sem nenhuma edição subsequente
          // conseguir corrigi-la (achado real: guia da Antonella, 26 sessions travadas em 10:00
          // com Appointment já em 10:40). Resalvar o plano agora sempre força Session.time a
          // bater com o slot vigente, fechando esse buraco de autocorreção.
          timeSyncMap.set(String(a._id), a.time);
        } else if (dayTimes.size === 1) {
          // Único slot possível nesse dia e não bate — drift real, corrige pro valor vigente.
          timeSyncMap.set(String(a._id), [...dayTimes][0]);
        }
        // dayTimes.size > 1 e a.time não bate com nenhum: ambíguo, não sabe pra qual dos
        // vários horários do dia esse appointment deveria migrar — não mexe.
      }
    }

    // Pré-checagem de conflitos com novo profissional
    const SLOT_BLOCKING_STATUSES = [
      'pre_agendado', 'scheduled', 'confirmed', 'pending', 'paid',
      'missed', 'processing_create', 'processing_complete', 'processing_cancel', 'force_cancelled'
    ];

    if (doctorId && affected.length > 0 && !slotsChanged) {
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

    // 🚨 FIX (2026-07-21): startDate era travado como "Não editável" no front pra planos
    // ativos, mas isso significa que uma data de início errada/desatualizada (ex: setada
    // na criação original, dias antes do usuário realmente precisar) nunca podia ser
    // corrigida — generateInsurancePlanSessions.js usa esse campo como piso rígido
    // (`if (sessionDate < startDate) continue`), então nenhuma sessão anterior a ele é
    // gerada, mesmo que o slot da semana exista. Agora aceita edição; startDateChanged
    // força o mesmo caminho de replan usado por mudança de slots.
    let startDateChanged = false;
    if (startDate !== undefined) {
      const newStartDate = new Date(startDate);
      newStartDate.setHours(0, 0, 0, 0);
      const currentStartDate = new Date(plan.startDate);
      currentStartDate.setHours(0, 0, 0, 0);
      startDateChanged = newStartDate.getTime() !== currentStartDate.getTime();
      if (startDateChanged) plan.startDate = newStartDate;
    }

    // Quando a estrutura dos slots muda (dias/frequência), só a ordem muda (prioridade
    // de geração) OU o início do plano muda, marca o plano como pendente de regeneração
    // para que o card exiba o alerta "Plano alterado". Note: se a guia já está com a
    // capacidade 100% reservada (remaining=0), clicar em "Gerar sessões" depois disso
    // não recria nada por si só (não há appointment faltando pra gerar) — por isso
    // startDateChanged também é usado no POST /generate-sessions para forçar replan
    // mesmo sem divergência de dayOfWeek/time.
    if (slotsChanged || orderChanged || startDateChanged) {
      plan.needsSessionRegeneration = true;
    }

    await plan.save({ session });

    // Atualiza appointments pendentes (doctor, time e valores)
    const baseSet = {};
    if (doctorId !== undefined) baseSet.doctor = new mongoose.Types.ObjectId(doctorId);
    if (sessionValue !== undefined) {
      baseSet.sessionValue = Number(sessionValue) || 0;
      baseSet.insuranceValue = Number(sessionValue) || 0;
    }

    let appointmentsUpdated = 0;
    if (!slotsChanged && affected.length > 0 && (Object.keys(baseSet).length > 0 || timeSyncMap.size > 0)) {
      // Valida ANTES de escrever: se dois appointments deste lote resolverem pra
      // mesma data+horário (ex: bug de sincronização por dayOfWeek colapsando dois
      // slots do mesmo dia), o Mongo rejeitaria com E11000 genérico, sem dizer qual
      // horário colidiu. Detectar aqui dá uma mensagem específica pro usuário em vez
      // de "recarregue a página e tente novamente".
      const seenSlots = new Map();
      for (const a of affected) {
        const resolvedTime = timeSyncMap.get(String(a._id)) || a.time;
        const dateKey = new Date(a.date).toISOString().split('T')[0];
        const slotKey = `${dateKey}T${resolvedTime}`;
        if (seenSlots.has(slotKey)) {
          const error = new Error('APPOINTMENT_SLOT_SELF_CONFLICT');
          error.code = 'APPOINTMENT_SLOT_CONFLICT';
          error.conflict = {
            type: 'patient',
            date: dateKey,
            time: resolvedTime
          };
          throw error;
        }
        seenSlots.set(slotKey, a._id);
      }

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
    if (!slotsChanged && (doctorId !== undefined || sessionValue !== undefined) && affected.length > 0) {
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
    if (!slotsChanged && sessionValue !== undefined && affected.length > 0) {
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

    // Mudança estrutural de frequência: não é mais acionada automaticamente no PATCH.
    // O replanejamento da agenda futura acontece apenas quando o usuário clica em
    // "Gerar sessões" (POST /generate-sessions), que detecta divergência entre os slots
    // atuais do plano e os appointments futuros existentes. O PATCH salva apenas a
    // configuração do plano.
    let appointmentsGenerated = 0;

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
      metadata: { appointmentsUpdated, appointmentsCanceled, paymentsUpdated, slotsChanged, appointmentsGenerated },
    });

    // 🚨 FIX (2026-07-20): o PATCH salva apenas a configuração do plano. O replanejamento
    // estrutural (cancelar futuras pendentes e regenerar pelo novo padrão) é responsabilidade
    // exclusiva do POST /generate-sessions, que detecta divergência entre os slots atuais do
    // plano e os appointments futuros existentes. Assim o usuário controla o momento da
    // regeneração clicando em "Gerar sessões", e o PATCH não gera efeitos colaterais
    // inesperados ao salvar. Ainda assim, appointments cujo dia da semana saiu do plano são
    // cancelados incrementalmente abaixo, preservando sessões já realizadas.
    res.json({
      success: true,
      data: {
        plan,
        appointmentsUpdated,
        appointmentsCanceled,
        paymentsUpdated,
        slotsChanged,
        appointmentsGenerated
      }
    });

    console.log('[InsurancePlansV2][PATCH] Resposta enviada', {
      planId: plan._id.toString(),
      slotsChanged,
      appointmentsUpdated,
      appointmentsCanceled,
      appointmentsGenerated
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

    // Erros vindos de generateInsurancePlanSessions ao regenerar por mudança de frequência
    if (error.code === 'APPOINTMENT_SLOT_CONFLICT') {
      const conflict = error.conflict || {};
      const prefix = conflict.type === 'doctor'
        ? 'Conflito de agenda: o profissional já possui um compromisso'
        : 'Conflito de agenda: o paciente já possui um compromisso';
      return res.status(409).json({
        success: false,
        errorCode: 'APPOINTMENT_SLOT_CONFLICT',
        message: `${prefix} em ${conflict.date || 'data informada'} às ${conflict.time || 'horário informado'}. Ajuste os horários do plano e tente novamente.`
      });
    }
    if (error.message === 'GUIDE_EXHAUSTED') {
      return res.status(400).json({
        success: false,
        errorCode: 'GUIDE_EXHAUSTED',
        message: 'Esta guia não tem mais sessões disponíveis para regenerar no novo padrão.'
      });
    }
    if (error.code === 'GUIDE_NOT_ELIGIBLE') {
      return res.status(400).json({
        success: false,
        errorCode: 'GUIDE_NOT_ELIGIBLE',
        message: error.message
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

    // Cancela appointments futuros pendentes
    // 🚨 FIX (2026-07-20): 'scheduled' sozinho não pega appointments 'pre_agendado'
    // (todo appointment nasce pre_agendado desde a migração 2026-05-07 — ver
    // CLAUDE.md, invariante 6). O DELETE marcava o plano como 'canceled' mas deixava
    // os appointments pre_agendado órfãos, ainda visíveis/ocupando a agenda (achado
    // real: guia #319995, Daiane — 14 appointments pre_agendado sobraram após cancelar
    // o plano).
    const appointmentsToCancel = await Appointment.find({
      _id: { $in: plan.generatedAppointments },
      operationalStatus: { $in: ['scheduled', 'pre_agendado', 'confirmed'] },
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

  if (!acquireGenerateSessionsLock(id)) {
    return res.status(429).json({ success: false, errorCode: 'ALREADY_PROCESSING', message: 'Geração de sessões já em andamento para este plano. Aguarde a conclusão.' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const plan = await InsurancePlan.findById(id).session(session).lean();
    if (!plan) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', message: 'Plano não encontrado' });
    }
    if (plan.status !== 'active') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, errorCode: 'PLAN_NOT_ACTIVE', message: 'Plano não está ativo' });
    }

    const guide = await InsuranceGuide.findById(plan.guide).session(session).lean();
    if (!guide) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, errorCode: 'GUIDE_NOT_FOUND', message: 'Guia não encontrada' });
    }

    const lifecycle = await GuideLifecycleService.evaluate(guide, new Date());
    if (!lifecycle.eligibility.canSchedule) {
      await session.abortTransaction();
      const blockingAlert = lifecycle.alerts.find(a => a.severity === 'error');
      return res.status(400).json({
        success: false,
        errorCode: 'GUIDE_NOT_ELIGIBLE',
        message: blockingAlert?.message || 'Guia não elegível para gerar sessões',
        lifecycle
      });
    }

    const today = new Date().toISOString().split('T')[0];

    // Busca appointments futuros pendentes pela fonte de verdade (relacionamento),
    // não pelo cache generatedAppointments, que pode ficar inconsistente.
    const futureAppointments = await Appointment.find({
      insurancePlan: plan._id,
      date: { $gte: today },
      operationalStatus: { $in: ['scheduled', 'pre_agendado', 'confirmed'] }
    }).session(session).select('date time').lean();

    // Assinatura dos slots atuais do plano.
    const slotSignatures = new Set((plan.slots || []).map(s => `${s.dayOfWeek}-${s.time}`));

    // Verifica se há divergência entre a configuração atual do plano e os
    // appointments futuros pendentes. Divergência ocorre quando:
    // 1. Algum appointment futuro não bate com nenhum slot atual (dia/horário); ou
    // 2. A quantidade de slots do plano mudou, o que exige redistribuição das sessões.
    const futureSignatures = new Set(futureAppointments.map(a => {
      const dow = new Date(a.date).getDay();
      return `${dow}-${a.time}`;
    }));
    const mismatched = futureAppointments.filter(a => {
      const dow = new Date(a.date).getDay();
      const signature = `${dow}-${a.time}`;
      return !slotSignatures.has(signature);
    });

    // 🚨 FIX (2026-07-21): needsSessionRegeneration cobre casos que a comparação de
    // assinatura (dayOfWeek-time) não pega — em especial mudança de startDate, que não
    // altera nenhum par dayOfWeek/time, só o piso de datas válidas. Sem isso, editar o
    // início do plano marcava o banner "Plano alterado" mas "Gerar sessões" continuava
    // um no-op quando a guia já estava com a capacidade reservada no padrão antigo.
    const needsReplan = mismatched.length > 0 || slotSignatures.size !== futureSignatures.size || Boolean(plan.needsSessionRegeneration);

    console.log('[InsurancePlansV2][generate-sessions] Verificando divergência de agenda', {
      planId: plan._id.toString(),
      futureAppointmentsCount: futureAppointments.length,
      slotSignatures: Array.from(slotSignatures),
      futureSignatures: Array.from(futureSignatures),
      mismatchedCount: mismatched.length,
      slotCountMismatch: slotSignatures.size !== futureSignatures.size,
      needsReplan
    });

    let replanResult = null;
    if (needsReplan) {
      replanResult = await replanInsurancePlanSessions({
        planId: plan._id,
        guideId: plan.guide,
        mongoSession: session,
        user: req.user,
        reason: 'plan_slots_mismatch'
      });
      console.log('[InsurancePlansV2][generate-sessions] Replanejamento executado', {
        appointmentsCanceled: replanResult.appointmentsCanceled,
        appointmentsGenerated: replanResult.appointmentsGenerated
      });
    }

    const remaining = await getGuideRemainingCapacity(guide._id, guide, session);

    const result = await generateInsurancePlanSessions({
      planId: plan._id,
      guideId: guide._id,
      sessionValue: plan.sessionValue || 0,
      mongoSession: session,
      skipHolidays: true
    });

    // Após aplicar o plano na agenda (replan ou geração normal), a flag de
    // pendência de sincronização é limpa.
    await InsurancePlan.findByIdAndUpdate(
      plan._id,
      { needsSessionRegeneration: false },
      { session }
    );

    await session.commitTransaction();

    return res.json({
      success: true,
      data: {
        appointmentsGenerated: (replanResult?.appointmentsGenerated || 0) + (result?.count || 0),
        remaining,
        replanned: needsReplan,
        appointmentsCanceled: replanResult?.appointmentsCanceled || 0
      }
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('[InsurancePlansV2] Erro ao gerar sessões:', error);

    if (error.code === 'APPOINTMENT_SLOT_CONFLICT') {
      const conflict = error.conflict || {};
      const prefix = conflict.type === 'doctor'
        ? 'Conflito de agenda: o profissional já possui um compromisso'
        : 'Conflito de agenda: o paciente já possui um compromisso';
      return res.status(409).json({
        success: false,
        errorCode: 'APPOINTMENT_SLOT_CONFLICT',
        message: `${prefix} em ${conflict.date || 'data informada'} às ${conflict.time || 'horário informada'}. Ajuste os horários do plano e tente novamente.`
      });
    }
    if (error.message === 'GUIDE_EXHAUSTED') {
      return res.status(400).json({
        success: false,
        errorCode: 'GUIDE_EXHAUSTED',
        message: 'Esta guia não tem mais sessões disponíveis para regenerar no novo padrão.'
      });
    }
    if (error.code === 'GUIDE_NOT_ELIGIBLE') {
      return res.status(400).json({
        success: false,
        errorCode: 'GUIDE_NOT_ELIGIBLE',
        message: error.message
      });
    }

    return res.status(500).json({ success: false, errorCode: 'INTERNAL_ERROR', message: error.message });
  } finally {
    session.endSession();
    releaseGenerateSessionsLock(id);
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
