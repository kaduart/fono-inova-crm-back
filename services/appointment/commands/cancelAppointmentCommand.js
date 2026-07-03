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
import { buildError } from './_helpers.js';
import { recordAudit } from '../../auditLogService.js';

/**
 * Core do cancelamento executado dentro de uma session MongoDB existente.
 * Pode ser reusado por outros commands/guards que já gerenciam a transação.
 *
 * @param {string|ObjectId} id - ID do Appointment
 * @param {Object} params
 * @param {string} params.reason - Motivo do cancelamento
 * @param {boolean} [params.confirmedAbsence=false] - Falta confirmada
 * @param {Object} [user] - Usuário que disparou
 * @param {mongoose.ClientSession} session - Session MongoDB ativa
 * @returns {Promise<Appointment>} Appointment atualizado
 */
export async function executeWithSession(id, { reason, confirmedAbsence = false }, user, session) {
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

  // Cancelar Payment quando aplicável
  if (appointment.payment) {
    const pay = await Payment.findById(appointment.payment).session(session);
    if (pay && pay.status !== 'canceled') {
      // Cancela pagamentos avulsos e outros, exceto recibos de pacote já quitados
      const shouldCancel = pay.kind !== 'package_receipt';
      if (shouldCancel) {
        await Payment.findByIdAndUpdate(
          appointment.payment,
          {
            $set: {
              status: 'canceled',
              canceledAt: new Date(),
              canceledReason: reason,
              updatedAt: new Date(),
            },
          },
          { session }
        );
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
    await Package.findByIdAndUpdate(
      appointment.package,
      {
        $inc: { sessionsDone: -1 },
        $pull: { sessions: appointment._id, appointments: appointment._id },
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
          details: { reason, confirmedAbsence },
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

    if (result.serviceType === 'package_session' && result.session) {
      await handlePackageSessionUpdate(
        result,
        'cancel',
        user,
        { changes: { reason, confirmedAbsence } }
      );
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

  return {
    data: result,
    message: 'Agendamento cancelado. Dados preservados para reagendamento.',
  };
}

export default { execute, executeWithSession };
