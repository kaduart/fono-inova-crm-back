// services/schedule/replanInsurancePlanSessions.js
// Replaneja a agenda de um plano de convênio IN-PLACE — reaproveita
// Appointment/Session/Payment existentes em vez de apagar e recriar.
//
// Regra (ver auditoria 2026-08-14, caso guia 16173376/Ícaro):
//   completed          → nunca tocado, nunca movido, continua consumindo autorização
//   pre_agendado/scheduled → reposicionado (mesmos IDs), pode virar completed se a
//                         data alvo cair no passado (via completeSessionV2, pós-commit)
//   canceled           → reaproveitado (restaurado + reposicionado) SOMENTE se o
//                         Payment vinculado for financeiramente reversível
//                         (isPaymentFinanciallyReversible) — senão fica intocado
//   confirmed/missed   → nunca movido automaticamente; ocupa capacidade mas fica
//                         fora do pool de reaproveitamento
//   registro de OUTRA guia no mesmo horário → conflito, aborta antes de qualquer
//                         escrita (checkSlotConflicts), nunca cancela sozinho
//   pre_agendado/scheduled sobrando (fora da série esperada) → cancelado (nunca
//                         hard-delete) via bulkCancelAppointmentsCommand
//
// Idempotente: rodar duas vezes seguidas sem mudar plano/guia não produz nenhuma
// escrita na segunda vez — a série esperada já bate com o que existe.

import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import InsurancePlan from '../../models/InsurancePlan.js';
import { GuideLifecycleService } from '../guideLifecycle/GuideLifecycleService.js';
import { getHolidaysWithNames } from '../../config/feriadosBR-dynamic.js';
import { buildInsuranceSession } from '../../domain/session/sessionFactory.js';
import { checkSlotConflicts } from './generateInsurancePlanSessions.js';
import { executeWithSession as bulkCancelAppointments } from '../appointment/commands/bulkCancelAppointmentsCommand.js';
import { executeWithSession as restoreCanceledAppointment } from '../appointment/commands/restoreCanceledAppointmentCommand.js';

const REPOSITIONABLE_STATUSES = ['pre_agendado', 'scheduled'];
const CANCELED_STATUSES = ['canceled', 'cancelled'];
const FROZEN_STATUSES = ['confirmed', 'missed']; // nunca movidos automaticamente

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getWeekStart(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateStrOf(date) {
  return new Date(date).toISOString().split('T')[0];
}

function slotKeyOf(dateStr, time) {
  return `${dateStr}T${time}`;
}

/**
 * Predicate canônico: um Payment só pode ser considerado "reversível" (seguro
 * pra restaurar um Appointment cancelado vinculado a ele) se não houver NENHUMA
 * evidência de avanço no ciclo financeiro do convênio. Testável isoladamente.
 */
export function isPaymentFinanciallyReversible(payment) {
  if (!payment) return true; // sem payment vinculado, nada a reverter
  const BLOCKED_STATUSES = ['billed', 'paid', 'partial', 'refunded'];
  if (BLOCKED_STATUSES.includes(payment.status)) return false;
  const insuranceStatus = payment.insurance?.status;
  if (insuranceStatus === 'billed' || insuranceStatus === 'received') return false;
  if ((payment.insurance?.receivedAmount || 0) > 0) return false;
  if (payment.insurance?.billedAt || payment.insurance?.receivedAt) return false;
  return true;
}

/** Série cronológica exata esperada: `count` datas, a partir de startDate/slots,
 *  pulando feriados — não depende de contagem de reservados (isso já foi
 *  descontado antes, no `mutableSlotsNeeded` do caller). */
function buildExpectedSeries({ plan, count, startFloor, holidays }) {
  if (count <= 0) return [];
  const weeksNeeded = Math.ceil(count / plan.slots.length) + 1;
  const weekStart = getWeekStart(startFloor);
  const series = [];
  let created = 0;
  const maxWeeks = weeksNeeded + 260; // guarda de segurança (~5 anos)
  for (let w = 0; created < count && w < maxWeeks; w++) {
    const weekSunday = addDays(weekStart, w * 7);
    for (const slot of plan.slots) {
      if (created >= count) break;
      const d = addDays(weekSunday, slot.dayOfWeek);
      if (d < startFloor) continue;
      const dStr = dateStrOf(d);
      if (holidays.has(dStr)) continue;
      series.push({ dateStr: dStr, time: slot.time, date: d });
      created++;
    }
  }
  return series;
}

/**
 * @param {Object} params
 * @param {string} params.planId
 * @param {string} params.guideId
 * @param {mongoose.ClientSession} params.mongoSession
 * @param {Object} [params.user]
 * @param {string} [params.reason]
 * @param {boolean} [params.allowPastGeneration] - sinal explícito pra incluir
 *   datas passadas na série esperada (backfill retroativo).
 * @returns {Promise<{ appointmentsDeleted:number, appointmentsCanceled:number,
 *   appointmentsGenerated:number, appointments:Array, pastAppointments:Array }>}
 */
export async function replanInsurancePlanSessions({
  planId,
  guideId,
  mongoSession,
  user,
  reason = 'plan_frequency_changed',
  allowPastGeneration = false
}) {
  const plan = await InsurancePlan.findById(planId).session(mongoSession).lean();
  if (!plan) throw new Error('PLAN_NOT_FOUND');

  const guide = await InsuranceGuide.findById(guideId).session(mongoSession).lean();
  if (!guide) throw new Error('GUIDE_NOT_FOUND');

  const lifecycle = await GuideLifecycleService.evaluate(guide, new Date());
  if (!lifecycle.eligibility.canSchedule) {
    const blockingAlert = lifecycle.alerts.find(a => a.severity === 'error');
    const err = new Error(blockingAlert?.message || 'Guia não elegível para replanejar sessões');
    err.code = 'GUIDE_NOT_ELIGIBLE';
    throw err;
  }

  console.log('[replanInsurancePlanSessions] Iniciando replanejamento in-place', {
    planId: plan._id.toString(),
    guideId: guide._id.toString(),
    guideTotal: guide.totalSessions,
    guideUsed: guide.usedSessions
  });

  // ── 1. Carrega TODOS os registros ligados ao plano/guia, qualquer status ──
  // (fonte de verdade é o relacionamento, não o cache generatedAppointments)
  const allAppointments = await Appointment.find({
    $or: [{ insurancePlan: plan._id }, { insuranceGuide: guide._id }]
  }).session(mongoSession).lean();

  const completedAppts = allAppointments.filter(a => a.operationalStatus === 'completed');
  const frozenAppts = allAppointments.filter(a => FROZEN_STATUSES.includes(a.operationalStatus));
  const repositionablePool = allAppointments.filter(a => REPOSITIONABLE_STATUSES.includes(a.operationalStatus));
  const canceledPool = allAppointments.filter(a => CANCELED_STATUSES.includes(a.operationalStatus));

  // ── 2. Capacidade mutável = total autorizado - já consumido - congelado ──
  // completed já está embutido em guide.usedSessions; confirmed/missed ocupam
  // capacidade mas ficam fora do pool de reaproveitamento (nunca movidos).
  const remaining = Math.max(0, (guide.totalSessions || 0) - (guide.usedSessions || 0));
  const mutableSlotsNeeded = Math.max(0, remaining - frozenAppts.length);

  // ── 3. Feriados do período provável ────────────────────────────
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const planStartDate = new Date(plan.startDate); planStartDate.setHours(0, 0, 0, 0);
  const startFloor = allowPastGeneration ? planStartDate : (planStartDate > today ? planStartDate : today);
  const holidays = new Set();
  {
    const years = new Set([startFloor.getFullYear(), startFloor.getFullYear() + 1]);
    for (const year of years) {
      for (const h of getHolidaysWithNames(year)) holidays.add(h.date);
    }
  }

  // ── 4. Série cronológica exata esperada ────────────────────────
  const expectedSeries = buildExpectedSeries({ plan, count: mutableSlotsNeeded, startFloor, holidays });

  // ── 5. Reversibilidade financeira de cada cancelado (predicate canônico) ──
  const canceledWithPayment = await Promise.all(canceledPool.map(async appt => {
    const payment = appt.payment
      ? await Payment.findById(appt.payment).session(mongoSession).lean()
      : await Payment.findOne({ appointment: appt._id }).session(mongoSession).lean();
    return { appt, payment, reversible: isPaymentFinanciallyReversible(payment) };
  }));
  const reversibleCanceled = canceledWithPayment.filter(c => c.reversible);

  // ── 6. Matching: série esperada × registros existentes ─────────────────
  const usedPoolIds = new Set();
  const toCreate = [];                 // slots sem NENHUM registro reaproveitável
  const toReposition = [];             // { appt, target } — pre_agendado/scheduled
  const toRestoreAndReposition = [];   // { appt, payment, target } — canceled reversível

  const matchesSlot = (appt, target) => dateStrOf(appt.date) === target.dateStr && appt.time === target.time;

  for (const target of expectedSeries) {
    // 🚨 FIX idempotência: um "já satisfeito" em repositionablePool PRECISA marcar
    // o _id como usado — senão a próxima rodada não sabe que esse registro já
    // está ocupado com esse alvo e o trata como "sobra", cancelando um appointment
    // que estava certo (achado nos testes: 2ª execução cancelava tudo).
    const alreadyThereRepositionable = repositionablePool.find(a => !usedPoolIds.has(a._id.toString()) && matchesSlot(a, target));
    const alreadyThere =
      alreadyThereRepositionable ||
      frozenAppts.find(a => matchesSlot(a, target)) ||
      completedAppts.find(a => matchesSlot(a, target));
    if (alreadyThere) {
      if (alreadyThereRepositionable) usedPoolIds.add(alreadyThereRepositionable._id.toString());
      continue; // já satisfeito, nada a fazer nesse alvo
    }

    const repoCandidate = repositionablePool.find(a => !usedPoolIds.has(a._id.toString()));
    if (repoCandidate) {
      usedPoolIds.add(repoCandidate._id.toString());
      toReposition.push({ appt: repoCandidate, target });
      continue;
    }

    const cancelCandidate = reversibleCanceled.find(c => !usedPoolIds.has(c.appt._id.toString()));
    if (cancelCandidate) {
      usedPoolIds.add(cancelCandidate.appt._id.toString());
      toRestoreAndReposition.push({ appt: cancelCandidate.appt, payment: cancelCandidate.payment, target });
      continue;
    }

    toCreate.push(target);
  }

  // Sobrou pre_agendado/scheduled não usado por nenhum alvo da série esperada
  // (ex: plano encolheu ou mudou de padrão) — cancela, nunca hard-delete.
  const leftoverRepositionable = repositionablePool.filter(a => !usedPoolIds.has(a._id.toString()));

  // ── 7. Checa conflito com OUTRA guia/paciente ANTES de qualquer escrita ──
  // Cobre toCreate + toReposition + toRestoreAndReposition — se qualquer alvo
  // colidir com um registro bloqueante de outro dono, a função lança e nada é
  // escrito (transação do caller aborta). Nunca cancela o registro externo.
  const allTargetSlots = [
    ...toCreate.map(t => ({ dateStr: t.dateStr, time: t.time })),
    ...toReposition.map(r => ({ dateStr: r.target.dateStr, time: r.target.time })),
    ...toRestoreAndReposition.map(r => ({ dateStr: r.target.dateStr, time: r.target.time }))
  ];
  if (allTargetSlots.length > 0) {
    await checkSlotConflicts({
      slots: allTargetSlots,
      doctorId: plan.doctor,
      patientId: plan.patient,
      duration: plan.duration || 40,
      mongoSession,
      excludePlanId: plan._id
    });
  }

  // ── 8. Executa as mutações ──────────────────────────────────────────────
  const effectiveSessionValue = guide.sessionValue || plan.sessionValue || 0;
  const touchedAppointments = [];
  const pastAppointments = []; // repositionados/restaurados/criados no passado → completar pós-commit

  // 8a. Reposiciona pre_agendado/scheduled (preserva Appointment/Session/Payment IDs)
  for (const { appt, target } of toReposition) {
    await Appointment.updateOne(
      { _id: appt._id },
      { $set: { date: target.date, time: target.time, insuranceGuide: guide._id, insurancePlan: plan._id, updatedAt: new Date() } },
      { session: mongoSession }
    );
    await Session.updateOne(
      { appointmentId: appt._id, status: { $nin: ['completed', 'canceled'] } },
      { $set: { date: target.date, time: target.time, updatedAt: new Date() } },
      { session: mongoSession }
    );
    const updated = { ...appt, date: target.date, time: target.time };
    touchedAppointments.push(updated);
    if (target.date < today) pastAppointments.push(updated);
  }

  // 8b. Restaura cancelado reversível + reposiciona (mesmo padrão do restore
  // canônico — nunca pousa direto em completed; Appointment.operationalStatus é
  // setado aqui porque restoreCanceledAppointmentCommand deliberadamente não
  // mexe nisso, é responsabilidade de quem chama).
  for (const { appt, payment, target } of toRestoreAndReposition) {
    const session = appt.session
      ? await Session.findById(appt.session).session(mongoSession)
      : await Session.findOne({ appointmentId: appt._id }).session(mongoSession);

    await restoreCanceledAppointment(
      {
        _id: appt._id,
        serviceType: appt.serviceType,
        package: appt.package || null,
        session: session ? { _id: session._id } : null,
        payment: payment ? { _id: payment._id } : null,
        paymentOrigin: appt.paymentOrigin,
        sessionValue: appt.sessionValue
      },
      { reason: `${reason} (reativação por replanejamento)` },
      user,
      mongoSession
    );

    // 🚨 FIX shadow financeiro de convênio: reativação nunca pode deixar
    // paymentStatus='unpaid' (nem existe na tabela de status documentada —
    // ver REGRAS_NEGOCIO_CONSOLIDADO.md). Para convênio o shadow correto é
    // 'pending_receipt', o mesmo valor usado na criação normal da sessão.
    const newDateTime = { date: target.date, time: target.time, updatedAt: new Date() };
    await Appointment.updateOne(
      { _id: appt._id },
      {
        $set: {
          operationalStatus: 'pre_agendado',
          clinicalStatus: 'pending',
          status: 'pre_agendado',
          paymentStatus: 'pending_receipt',
          insuranceGuide: guide._id,
          insurancePlan: plan._id,
          ...newDateTime
        },
        $push: {
          history: {
            action: 'reativacao_via_replanejamento',
            newStatus: 'pre_agendado',
            changedBy: user?._id || user?.id || null,
            timestamp: new Date(),
            context: reason
          }
        }
      },
      // 🚨 financialSanitizer (models/plugins/financialSanitizer.js) intercepta
      // pre(['updateOne','updateMany','findOneAndUpdate']) e remove silenciosamente
      // paymentStatus/isPaid de QUALQUER update que não venha com essas duas flags —
      // mesmo bypass que updateAppointmentCommand.js já usa pro mesmo campo. Sem
      // isso, o fix do shadow financeiro (pending_receipt) nunca persiste: o
      // modifiedCount vem 1 (outros campos do $set aplicam normal), só paymentStatus
      // some do payload antes de chegar no Mongo.
      { session: mongoSession, __fromFinancialGuard: true, __guardContext: 'FINANCIAL' }
    );
    if (session) {
      await Session.updateOne(
        { _id: session._id },
        { $set: { ...newDateTime } },
        { session: mongoSession }
      );
    }

    const updated = { ...appt, date: target.date, time: target.time, operationalStatus: 'pre_agendado' };
    touchedAppointments.push(updated);
    if (target.date < today) pastAppointments.push(updated);
  }

  // 8c. Cria só o que sobrou sem nenhum registro reaproveitável (trinca completa
  // — mesmo padrão de generateInsurancePlanSessions.js — nunca cria Payment
  // duplicado porque só passa por aqui quem não tinha NENHUM registro existente).
  let createdAppointments = [];
  if (toCreate.length > 0) {
    const apptDocs = toCreate.map(target => ({
      patient: plan.patient,
      doctor: plan.doctor,
      specialty: plan.specialty,
      date: target.date,
      time: target.time,
      duration: plan.duration || 40,
      serviceType: 'session',
      sessionType: plan.specialty,
      billingType: 'convenio',
      paymentMethod: 'convenio',
      insuranceGuide: guide._id,
      insurancePlan: plan._id,
      insuranceProvider: guide.insurance,
      ...(effectiveSessionValue > 0 && { sessionValue: effectiveSessionValue, insuranceValue: effectiveSessionValue }),
      operationalStatus: 'pre_agendado',
      clinicalStatus: 'pending',
      paymentStatus: 'pending_receipt',
      status: 'pre_agendado',
      notes: 'Sessão de convênio gerada pelo replanejamento',
      metadata: { origin: { source: 'insurance_plan' } },
      createdAt: new Date()
    }));
    createdAppointments = await Appointment.insertMany(apptDocs, { session: mongoSession });

    const sessionDocs = createdAppointments.map(a => buildInsuranceSession({
      _id: a._id,
      patient: plan.patient,
      doctor: plan.doctor,
      date: a.date,
      time: a.time,
      specialty: plan.specialty,
      serviceType: a.serviceType,
      sessionType: a.sessionType,
      sessionValue: effectiveSessionValue,
      insuranceGuide: guide._id,
      insurancePlan: plan._id
    }));
    const createdSessions = await Session.insertMany(sessionDocs, { session: mongoSession });

    const sessionLinkOps = createdSessions.map((s, i) => ({
      updateOne: { filter: { _id: createdAppointments[i]._id }, update: { $set: { session: s._id } } }
    }));
    await Appointment.bulkWrite(sessionLinkOps, { session: mongoSession, ordered: false });

    const paymentDocs = createdAppointments.map((a, i) => ({
      patient: plan.patient,
      doctor: plan.doctor,
      appointment: a._id,
      session: createdSessions[i]._id,
      specialty: plan.specialty,
      amount: 0,
      billingType: 'convenio',
      status: 'pending',
      financialDate: null,
      paymentDate: new Date(),
      paymentMethod: 'convenio',
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
    const createdPayments = await Payment.insertMany(paymentDocs, { session: mongoSession });

    const paymentLinkOps = createdPayments.map((p, i) => ({
      updateOne: { filter: { _id: createdAppointments[i]._id }, update: { $set: { payment: p._id } } }
    }));
    await Appointment.bulkWrite(paymentLinkOps, { session: mongoSession, ordered: false });

    for (let i = 0; i < createdAppointments.length; i++) {
      const withIds = { ...createdAppointments[i].toObject(), session: createdSessions[i]._id, payment: createdPayments[i]._id };
      touchedAppointments.push(withIds);
      if (toCreate[i].date < today) pastAppointments.push(withIds);
    }
  }

  // 8d. Cancela excedente (nunca hard-delete)
  let canceledCount = 0;
  if (leftoverRepositionable.length > 0) {
    const cancelRes = await bulkCancelAppointments(
      leftoverRepositionable.map(a => a._id),
      { reason: `${reason} (excedente após replanejamento)` },
      user,
      mongoSession
    );
    canceledCount = cancelRes.canceled;
  }

  await InsurancePlan.findByIdAndUpdate(
    plan._id,
    { generatedAppointments: [...completedAppts, ...frozenAppts, ...touchedAppointments].map(a => a._id) },
    { session: mongoSession }
  );

  console.log('[replanInsurancePlanSessions] Concluído', {
    planId: plan._id.toString(),
    guideId: guide._id.toString(),
    reused: toReposition.length,
    restored: toRestoreAndReposition.length,
    created: toCreate.length,
    canceledExcedente: canceledCount,
    pastAppointments: pastAppointments.length
  });

  return {
    appointmentsDeleted: 0,
    appointmentsCanceled: canceledCount,
    appointmentsGenerated: toCreate.length + toReposition.length + toRestoreAndReposition.length,
    appointments: touchedAppointments,
    pastAppointments
  };
}
