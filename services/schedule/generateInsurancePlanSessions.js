// services/schedule/generateInsurancePlanSessions.js
// Gera appointments + payments pendentes para plano de convênio.
// Padrão igual generateLiminarSessions: semana a semana, pula feriados, bulkWrite upsert.

import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import InsurancePlan from '../../models/InsurancePlan.js';
import { getHolidaysWithNames } from '../../config/feriadosBR-dynamic.js';
import { buildInsuranceSession } from '../../domain/session/sessionFactory.js';

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Retorna o domingo da semana da data fornecida (00:00:00) */
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Gera appointments e payments pendentes para um plano de convênio.
 *
 * @param {Object} params
 * @param {string} params.planId        - ID do InsurancePlan
 * @param {string} params.guideId       - ID da InsuranceGuide
 * @param {Object} params.mongoSession  - Sessão MongoDB (transação)
 * @param {boolean} params.skipHolidays - Pular feriados (default: true)
 */
export async function generateInsurancePlanSessions({
  planId,
  guideId,
  sessionValue = 0,
  mongoSession,
  skipHolidays = true
}) {
  // ── 1. Carrega plano e guia ────────────────────────────────────
  const plan = await InsurancePlan.findById(planId).session(mongoSession).lean();
  if (!plan) throw new Error('PLAN_NOT_FOUND');
  if (plan.status !== 'active') throw new Error(`PLAN_NOT_ACTIVE: status=${plan.status}`);

  const guide = await InsuranceGuide.findById(guideId).session(mongoSession).lean();
  if (!guide) throw new Error('GUIDE_NOT_FOUND');

  const remaining = guide.totalSessions - guide.usedSessions;
  if (remaining <= 0) throw new Error('GUIDE_EXHAUSTED');

  // Guia é a fonte de verdade do valor de sessão do convênio.
  // plan.sessionValue é apenas um espelho; guide.sessionValue prevalece.
  const effectiveSessionValue = guide.sessionValue || sessionValue || 0;

  // ── 2. Resolve janela de geração ───────────────────────────────
  const planStartDate = new Date(plan.startDate);
  planStartDate.setHours(0, 0, 0, 0);
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  // Ao regenerar um plano ativo com sessões passadas, parte de hoje para não criar appointments no passado
  const startDate = planStartDate > todayDate ? planStartDate : todayDate;

  // +1 de buffer: quando startDate cai no meio da semana, slots anteriores
  // ao startDate são pulados na semana 0, consumindo uma semana sem gerar sessão
  const weeksNeeded = Math.ceil(remaining / plan.slots.length) + 1;
  const weekStart = getWeekStart(startDate);
  const globalEnd = addDays(weekStart, weeksNeeded * 7 + 6);
  globalEnd.setHours(23, 59, 59, 999);

  // ── 3. Feriados do período ─────────────────────────────────────
  const holidays = new Set();
  if (skipHolidays) {
    const years = new Set();
    const cur = new Date(weekStart);
    while (cur <= globalEnd) { years.add(cur.getFullYear()); cur.setDate(cur.getDate() + 1); }
    for (const year of years) {
      for (const h of getHolidaysWithNames(year)) holidays.add(h.date);
    }
  }

  // ── 4. Gera slots semana a semana ──────────────────────────────
  const slots = [];
  let sessionsCreated = 0;

  for (let w = 0; w < weeksNeeded && sessionsCreated < remaining; w++) {
    const currentWeekSunday = addDays(weekStart, w * 7);

    for (const slot of (Array.isArray(plan.slots) ? plan.slots : [])) {
      if (sessionsCreated >= remaining) break;

      const sessionDate = addDays(currentWeekSunday, slot.dayOfWeek);
      const dateStr = sessionDate.toISOString().split('T')[0];

      // Pula datas antes do startDate
      if (sessionDate < startDate) continue;

      // Pula feriados
      if (holidays.has(dateStr)) continue;

      slots.push({
        dateStr,
        time: slot.time,
        date: sessionDate
      });
      sessionsCreated++;
    }
  }

  if (slots.length === 0) {
    return { appointments: [], count: 0 };
  }

  // ── 5. bulkWrite upsert para appointments ──────────────────────
  const bulkOps = slots.map(slot => ({
    updateOne: {
      filter: {
        patient: plan.patient,
        insurancePlan: plan._id,
        date: {
          $gte: new Date(slot.dateStr + 'T00:00:00.000Z'),
          $lt: new Date(slot.dateStr + 'T23:59:59.999Z')
        },
        time: slot.time,
        operationalStatus: { $ne: 'canceled' }
      },
      update: {
        $set: {
          // Sempre enforça billingType/paymentMethod/valores mesmo em appointments existentes.
          // $setOnInsert não corrigia appointments criados antes do plano (causa do bug 2026-06-09).
          // sessionValue/insuranceValue também precisam ser setados em appointments pré-existentes
          // para evitar saldo devedor fantasma (bug 2026-06-26).
          billingType: 'convenio',
          paymentMethod: 'convenio',
          ...(effectiveSessionValue > 0 && {
            sessionValue: effectiveSessionValue,
            insuranceValue: effectiveSessionValue,
          }),
        },
        $setOnInsert: {
          patient: plan.patient,
          doctor: plan.doctor,
          specialty: plan.specialty,
          date: slot.date,
          time: slot.time,
          duration: plan.duration || 40,
          serviceType: 'session',
          sessionType: plan.specialty,
          insuranceProvider: guide.insurance,
          insuranceGuide: guide._id,
          insurancePlan: plan._id,
          operationalStatus: 'pre_agendado',
          clinicalStatus: 'pending',
          paymentStatus: 'pending',
          status: 'pre_agendado',
          notes: 'Sessão de convênio gerada pelo plano',
          metadata: { origin: { source: 'insurance_plan' } },
          createdAt: new Date()
        }
      },
      upsert: true
    }
  }));

  const result = await Appointment.bulkWrite(bulkOps, { session: mongoSession, ordered: false });

  // ── 6. Busca appointments criados para vincular payments ───────
  const createdAppointments = await Appointment.find({
    patient: plan.patient,
    insurancePlan: plan._id,
    operationalStatus: { $in: ['scheduled', 'pre_agendado'] }
  }).session(mongoSession).lean();

  // ── 7. Cria payments pendentes (apenas para appointments sem payment convenio ativo) ─────
  // Busca por appointment._id (não por insurancePlan) para detectar payments de planos anteriores.
  // Bug anterior: lookup por insurancePlan._id falhava na renovação de guia — novo plan não
  // encontrava payment do plan anterior, sobrescrevia appointment.payment e deixava session=null.
  const existingPayments = await Payment.find({
    appointment: { $in: createdAppointments.map(a => a._id) },
    billingType: 'convenio',
    status: { $ne: 'canceled' }
  }, { appointment: 1 }).session(mongoSession).lean();
  const existingAppointmentIds = new Set(existingPayments.map(p => p.appointment?.toString()).filter(Boolean));

  const newAppointments = createdAppointments.filter(a => !existingAppointmentIds.has(a._id.toString()));

  const paymentDocs = newAppointments.map(a => ({
    patient: plan.patient,
    doctor: plan.doctor,
    appointment: a._id,
    specialty: plan.specialty,
    amount: 0,         // paciente não paga
    billingType: 'convenio',
    status: 'pending',
    financialDate: null,
    paymentDate: new Date(),
    paymentMethod: 'other', // 'convenio' não é enum válido no Payment
    insurance: {
      provider: guide.insurance,
      status: 'pending_billing',
      grossAmount: effectiveSessionValue,
      guideId: guide._id
    },
    insuranceGuide: guide._id,
    insurancePlan: plan._id,
    notes: `Pagamento pendente do convênio ${guide.insurance || ''}`,
    kind: 'session_payment'
  }));

  let createdPayments = [];
  if (paymentDocs.length > 0) {
    createdPayments = await Payment.insertMany(paymentDocs, { session: mongoSession });

    // Linka payment → appointment para que completeSessionV2 atualize (não duplique)
    const paymentLinkOps = createdPayments.map((p, i) => ({
      updateOne: {
        filter: { _id: newAppointments[i]._id },
        update: { $set: { payment: p._id } }
      }
    }));
    await Appointment.bulkWrite(paymentLinkOps, { session: mongoSession, ordered: false });
  }

  // ── 8. Cria Sessions para os novos appointments (necessário para cashflow) ──
  // calculateProduction() usa Session.find({ status: 'completed' }) como fonte única.
  // Sem Session linked ao appointment, completeSessionV2 não atualiza nada e o
  // cashflow fica em branco.
  const existingSessions = await Session.find(
    { appointment: { $in: newAppointments.map(a => a._id) } },
    { appointment: 1 }
  ).session(mongoSession).lean();
  const existingSessionApptIds = new Set(existingSessions.map(s => s.appointment?.toString()));

  const appointmentsNeedingSession = newAppointments.filter(
    a => !existingSessionApptIds.has(a._id.toString())
  );

  const sessionDocs = appointmentsNeedingSession.map(a => buildInsuranceSession({
    ...a,
    _id: a._id,
    patient: plan.patient,
    doctor: plan.doctor,
    specialty: plan.specialty,
    sessionValue: effectiveSessionValue,
    insuranceGuide: guide._id,
    insurancePlan: plan._id
  }));

  let createdSessions = [];
  if (sessionDocs.length > 0) {
    createdSessions = await Session.insertMany(sessionDocs, { session: mongoSession });

    // Vincula session ao appointment — índices alinhados com appointmentsNeedingSession
    const sessionLinkOps = createdSessions.map((s, i) => ({
      updateOne: {
        filter: { _id: appointmentsNeedingSession[i]._id },
        update: { $set: { session: s._id } }
      }
    }));
    await Appointment.bulkWrite(sessionLinkOps, { session: mongoSession, ordered: false });
  }

  // ── 10. Atualiza plano com appointments gerados ────────────────
  await InsurancePlan.findByIdAndUpdate(
    plan._id,
    { generatedAppointments: createdAppointments.map(a => a._id) },
    { session: mongoSession }
  );

  console.log('[generateInsurancePlanSessions] ✅ Concluído', {
    planId: plan._id.toString(),
    guideId: guide._id.toString(),
    slotsRequested: remaining,
    slotsGenerated: slots.length,
    appointmentsCreated: result.upsertedCount,
    paymentsCreated: paymentDocs.length,
    sessionsCreated: createdSessions.length,
    sessionValue: effectiveSessionValue
  });

  return {
    appointments: createdAppointments,
    count: createdAppointments.length
  };
}
