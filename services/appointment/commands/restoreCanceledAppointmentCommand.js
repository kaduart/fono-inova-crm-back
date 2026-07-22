// back/services/appointment/commands/restoreCanceledAppointmentCommand.js
/**
 * Restore Canceled Appointment Command
 *
 * Inverso simétrico de cancelAppointmentCommand.js — chamado quando um
 * appointment cancelado é reativado (volta pra scheduled/confirmed/pending).
 *
 * Responsabilidade: reconstruir Session, Package e Payment para o estado
 * anterior ao cancelamento, sem nunca reabrir silenciosamente pra `completed`
 * (a Session sempre volta pra `scheduled` — o Appointment nunca reativa
 * direto pra completed, ver guarda em updateAppointmentCommand.js).
 *
 * Sinais usados (nenhum campo novo no schema):
 * - `Session.completedAt` — o cancelamento nunca limpa esse campo, então um
 *   valor não-nulo prova que a sessão tinha sido completada antes de cancelar.
 *   Usado só para decidir se `Package.sessionsDone` volta a incrementar.
 * - `Session.original*` (originalPartialAmount/originalPaymentStatus/
 *   originalIsPaid/originalPaymentMethod) — gravados pelo cancelAppointmentCommand
 *   quando a sessão estava paga. Usado pra restaurar o estado financeiro da
 *   Session e decidir se Payment/Package.totalPaid voltam.
 *
 * Não mexe em Appointment — quem chama (updateAppointmentCommand.js) já
 * controla esse campo dentro da própria transação de reativação.
 */

import Session from '../../../models/Session.js';
import Payment from '../../../models/Payment.js';
import Package from '../../../models/Package.js';
import { consumePackageSession, updatePackageFinancials } from '../../../domain/package/consumePackageSession.js';

/**
 * @param {Object} appointment - Appointment já carregado e populado (session, payment, package),
 *   ainda com o operationalStatus ANTERIOR à reativação (ex: 'canceled').
 * @param {Object} params
 * @param {string} [params.reason] - Motivo da reativação
 * @param {Object} [user] - Usuário que disparou
 * @param {mongoose.ClientSession} session - Session MongoDB ativa (mesma transação do update)
 * @returns {Promise<{sessionRestored: boolean, wasCompleted: boolean, wasPaid: boolean}>}
 */
export async function executeWithSession(appointment, { reason } = {}, user, session) {
  let wasCompleted = false;
  let wasPaid = false;
  let sessionRestored = false;

  // 1. Restaura a Session vinculada
  if (appointment.session) {
    const sessionId = appointment.session._id || appointment.session;
    const sessionDoc = await Session.findById(sessionId).session(session);

    if (sessionDoc && sessionDoc.status === 'canceled') {
      wasCompleted = !!sessionDoc.completedAt;
      wasPaid = !!(
        sessionDoc.originalIsPaid ||
        sessionDoc.originalPaymentStatus === 'paid' ||
        (sessionDoc.originalPartialAmount && sessionDoc.originalPartialAmount > 0)
      );

      sessionDoc._inFinancialTransaction = true;

      // Nunca reabre direto pra 'completed' — reativação sempre pousa em
      // 'scheduled', espelhando o Appointment (que só pode reativar pra
      // scheduled/confirmed/pending).
      sessionDoc.status = 'scheduled';
      sessionDoc.confirmedAbsence = false;
      sessionDoc.canceledAt = null;

      // 🚧 NÃO seta sessionDoc.paymentStatus aqui — syncSessionFromAppointment
      // (chamado logo depois por updateAppointmentCommand.js) sobrescreve
      // Session.paymentStatus com Appointment.paymentStatus ("Appointment manda,
      // Session segue"). Quem decide o paymentStatus correto pro caso "estava
      // pago" é a própria updateAppointmentCommand.js, usando os mesmos sinais
      // (session.original*) antes de montar updateData.paymentStatus.
      if (wasPaid) {
        sessionDoc.isPaid = sessionDoc.originalIsPaid;
        sessionDoc.paymentMethod = sessionDoc.originalPaymentMethod || sessionDoc.paymentMethod;
        sessionDoc.partialAmount = sessionDoc.originalPartialAmount || 0;
        sessionDoc.visualFlag = 'ok';

        // Limpa os campos 'original*' — já foram consumidos na restauração,
        // não podem ser reaproveitados de novo num cancelamento futuro.
        sessionDoc.originalPartialAmount = 0;
        sessionDoc.originalPaymentStatus = null;
        sessionDoc.originalIsPaid = false;
        sessionDoc.originalPaymentMethod = null;
      } else {
        sessionDoc.isPaid = false;
        sessionDoc.visualFlag = 'pending';
      }

      if (!sessionDoc.history) sessionDoc.history = [];
      sessionDoc.history.push({
        action: 'reativacao_via_agendamento',
        changedBy: user?._id,
        timestamp: new Date(),
        details: { reason, wasCompleted, wasPaid },
      });

      await sessionDoc.save({ session, validateBeforeSave: false });
      sessionRestored = true;
    }
  }

  // 2. Restaura o Package (só sessão de pacote)
  if (appointment.serviceType === 'package_session' && appointment.package) {
    const packageId = appointment.package._id || appointment.package;

    // sessionsDone só volta se a sessão tinha sido completada antes do cancel
    // (guard simétrico ao de restorePackageOnCancel — nunca ultrapassa totalSessions).
    if (wasCompleted) {
      await consumePackageSession(packageId, { mongoSession: session });
    }

    // totalPaid/paidSessions só voltam se era per-session E estava pago
    // (pacote pré-pago nunca teve isso mexido no cancelamento — nada a restaurar aqui).
    if (wasPaid && appointment.paymentOrigin === 'auto_per_session' && appointment.sessionValue > 0) {
      await updatePackageFinancials(packageId, appointment.sessionValue, session);
    }

    // Readiciona nos arrays — inverso do $pull do cancelAppointmentCommand.
    await Package.findByIdAndUpdate(
      packageId,
      {
        $addToSet: {
          sessions: appointment.session?._id || appointment.session,
          appointments: appointment._id,
        },
        $set: { updatedAt: new Date() },
      },
      { session }
    );
  }

  // 3. Restaura o Payment vinculado (nunca mexe em package_receipt — mesma
  // exceção do cancelamento; o recibo de compra do pacote nunca foi cancelado).
  if (appointment.payment) {
    const paymentId = appointment.payment._id || appointment.payment;
    const pay = await Payment.findById(paymentId).session(session);

    if (pay && pay.status === 'canceled' && pay.kind !== 'package_receipt') {
      // Volta pra 'pending', não 'paid' — não há como saber com certeza que o
      // dinheiro já está com a clínica de novo; provisioning correto é pending,
      // igual a um agendamento novo. Evita inflar receita silenciosamente.
      await Payment.findByIdAndUpdate(
        paymentId,
        {
          $set: {
            status: 'pending',
            canceledAt: null,
            canceledReason: null,
            updatedAt: new Date(),
          },
        },
        { session }
      );
    }
  }

  return { sessionRestored, wasCompleted, wasPaid };
}

export default { executeWithSession };
