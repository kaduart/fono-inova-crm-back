// services/schedule/replanInsurancePlanSessions.js
// Replaneja a agenda de um plano de convênio IN-PLACE — reaproveita
// Appointment/Session/Payment existentes em vez de apagar e recriar.
//
// Regra (ver auditoria 2026-08-14, caso guia 16173376/Ícaro):
//   completed          → nunca tocado, nunca movido, continua consumindo autorização
//   pre_agendado/scheduled → reposicionado (mesmos IDs), pode virar completed se a
//                         data alvo cair no passado (via completeSessionV2, pós-commit)
//   canceled           → reaproveitado (restaurado + reposicionado) SOMENTE se
//                         TODOS os Payments vinculados (appointment OU session,
//                         nunca só `appointment.payment` — pode haver duplicata
//                         histórica) forem financeiramente reversíveis
//                         (isPaymentFinanciallyReversible) — senão fica intocado
//                         e, se for preciso criar sessão nova pra cobrir a
//                         capacidade, o replan BLOQUEIA (não cria por cima
//                         silenciosamente — ver bloqueio CONVENIO_REPLAN_...)
//   confirmed/missed   → nunca movido automaticamente; ocupa capacidade mas fica
//                         fora do pool de reaproveitamento
//   registro de OUTRA guia no mesmo horário → conflito, aborta antes de qualquer
//                         escrita (checkSlotConflicts), nunca cancela sozinho
//   pre_agendado/scheduled sobrando (fora da série esperada) → cancelado (nunca
//                         hard-delete) via bulkCancelAppointmentsCommand — se
//                         qualquer cancelamento falhar, a transação inteira aborta
//                         (nunca commit parcial)
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
import { isPaymentFinanciallyReversible } from '../../domain/payment/isPaymentFinanciallyReversible.js';

// Reexportado por compatibilidade — código/testes existentes importam esse
// predicate a partir daqui. Fonte real: domain/payment/isPaymentFinanciallyReversible.js
// (extraído pra lá em 2026-08-15 pra permitir reuso em cancelAppointmentCommand.js
// sem criar import circular: replanInsurancePlanSessions.js → bulkCancelAppointmentsCommand.js
// → cancelAppointmentCommand.js).
export { isPaymentFinanciallyReversible };

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

/** Série cronológica exata esperada: `count` datas NOVAS, a partir de
 *  startDate/slots, pulando feriados e pulando datas já ocupadas por
 *  `completed`/`confirmed`/`missed` (`occupiedKeys`) — essas não contam pra
 *  `count` porque não é possível gerar trabalho novo nelas (já estão
 *  "gastas"/congeladas). Sem esse skip, a série anda de forma cega: se ela
 *  colide com uma data já ocupada, o `count` desejado nunca é alcançado (1
 *  posição "some" silenciosamente) — achado real do bloqueador 1 do review de
 *  2026-08-14 (guia com 18 autorizadas, 1 completed: a série gerava só 17
 *  posições, uma delas coincidindo com a data da completed, sobrando só 16
 *  posições realmente novas quando 17 eram necessárias).
 */
function buildExpectedSeries({ plan, count, startFloor, holidays, occupiedKeys = new Set() }) {
  if (count <= 0) return [];
  const weekStart = getWeekStart(startFloor);
  const series = [];
  let created = 0;
  const maxWeeks = 520; // guarda de segurança (~10 anos) — precisa cobrir o skip de ocupadas
  for (let w = 0; created < count && w < maxWeeks; w++) {
    const weekSunday = addDays(weekStart, w * 7);
    for (const slot of plan.slots) {
      if (created >= count) break;
      const d = addDays(weekSunday, slot.dayOfWeek);
      if (d < startFloor) continue;
      const dStr = dateStrOf(d);
      if (holidays.has(dStr)) continue;
      if (occupiedKeys.has(slotKeyOf(dStr, slot.time))) continue; // já consumida por completed/frozen, não conta
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

  // ── 4. Série cronológica exata esperada (pula datas já ocupadas por
  // completed/frozen — ver comentário de buildExpectedSeries) ────────────
  const occupiedKeys = new Set([
    ...completedAppts.map(a => slotKeyOf(dateStrOf(a.date), a.time)),
    ...frozenAppts.map(a => slotKeyOf(dateStrOf(a.date), a.time))
  ]);
  const expectedSeries = buildExpectedSeries({ plan, count: mutableSlotsNeeded, startFloor, holidays, occupiedKeys });

  // ── 5. Reversibilidade financeira de cada cancelado (predicate canônico) ──
  // Busca TODOS os Payments vinculados (por appointment OU por session — mesmo
  // filtro que cancelAppointmentCommand usa pra cancelar, porque pode haver
  // duplicata histórica de Payment pro mesmo appointment/session). Só é
  // reversível se TODOS forem reversíveis — um único Payment com financeiro
  // avançado (faturado/recebido/parcial) já bloqueia a reutilização.
  const canceledWithPayment = await Promise.all(canceledPool.map(async appt => {
    // 🚨 FIX (review 2026-08-14, bloqueador 2): une os TRÊS vínculos possíveis —
    // appointment.payment pode apontar pra um Payment legado sem back-reference
    // de appointment/session (vínculo histórico inconsistente, cenário real
    // documentado no comentário de cancelAppointmentCommand.js). $or dedupica
    // automaticamente por _id, então não duplica quando os vínculos coincidem.
    const payments = await Payment.find({
      $or: [
        { appointment: appt._id },
        ...(appt.session ? [{ session: appt.session }] : []),
        ...(appt.payment ? [{ _id: appt.payment }] : [])
      ]
    }).session(mongoSession).lean();
    const reversible = payments.every(isPaymentFinanciallyReversible);
    return { appt, payments, reversible };
  }));
  const reversibleCanceled = canceledWithPayment.filter(c => c.reversible);
  const nonReversibleCanceled = canceledWithPayment.filter(c => !c.reversible);

  // ── 6. Matching: série esperada × registros existentes (DUAS PASSADAS) ──
  // 🚨 FIX (review 2026-08-14): matching em passada única, na ordem cronológica
  // da série, fazia o fallback greedy (“pega o primeiro item do pool que sobrar”)
  // consumir um item que na verdade já estava EXATAMENTE certo pra um alvo mais
  // à frente na série — ex: ao preencher retroativas (processadas primeiro,
  // cronologicamente), o algoritmo pegava de "empréstimo" o appointment futuro
  // mais próximo (que já estava certo) só porque ele era o primeiro do pool
  // ainda não usado, e então precisava reempurrar tudo em cascata pros alvos
  // seguintes. O resultado final até ficava correto (nenhuma sessão perdida),
  // mas reescrevia Appointment/Session de registros que não precisavam de
  // nenhuma mudança — ruído desnecessário no histórico/auditoria e mais
  // superfície de escrita do que o necessário. Agora reserva TODO exact-match
  // primeiro (passada 1, sem depender de ordem), só then preenche o que sobrou
  // com o fallback greedy (passada 2).
  const usedPoolIds = new Set();
  const toCreate = [];                 // slots sem NENHUM registro reaproveitável
  const toReposition = [];             // { appt, target } — pre_agendado/scheduled
  const toRestoreAndReposition = [];   // { appt, target } — canceled reversível

  const matchesSlot = (appt, target) => dateStrOf(appt.date) === target.dateStr && appt.time === target.time;

  // Passada 1: reserva todo alvo já exatamente satisfeito por completed/frozen/
  // repositionable — antes de qualquer fallback greedy tocar no pool.
  const unmatchedTargets = [];
  for (const target of expectedSeries) {
    const alreadyThereRepositionable = repositionablePool.find(a => !usedPoolIds.has(a._id.toString()) && matchesSlot(a, target));
    const alreadyThere =
      alreadyThereRepositionable ||
      frozenAppts.find(a => matchesSlot(a, target)) ||
      completedAppts.find(a => matchesSlot(a, target));
    if (alreadyThere) {
      if (alreadyThereRepositionable) usedPoolIds.add(alreadyThereRepositionable._id.toString());
      continue; // já satisfeito, nada a fazer nesse alvo
    }
    unmatchedTargets.push(target);
  }

  // Passada 2: só os alvos que sobraram (sem exact-match nenhum) disputam o
  // pool restante — reposiciona, depois restaura cancelado reversível, depois cria.
  for (const target of unmatchedTargets) {
    const repoCandidate = repositionablePool.find(a => !usedPoolIds.has(a._id.toString()));
    if (repoCandidate) {
      usedPoolIds.add(repoCandidate._id.toString());
      toReposition.push({ appt: repoCandidate, target });
      continue;
    }

    const cancelCandidate = reversibleCanceled.find(c => !usedPoolIds.has(c.appt._id.toString()));
    if (cancelCandidate) {
      usedPoolIds.add(cancelCandidate.appt._id.toString());
      toRestoreAndReposition.push({ appt: cancelCandidate.appt, target });
      continue;
    }

    toCreate.push(target);
  }

  // 🚨 Bloqueio financeiro: se sobrou alvo pra CRIAR (toCreate) e existe algum
  // cancelado com financeiro avançado (faturado/pago/parcial/recebido) nesta
  // guia que não pôde ser reaproveitado, não cria silenciosamente por cima —
  // bloqueia e reporta pra decisão manual. Criar um trio novo quando há uma
  // pendência financeira não resolvida no histórico da guia é exatamente o
  // tipo de ambiguidade que precisa de revisão humana, não resolução automática
  // (mesmo espírito do 409 PLAN_HAS_ASSOCIATED_RECORDS e do bloqueio de reset
  // da liminar: na dúvida financeira, bloqueia).
  if (toCreate.length > 0 && nonReversibleCanceled.length > 0) {
    const err = new Error(
      `Replanejamento bloqueado: a guia ${guide._id} precisa de ${toCreate.length} sessão(ões) nova(s), mas há ` +
      `${nonReversibleCanceled.length} agendamento(s) cancelado(s) com financeiro avançado (faturado/pago/parcial/recebido) ` +
      `nesta guia que não puderam ser reaproveitados. Resolva manualmente (conciliação financeira) antes de continuar.`
    );
    err.code = 'CONVENIO_REPLAN_BLOCKED_NON_REVERSIBLE_CANCELED';
    err.statusCode = 409;
    err.blockedBy = nonReversibleCanceled.map(c => ({
      appointmentId: c.appt._id,
      date: c.appt.date,
      time: c.appt.time,
      paymentStatuses: c.payments.map(p => ({ id: p._id, status: p.status, insuranceStatus: p.insurance?.status }))
    }));
    throw err;
  }

  // Sobrou pre_agendado/scheduled não usado por nenhum alvo da série esperada
  // (ex: plano encolheu ou mudou de padrão) — cancela, nunca hard-delete.
  const leftoverRepositionable = repositionablePool.filter(a => !usedPoolIds.has(a._id.toString()));

  // ── 7. Checa conflito com QUALQUER outro registro bloqueante ANTES de
  // qualquer escrita — inclusive dentro da PRÓPRIA guia (confirmed/missed que
  // só se sobrepõe PARCIALMENTE a um alvo, não coincide exatamente — esse caso
  // `occupiedKeys` no passo 4 não pega, porque ali só compara data+hora exata).
  // Exclui só os IDs que estão de fato sendo movidos nesta chamada (toReposition/
  // toRestoreAndReposition) — nunca o plano inteiro (ver fix no bloqueador 1 do
  // review 2026-08-14 em generateInsurancePlanSessions.js/checkSlotConflicts).
  // Se qualquer alvo colidir, a função lança e nada é escrito (transação do
  // caller aborta). Nunca cancela/move o registro que já estava lá.
  const excludeAppointmentIds = [
    ...toReposition.map(r => r.appt._id),
    ...toRestoreAndReposition.map(r => r.appt._id)
  ];
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
      excludeAppointmentIds
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
  for (const { appt, target } of toRestoreAndReposition) {
    const session = appt.session
      ? await Session.findById(appt.session).session(mongoSession)
      : await Session.findOne({ appointmentId: appt._id }).session(mongoSession);

    const paymentRef = appt.payment
      ? await Payment.findById(appt.payment).session(mongoSession).lean()
      : await Payment.findOne({ appointment: appt._id }).session(mongoSession).lean();

    await restoreCanceledAppointment(
      {
        _id: appt._id,
        serviceType: appt.serviceType,
        package: appt.package || null,
        session: session ? { _id: session._id } : null,
        payment: paymentRef ? { _id: paymentRef._id } : null,
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
      // 🚨 FIX: restoreCanceledAppointmentCommand deliberadamente NÃO mexe em
      // Session.paymentStatus (ver comentário no próprio arquivo — quem decide
      // é o caller). Sem setar aqui, a Session ficava com paymentStatus='canceled'
      // (valor gravado pelo cancelAppointmentCommand original) enquanto o
      // Appointment já mostrava 'pending_receipt' — Appointment e Session
      // divergentes pro mesmo registro. Mesmo bypass do financialSanitizer que
      // o Appointment.updateOne acima usa (Session também tem o plugin).
      await Session.updateOne(
        { _id: session._id },
        { $set: { ...newDateTime, paymentStatus: 'pending_receipt', isPaid: false, visualFlag: 'pending' } },
        { session: mongoSession, __fromFinancialGuard: true, __guardContext: 'FINANCIAL' }
      );
    }

    const updated = { ...appt, date: target.date, time: target.time, operationalStatus: 'pre_agendado' };
    touchedAppointments.push(updated);
    if (target.date < today) pastAppointments.push(updated);
  }

  // 8c. Cria só o que sobrou sem nenhum registro reaproveitável (trinca completa
  // — mesmo padrão de generateInsurancePlanSessions.js — nunca cria Payment
  // duplicado porque só passa por aqui quem não tinha NENHUM registro existente,
  // e o bloqueio do passo 6 já garante que nenhum cancelado-não-reversível fica
  // "escondido atrás" de uma criação nova sem revisão humana).
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

  // 8d. Cancela excedente (nunca hard-delete). Se QUALQUER cancelamento falhar,
  // aborta a transação inteira em vez de commitar um estado parcial — o replan
  // é idempotente por design, então uma nova tentativa depois de corrigido o
  // erro reprocessa do zero sem duplicar nada.
  let canceledCount = 0;
  if (leftoverRepositionable.length > 0) {
    const cancelRes = await bulkCancelAppointments(
      leftoverRepositionable.map(a => a._id),
      { reason: `${reason} (excedente após replanejamento)` },
      user,
      mongoSession
    );
    if (cancelRes.errors && cancelRes.errors.length > 0) {
      const err = new Error(
        `Replanejamento abortado: falha ao cancelar ${cancelRes.errors.length} agendamento(s) excedente(s) — ` +
        cancelRes.errors.map(e => `${e.id}: ${e.error}`).join('; ')
      );
      err.code = 'CONVENIO_REPLAN_CANCEL_FAILED';
      err.statusCode = 500;
      throw err;
    }
    canceledCount = cancelRes.canceled;
  }

  // 🚨 FIX generatedAppointments: precisa incluir TODO registro que hoje compõe
  // a agenda ativa da guia — inclusive os que já estavam certos e por isso nunca
  // passaram por `touchedAppointments` (nenhuma escrita neles = idempotência
  // correta, mas ainda fazem parte da agenda). Sem isso, numa execução realmente
  // idempotente (nada precisa mudar), `generatedAppointments` era gravado quase
  // vazio — só completed+frozen, perdendo o vínculo com os pre_agendado/scheduled
  // que continuavam exatamente onde deveriam estar.
  const finalIds = [
    ...completedAppts.map(a => a._id),
    ...frozenAppts.map(a => a._id),
    ...repositionablePool.filter(a => usedPoolIds.has(a._id.toString())).map(a => a._id),
    ...canceledPool.filter(a => usedPoolIds.has(a._id.toString())).map(a => a._id),
    ...createdAppointments.map(a => a._id)
  ];

  await InsurancePlan.findByIdAndUpdate(
    plan._id,
    { generatedAppointments: finalIds },
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
