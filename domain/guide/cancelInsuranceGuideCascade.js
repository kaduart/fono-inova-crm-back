// domain/guide/cancelInsuranceGuideCascade.js
// Cascata transacional de cancelamento de guia de convênio (inativação).
//
// Achado real (2026-08-14, guia 16173377/Ícaro): o fluxo antigo em
// insuranceGuides.v2.js só tratava appointments FUTUROS (`date: {$gte: today}`),
// via hard-delete (deleteAppointmentsWithChildren) sem transação nem histórico.
// Um appointment `missed` no PASSADO (virou missed por auto_expired, antes da
// guia ser cancelada) nunca era tocado — ficava pra sempre ocupando o horário
// no calendário, mesmo com a guia já cancelada, bloqueando qualquer outra guia
// que tentasse usar o mesmo slot depois (via checkSlotConflicts).
//
// Regra:
//   completed                              → nunca tocado
//   qualquer outro status não-cancelado
//   (missed, pending, scheduled,
//    pre_agendado, confirmed, etc.)        → cancelado, PASSADO ou FUTURO
//   Session vinculada                      → cancelada (via cancelAppointmentCommand)
//   Payment pendente                       → cancelado (via cancelAppointmentCommand)
//   Payment faturado/recebido/parcial      → BLOQUEIA a cascata inteira, zero
//                                             mutação, antes de cancelar qualquer
//                                             appointment (revisão financeira manual)
//   usedSessions                           → nunca decrementado (cancelAppointmentCommand
//                                             não mexe em InsuranceGuide)
//   histórico                              → cada cancelamento grava o status anterior
//                                             e o motivo (fechamento da guia) via
//                                             cancelAppointmentCommand.history + cancelSource='guide_closure'
//   tudo numa única transação              → a guia só vira 'cancelled' se a
//                                             cascata inteira (appointments + plano
//                                             + pacotes) concluir sem erro

import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import InsurancePlan from '../../models/InsurancePlan.js';
import Package from '../../models/Package.js';
import { executeWithSession as cancelAppointmentWithSession } from '../../services/appointment/commands/cancelAppointmentCommand.js';
import { isPaymentFinanciallyReversible } from '../payment/isPaymentFinanciallyReversible.js';

const NEVER_TOUCHED_STATUSES = ['completed'];
const ALREADY_CANCELED_STATUSES = ['canceled', 'cancelled'];

/**
 * @param {string|ObjectId} guideId
 * @param {Object} params
 * @param {Object} [params.user] - usuário que disparou a inativação (audit)
 * @returns {Promise<{ appointmentsCanceled: number, planCanceled: boolean, packageCanceled: boolean }>}
 */
export async function cancelInsuranceGuideCascade(guideId, { user } = {}) {
  const mongoSession = await mongoose.startSession();
  mongoSession.startTransaction();

  try {
    const guide = await InsuranceGuide.findById(guideId).session(mongoSession);
    if (!guide) {
      const err = new Error('Guia não encontrada');
      err.code = 'NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    // 🚨 FIX (2026-08-14, guia 16173377/Ícaro): antes retornava 400
    // ALREADY_CANCELLED e saía sem processar nada — se a guia já tinha sido
    // marcada 'cancelled' pelo fluxo antigo (que não cancelava appointment
    // nenhum), os órfãos ficavam presos pra sempre, sem nenhuma forma de
    // rodar a cascata de novo sobre eles. Agora, se já está cancelled, só
    // pula o `guide.save()` final (idempotente — nada a fazer ali) e segue
    // pra reconciliar os appointments órfãos normalmente.
    const wasAlreadyCancelled = guide.status === 'cancelled';

    const linkedPackages = await Package.find({ insuranceGuide: guide._id }).session(mongoSession).select('_id').lean();
    const packageIds = linkedPackages.map(p => p._id);
    const linkedPlan = await InsurancePlan.findOne({ guide: guide._id }).session(mongoSession).lean();

    const orClauses = [{ insuranceGuide: guide._id }];
    if (linkedPlan) orClauses.push({ insurancePlan: linkedPlan._id });
    if (packageIds.length > 0) orClauses.push({ package: { $in: packageIds } });

    // TODO status não-completed e não-já-cancelado, PASSADO ou FUTURO — sem
    // filtro de data (essa era a lacuna real: `date: {$gte: today}` deixava
    // o missed do passado intocado).
    const appointmentsToCancel = await Appointment.find({
      $or: orClauses,
      operationalStatus: { $nin: [...NEVER_TOUCHED_STATUSES, ...ALREADY_CANCELED_STATUSES] }
    }).session(mongoSession).lean();

    // ── Bloqueio financeiro ANTES de cancelar qualquer coisa ──────────────
    // Une os três vínculos possíveis de Payment (appointment/session/appt.payment
    // legado) — mesmo critério do replan in-place — e bloqueia a cascata
    // inteira se qualquer appointment tiver Payment com financeiro avançado.
    const blockedByFinance = [];
    for (const appt of appointmentsToCancel) {
      const payments = await Payment.find({
        $or: [
          { appointment: appt._id },
          ...(appt.session ? [{ session: appt.session }] : []),
          ...(appt.payment ? [{ _id: appt.payment }] : [])
        ]
      }).session(mongoSession).lean();
      const advanced = payments.filter(p => !isPaymentFinanciallyReversible(p));
      if (advanced.length > 0) {
        blockedByFinance.push({
          appointmentId: appt._id,
          date: appt.date,
          time: appt.time,
          operationalStatus: appt.operationalStatus,
          payments: advanced.map(p => ({ id: p._id, status: p.status, insuranceStatus: p.insurance?.status }))
        });
      }
    }
    if (blockedByFinance.length > 0) {
      const err = new Error(
        `Inativação bloqueada: ${blockedByFinance.length} agendamento(s) desta guia têm Payment com financeiro ` +
        `avançado (faturado/pago/parcial/recebido). Resolva manualmente (conciliação financeira) antes de inativar.`
      );
      err.code = 'GUIDE_CANCEL_BLOCKED_NON_REVERSIBLE_PAYMENT';
      err.statusCode = 409;
      err.blockedBy = blockedByFinance;
      throw err;
    }

    // ── Cascata: cancela cada appointment via comando canônico ────────────
    // (Session + Payment pendente + histórico + outbox — tudo dentro da
    // mesma transação; nunca mexe em InsuranceGuide.usedSessions)
    let appointmentsCanceled = 0;
    for (const appt of appointmentsToCancel) {
      await cancelAppointmentWithSession(
        appt._id,
        {
          reason: `Guia ${guide.number} inativada — agendamento estava '${appt.operationalStatus}'`,
          cancelSource: 'guide_closure'
        },
        user,
        mongoSession
      );
      appointmentsCanceled++;
    }

    let planCanceled = false;
    if (linkedPlan) {
      await InsurancePlan.findByIdAndUpdate(
        linkedPlan._id,
        { status: 'cancelled', updatedAt: new Date() },
        { session: mongoSession }
      );
      planCanceled = true;
    }

    let packageCanceled = false;
    if (packageIds.length > 0) {
      await Package.updateMany(
        { _id: { $in: packageIds } },
        { status: 'canceled', updatedAt: new Date() },
        { session: mongoSession }
      );
      packageCanceled = true;
    }

    if (!wasAlreadyCancelled) {
      guide.status = 'cancelled';
      guide.updatedAt = new Date();
      await guide.save({ session: mongoSession });
    }

    await mongoSession.commitTransaction();

    console.log('[cancelInsuranceGuideCascade] Guia inativada', {
      guideId: guide._id.toString(),
      guideNumber: guide.number,
      wasAlreadyCancelled,
      appointmentsCanceled,
      planCanceled,
      packageCanceled
    });

    return { appointmentsCanceled, planCanceled, packageCanceled, wasAlreadyCancelled };
  } catch (err) {
    await mongoSession.abortTransaction();
    throw err;
  } finally {
    mongoSession.endSession();
  }
}
