// back/services/appointment/commands/cancelAppointmentCommand.js
/**
 * Cancel Appointment Command
 *
 * Responsabilidade: cancelar um agendamento preservando dados financeiros
 * para possível reagendamento e mantendo integridade com Session, Payment e Package.
 *
 * Garantias:
 * - Appointment e Session atualizados na mesma transação
 * - Ajuste de pacote (remainingSessions) dentro da transação principal
 * - Idempotente: cancelar 2x retorna o mesmo resultado sem duplicar efeitos
 * - Payment session_payment pendente é cancelado
 */

import mongoose from 'mongoose';
import Appointment from '../../../models/Appointment.js';
import Payment from '../../../models/Payment.js';
import Session from '../../../models/Session.js';
import Package from '../../../models/Package.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { handlePackageSessionUpdate, syncEvent } from '../../syncService.js';
import { emitSocket } from '../helpers/socketHelper.js';
import { buildError, toObjectIdString } from './_helpers.js';
import { recordAudit } from '../../auditLogService.js';
import { saveToOutbox } from '../../../infrastructure/outbox/outboxPattern.js';
import { syncAffectedViews } from '../../projections/syncAffectedViews.js';
import { handlePaymentEvent } from '../../../projections/paymentsProjection.js';
import { restorePackageOnCancel } from '../../../domain/package/restorePackageOnCancel.js';
import PaymentLifecycleService from '../../../domain/payment/PaymentLifecycleService.js';
import { isPaymentFinanciallyReversible } from '../../../domain/payment/isPaymentFinanciallyReversible.js';
import { isInsuranceAppointment } from '../../../utils/appointmentMapper.js';
import LiminarGuard from '../../financialGuard/guards/liminar.guard.js';

/**
 * Core do cancelamento executado dentro de uma session MongoDB existente.
 * Pode ser reusado por outros commands/guards que já gerenciam a transação.
 *
 * @param {string|ObjectId} id - ID do Appointment
 * @param {Object} params
 * @param {string} params.reason - Motivo do cancelamento
 * @param {boolean} [params.confirmedAbsence=false] - Falta confirmada
 * @param {string} [params.cancelSource] - Origem do cancelamento (patient|clinic|system_billing|guide_closure|migration|converted_to_package)
 * @param {Object} [user] - Usuário que disparou
 * @param {mongoose.ClientSession} session - Session MongoDB ativa
 * @returns {Promise<Appointment>} Appointment atualizado
 */
export async function executeWithSession(id, { reason, confirmedAbsence = false, cancelSource }, user, session) {
  if (!reason) {
    throw buildError('O motivo do cancelamento é obrigatório', 400, 'MISSING_CANCEL_REASON');
  }

  const appointment = await Appointment.findById(id).populate('session payment').session(session);

  if (!appointment) {
    throw buildError('Agendamento não encontrado', 404, 'APPOINTMENT_NOT_FOUND');
  }

  // Guard dentro da transação (proteção contra race + idempotência)
  if (appointment.operationalStatus === 'canceled') {
    return appointment;
  }

  // Cancelar TODOS os Payments ativos vinculados à sessão/appointment.
  // Apenas cancelar appointment.payment deixa "fantasmas" quando existem
  // duplicatas históricas (legado) ou quando appointment.payment aponta para
  // um registro diferente do Payment ativo real da session.
  const activePaymentFilter = {
    $or: [
      { session: appointment.session },
      { appointment: appointment._id }
    ],
    status: { $nin: ['canceled', 'cancelled', 'refunded'] }
  };
  const activePayments = appointment.session || appointment._id
    ? await Payment.find(activePaymentFilter).session(session).lean()
    : [];

  // 🚨 GUARDAS DE CONVÊNIO (2026-08-15, auditoria do fluxo Convênio/card da guia):
  // escopadas por billingType==='convenio' — não muda nada pra particular/pacote/
  // liminar, que já têm o comportamento atual testado e intencional (ver
  // tests/integration/appointment-cancel-restore-roundtrip.test.js, "assimetria
  // documentada" — cancelar completed lá é permitido de propósito).
  //
  // Zero mutação em ambos os casos: os dois guards rodam ANTES de qualquer
  // escrita (payment/session/appointment), então um bloqueio aqui não deixa
  // rastro nenhum.
  // 🚨 FIX (review 2026-08-15): billingType==='convenio' sozinho não pega
  // convênio legado identificado só por insuranceGuide/paymentMethod/
  // insuranceProvider (dado histórico sem billingType preenchido corretamente).
  // isInsuranceAppointment (utils/appointmentMapper.js) é a mesma função que
  // routes/appointment.v2.js usa pra decidir o roteamento em PATCH /:id/complete
  // — reaproveitada aqui pra classificar de forma consistente com o resto do
  // sistema, não uma heurística nova.
  const isConvenio = isInsuranceAppointment(appointment);
  if (isConvenio) {
    // 1) completed é terminal pro convênio — já disparou consumo da guia
    // (InsuranceGuide.usedSessions) e liquidação de Payment via completeSessionV2,
    // sem contrapartida simétrica de reversão. Cancelar por aqui deixaria a guia
    // com sessão consumida mas o Appointment/Session/Payment como cancelado —
    // divergência permanente entre InsuranceGuide.usedSessions e a agenda real.
    if (appointment.operationalStatus === 'completed') {
      throw buildError(
        'Sessão de convênio já concluída não pode ser cancelada. Consumo da guia e faturamento já foram processados.',
        409,
        'CONVENIO_CANNOT_CANCEL_COMPLETED'
      );
    }

    // 2) Payment com financeiro avançado (faturado/pago/parcial/recebido) —
    // cancelar aqui reverteria Appointment/Session sem tocar no Payment (o loop
    // abaixo cancela IGUAL, mas o dinheiro já foi processado do lado do
    // convênio) — mesmo critério do replan in-place e da cascata de guia.
    // Busca dedicada por appointment/session (arquitetura V2 atual — vínculo
    // sempre presente); `activePayments` cobre o mesmo critério mas é usado
    // pelo loop de cancelamento abaixo, mantido separado de propósito.
    const guardPayments = await Payment.find({
      $or: [
        { appointment: appointment._id },
        ...(appointment.session ? [{ session: appointment.session }] : [])
      ]
    }).session(session).lean();
    const advancedPayments = guardPayments.filter(p => !isPaymentFinanciallyReversible(p));
    if (advancedPayments.length > 0) {
      const err = buildError(
        'Cancelamento bloqueado: Payment de convênio com financeiro avançado (faturado/pago/parcial/recebido). Resolva manualmente (conciliação financeira) antes de cancelar.',
        409,
        'CONVENIO_CANCEL_BLOCKED_NON_REVERSIBLE_PAYMENT'
      );
      err.blockedBy = advancedPayments.map(p => ({ id: p._id, status: p.status, insuranceStatus: p.insurance?.status }));
      throw err;
    }
  }

  if (appointment.liminarContract && appointment.operationalStatus === 'completed') {
    await LiminarGuard.handle({
      context: 'CANCEL_APPOINTMENT',
      session,
      payload: {
        liminarContractId: appointment.liminarContract,
        sessionValue: appointment.sessionValue,
        appointmentStatus: appointment.operationalStatus,
        confirmedAbsence,
        appointmentId: appointment._id,
      },
    });
  }

  for (const pay of activePayments) {
    // Cancela pagamentos avulsos e outros, exceto recibos de pacote já quitados
    const shouldCancel = pay.kind !== 'package_receipt';
    if (shouldCancel) {
      // 🔄 PR C.1: usa lifecycle centralizado para manter appointment.payment sincronizado
      const cancelResult = await PaymentLifecycleService.cancelPayment(pay._id, {
        reason,
        mongoSession: session,
      });
      if (cancelResult.canceled || cancelResult.alreadyCanceled) {
        console.log(`[cancelAppointmentCommand] Payment cancelado: ${pay._id}`);
      } else {
        console.warn(`[cancelAppointmentCommand] Payment NÃO cancelado: ${pay._id}`, {
          reason: cancelResult.reason
        });
      }
    }
  }

  // Guardar dados financeiros originais da Session e marcá-la como cancelada
  if (appointment.session) {
    const sessionDoc = await Session.findById(appointment.session).session(session);
    if (sessionDoc) {
      const wasSessionPaid =
        sessionDoc.paymentStatus === 'paid' ||
        sessionDoc.isPaid === true ||
        (sessionDoc.partialAmount && sessionDoc.partialAmount > 0);

      sessionDoc._inFinancialTransaction = true;

      if (wasSessionPaid && !sessionDoc.originalPartialAmount) {
        sessionDoc.originalPartialAmount = sessionDoc.partialAmount;
        sessionDoc.originalPaymentStatus = sessionDoc.paymentStatus;
        sessionDoc.originalPaymentMethod = sessionDoc.paymentMethod;
        sessionDoc.originalIsPaid = sessionDoc.isPaid;
      }

      sessionDoc.status = 'canceled';
      sessionDoc.paymentStatus = 'canceled';
      sessionDoc.visualFlag = 'blocked';
      sessionDoc.confirmedAbsence = confirmedAbsence;
      sessionDoc.canceledAt = new Date();
      sessionDoc.updatedAt = new Date();

      if (!sessionDoc.history) sessionDoc.history = [];
      sessionDoc.history.push({
        action: 'cancelamento_via_agendamento',
        changedBy: user?._id,
        timestamp: new Date(),
        details: { reason, confirmedAbsence, hadPayment: wasSessionPaid },
      });

      await sessionDoc.save({ session, validateBeforeSave: false });
    }
  }

  // Ajuste do pacote DENTRO da transação principal
  // remainingSessions é virtual (totalSessions - sessionsDone), então restauramos sessionsDone
  if (appointment.serviceType === 'package_session' && appointment.package) {
    // 🛡️ sessionsDone/totalPaid/paidSessions/balance/financialStatus via domínio:
    // só decrementa sessionsDone se o appointment JÁ estava completed (nunca
    // deixa negativo); estorna totalPaid/paidSessions só quando paymentOrigin
    // é 'auto_per_session'. appointment.operationalStatus aqui ainda é o status
    // PRÉ-cancelamento (o $set abaixo só roda depois).
    await restorePackageOnCancel(appointment.package, {
      appointmentStatus: appointment.operationalStatus,
      paymentOrigin: appointment.paymentOrigin,
      sessionValue: appointment.sessionValue,
      mongoSession: session,
      appointmentId: appointment._id,
    });

    // Limpeza dos arrays do pacote — `sessions` guarda Session._id, `appointments`
    // guarda Appointment._id (eram tratados como o mesmo ID antes, por isso a
    // sessão cancelada nunca saía de Package.sessions).
    await Package.findByIdAndUpdate(
      appointment.package,
      {
        $pull: { sessions: appointment.session?._id || appointment.session, appointments: appointment._id },
        $set: { updatedAt: new Date() },
      },
      { session }
    );
  }

  const updated = await Appointment.findByIdAndUpdate(
    appointment._id,
    {
      $set: {
        operationalStatus: 'canceled',
        clinicalStatus: confirmedAbsence ? 'missed' : 'pending',
        paymentStatus: 'canceled',
        visualFlag: 'blocked',
        cancelReason: reason,
        ...(cancelSource ? { cancelSource } : {}),
        canceledAt: new Date(),
        canceledBy: user?._id,
        confirmedAbsence,
        updatedAt: new Date(),
        _fromCancelService: true,
      },
      $push: {
        history: {
          action: 'cancelamento',
          newStatus: 'canceled',
          changedBy: user?._id,
          timestamp: new Date(),
          context: 'operacional',
          details: { reason, confirmedAbsence, cancelSource },
        },
      },
    },
    {
      new: true,
      session,
      __fromFinancialGuard: true,
      __guardContext: 'FINANCIAL',
    }
  ).populate('patient doctor session payment package');

  // 🚀 SALVAR EVENTO NO OUTBOX (dentro da transação)
  try {
    await saveToOutbox({
      eventType: 'APPOINTMENT_CANCELLED',
      aggregateType: 'appointment',
      aggregateId: appointment._id.toString(),
      payload: {
        appointmentId: appointment._id.toString(),
        patientId: appointment.patient?._id?.toString(),
        doctorId: appointment.doctor?._id?.toString(),
        // 🚨 FIX (2026-08-12): sem packageId o packageProjectionWorker descarta
        // o evento em `ignored / no_package_id` e a PackagesView nunca é
        // reconstruída — cancelamento sumia da tela do pacote (30 pacotes
        // divergentes em produção). O evento ficava 'published', sem erro algum.
        packageId: toObjectIdString(appointment.package),
        sessionId: toObjectIdString(appointment.session),
        reason,
        confirmedAbsence,
        cancelledAt: new Date(),
        cancelledBy: user?._id?.toString()
      },
      correlationId: appointment.correlationId || `cancel_${Date.now()}`
    }, session);
  } catch (eventErr) {
    console.error('[cancelAppointmentCommand] ❌ Erro ao salvar evento no Outbox:', eventErr.message);
    throw eventErr;
  }

  return updated;
}

export async function execute(id, { reason, confirmedAbsence = false }, user) {
  if (!reason) {
    throw buildError('O motivo do cancelamento é obrigatório', 400, 'MISSING_CANCEL_REASON');
  }

  // Guard de idempotência: se já está cancelado, retorna sem re-executar efeitos
  const alreadyCanceled = await Appointment.findById(id).lean();
  if (alreadyCanceled && alreadyCanceled.operationalStatus === 'canceled') {
    return {
      data: alreadyCanceled,
      message: 'Agendamento já estava cancelado.',
    };
  }

  const beforeSnapshot = alreadyCanceled;

  const result = await runTransactionWithRetry(async (session) => {
    return executeWithSession(id, { reason, confirmedAbsence }, user, session);
  });

  // Sincronizações pós-transação — await garantido, erro não falha a resposta
  try {
    await syncEvent(result, 'appointment');

    // 🔄 Atualiza PaymentsView para todos os payments vinculados ao appointment cancelado
    try {
      await handlePaymentEvent({
        type: 'APPOINTMENT_CANCELLED',
        payload: { appointmentId: result._id.toString() },
        timestamp: new Date().toISOString()
      });
    } catch (viewErr) {
      console.error('[cancelAppointmentCommand] Falha ao atualizar PaymentsView (non-fatal):', viewErr.message);
    }

    if (result.serviceType === 'package_session' && result.session) {
      await handlePackageSessionUpdate(
        result,
        'cancel',
        user,
        { changes: { reason, confirmedAbsence } }
      );

      // 🛡️ Rede de segurança síncrona: reconstrói a PackagesView já aqui,
      // sem depender do worker que consome o evento APPOINTMENT_CANCELLED
      // da Outbox (que pode estar desligado — ver ENABLE_WORKERS).
      const packageId = (result.package?._id || result.package)?.toString?.();
      if (packageId) {
        await syncAffectedViews({
          event: 'appointment.cancelled',
          packageId,
          correlationId: result.correlationId,
        });
      }
    } else if (result.session) {
      const sess = await Session.findById(result.session);
      if (sess) await syncEvent(sess, 'session');
    }
  } catch (error) {
    console.error('[cancelAppointmentCommand] Erro na sincronização pós-cancelamento:', error.message);
  }

  await recordAudit({
    user,
    action: 'appointment_canceled',
    entityType: 'Appointment',
    entityId: result._id,
    before: beforeSnapshot,
    after: result,
    source: 'appointment_command:cancelAppointmentCommand',
    correlationId: result.correlationId,
    metadata: { reason, confirmedAbsence },
  });

  try {
    await emitSocket('appointmentCanceled', {
      _id: result._id,
      appointmentId: result._id,
      patient: result.patient,
      doctor: result.doctor,
      date: result.date,
      time: result.time,
      operationalStatus: result.operationalStatus,
      source: 'crm_cancel',
    });
  } catch (socketErr) {
    console.error('[cancelAppointmentCommand] Erro ao emitir socket:', socketErr.message);
  }

  return {
    data: result,
    message: 'Agendamento cancelado. Dados preservados para reagendamento.',
  };
}

export default { execute, executeWithSession };
