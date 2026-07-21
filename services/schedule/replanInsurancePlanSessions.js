// services/schedule/replanInsurancePlanSessions.js
// Replaneja a agenda futura de um plano de convênio após uma mudança ESTRUTURAL
// (frequência/slots) — não é um "reset da guia". Sessões já realizadas nunca são
// tocadas (guide.usedSessions é a fonte de verdade do que já aconteceu); só a
// parte da agenda que ainda não aconteceu é cancelada e regenerada pelo padrão
// vigente do plano.
//
// Responsabilidade dividida de propósito:
//   generateInsurancePlanSessions → primeira geração / complemento (nada mudou).
//   replanInsurancePlanSessions   → mudança estrutural do plano (frequência/slots).
//
// Achado real: guia #319995 (Terapia Ocupacional, Unimed Fesp, 2026-07-20). Plano
// criado com 1 slot/semana consumiu as 14 sessões autorizadas 1x/semana ao longo
// de 14 semanas. Ao editar o plano para 3 slots/semana, nada cancelava o padrão
// antigo — a guia ficava presa em "100% reservada" pelo padrão errado para sempre.

import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import InsurancePlan from '../../models/InsurancePlan.js';
import { GuideLifecycleService } from '../guideLifecycle/GuideLifecycleService.js';
import { generateInsurancePlanSessions } from './generateInsurancePlanSessions.js';
import { executeWithSession as bulkCancelAppointments } from '../appointment/commands/bulkCancelAppointmentsCommand.js';

/**
 * Status que podem ser deletados sem perder histórico relevante.
 * "confirmed" e demais são protegidos: são cancelados em vez de deletados.
 */
const DELETABLE_STATUSES = ['scheduled', 'pre_agendado', 'pending'];
const CANCELABLE_STATUSES = ['confirmed'];

/**
 * @param {Object} params
 * @param {string} params.planId       - ID do InsurancePlan (já deve estar salvo com os slots NOVOS)
 * @param {string} params.guideId      - ID da InsuranceGuide
 * @param {mongoose.ClientSession} params.mongoSession - Sessão MongoDB ativa (transação do caller)
 * @param {Object} [params.user]       - Usuário que disparou a mudança (audit do cancelamento)
 * @param {string} [params.reason]     - Motivo do cancelamento das sessões futuras antigas
 * @returns {Promise<{ appointmentsCanceled: number, appointmentsGenerated: number, appointments: Array }>}
 */
export async function replanInsurancePlanSessions({
  planId,
  guideId,
  mongoSession,
  user,
  reason = 'plan_frequency_changed'
}) {
  const guide = await InsuranceGuide.findById(guideId).session(mongoSession).lean();
  if (!guide) throw new Error('GUIDE_NOT_FOUND');

  const lifecycle = await GuideLifecycleService.evaluate(guide, new Date());
  if (!lifecycle.eligibility.canSchedule) {
    const blockingAlert = lifecycle.alerts.find(a => a.severity === 'error');
    const err = new Error(blockingAlert?.message || 'Guia não elegível para replanejar sessões');
    err.code = 'GUIDE_NOT_ELIGIBLE';
    throw err;
  }

  const plan = await InsurancePlan.findById(planId).session(mongoSession).lean();
  if (!plan) throw new Error('PLAN_NOT_FOUND');

  console.log('[replanInsurancePlanSessions] Iniciando replanejamento', {
    planId: plan._id.toString(),
    guideId: guide._id.toString(),
    guideTotal: guide.totalSessions,
    guideUsed: guide.usedSessions
  });

  // Sessões futuras ainda não realizadas geradas por este plano. Busca pela fonte
  // de verdade (relacionamento insurancePlan/insuranceGuide), não pelo cache
  // generatedAppointments, que pode ficar inconsistente.
  const today = new Date().toISOString().split('T')[0];
  const futureAppointments = await Appointment.find({
    insurancePlan: plan._id,
    date: { $gte: today },
    operationalStatus: { $in: [...DELETABLE_STATUSES, ...CANCELABLE_STATUSES] }
  }).select('_id operationalStatus').session(mongoSession).lean();

  const futureCanceledByPlan = await Appointment.find({
    insurancePlan: plan._id,
    date: { $gte: today },
    operationalStatus: 'canceled',
    cancelReason: { $in: ['plan_frequency_changed', 'plan_slot_removed', 'plan_canceled', 'plan_reset'] }
  }).select('_id').session(mongoSession).lean();

  const toDelete = [
    ...futureAppointments
      .filter(a => DELETABLE_STATUSES.includes(a.operationalStatus))
      .map(a => a._id),
    ...futureCanceledByPlan.map(a => a._id)
  ];
  const toCancel = futureAppointments
    .filter(a => CANCELABLE_STATUSES.includes(a.operationalStatus))
    .map(a => a._id);

  console.log('[replanInsurancePlanSessions] Sessões futuras encontradas', {
    deletable: toDelete.length,
    cancelable: toCancel.length
  });

  let appointmentsDeleted = 0;
  if (toDelete.length > 0) {
    await Session.deleteMany(
      { appointmentId: { $in: toDelete } },
      { session: mongoSession }
    );
    await Payment.deleteMany(
      { appointment: { $in: toDelete } },
      { session: mongoSession }
    );
    const deleteRes = await Appointment.deleteMany(
      { _id: { $in: toDelete } },
      { session: mongoSession }
    );
    appointmentsDeleted = deleteRes.deletedCount || 0;
  }

  let appointmentsCanceled = 0;
  if (toCancel.length > 0) {
    const cancelRes = await bulkCancelAppointments(toCancel, { reason }, user, mongoSession);
    appointmentsCanceled = cancelRes.canceled;
  }

  console.log('[replanInsurancePlanSessions] Limpeza concluída', {
    appointmentsDeleted,
    appointmentsCanceled
  });

  // remaining = guide.totalSessions - guide.usedSessions - reservado (calculado
  // dentro de generateInsurancePlanSessions). Como acabamos de cancelar tudo que
  // era "reservado" no padrão antigo, remaining agora reflete exatamente o que
  // ainda falta autorizar no padrão novo — sem tocar em usedSessions.
  const regenResult = await generateInsurancePlanSessions({
    planId: plan._id,
    guideId: guide._id,
    sessionValue: plan.sessionValue || 0,
    mongoSession,
    skipHolidays: true
  });

  console.log('[replanInsurancePlanSessions] Regeneração concluída', {
    appointmentsGenerated: regenResult.count
  });

  return {
    appointmentsDeleted,
    appointmentsCanceled: appointmentsCanceled + appointmentsDeleted,
    appointmentsGenerated: regenResult.count,
    appointments: regenResult.appointments
  };
}
