// services/financialGuard/guards/convenio.guard.js
// 🏥 Guard para regras financeiras de CONVÊNIO

import Payment from '../../../models/Payment.js';
import Session from '../../../models/Session.js';
import InsuranceGuide from '../../../models/InsuranceGuide.js';
import PaymentLifecycleService from '../../../domain/payment/PaymentLifecycleService.js';

/**
 * Convênio Guard - Regras financeiras de convênio
 *
 * Contextos suportados:
 * - CANCEL_APPOINTMENT: Cancela payment pending ao cancelar agendamento de convênio
 *                        e reverte session.completed + guia consumida
 */
export default {
  async handle({ context, payload, session }) {
    if (context !== 'CANCEL_APPOINTMENT') {
      return { handled: false, reason: 'CONTEXT_NOT_SUPPORTED' };
    }

    const { paymentId, reason = '' } = payload;

    if (!paymentId) {
      return { handled: false, reason: 'NO_PAYMENT_ID' };
    }

    const payment = await Payment.findById(paymentId).session(session);

    if (!payment) {
      console.warn(`[ConvenioGuard] Payment ${paymentId} não encontrado`);
      return { handled: false, reason: 'PAYMENT_NOT_FOUND' };
    }

    // 🛡️ Idempotência
    if (payment.status === 'canceled') {
      console.log(`[ConvenioGuard] Payment ${paymentId} já cancelado`);
      return { handled: true, alreadyCanceled: true, paymentId };
    }

    // Cancela payment via lifecycle centralizado (sincroniza Appointment)
    const result = await PaymentLifecycleService.cancelPayment(paymentId, {
      reason: reason || 'convenio_cancel',
      mongoSession: session,
    });

    if (!result.canceled) {
      return {
        handled: false,
        reason: result.reason || 'CANCEL_FAILED',
        paymentId
      };
    }

    console.log(`[ConvenioGuard] Payment ${paymentId} cancelado`, { amount: payment.amount, reason });

    // 🔄 SIMETRIA: reverter session completed e guia consumida
    const revertedSession = await revertSessionAndGuide(payment, { session, reason });

    return {
      handled: true,
      paymentId: payment._id.toString(),
      amount: payment.amount,
      status: 'canceled',
      sessionReverted: revertedSession
    };
  }
};

async function revertSessionAndGuide(payment, { session, reason }) {
  if (!payment.session) return false;

  const sessionDoc = await Session.findById(payment.session).session(session);
  if (!sessionDoc) return false;

  // Só reverte se estiver completed; outros estados são mantidos
  if (sessionDoc.status !== 'completed') {
    return false;
  }

  sessionDoc.status = 'canceled';
  sessionDoc.canceledAt = new Date();
  sessionDoc.cancelReason = reason || 'convenio_cancel';
  sessionDoc.paymentId = null;
  sessionDoc.guideConsumed = false;
  sessionDoc.isPaid = false;
  sessionDoc.paymentStatus = 'pending';
  sessionDoc.visualFlag = 'pending';

  await sessionDoc.save({ session });
  console.log(`[ConvenioGuard] Session ${sessionDoc._id} revertida de completed → canceled`);

  // Restaurar guia
  if (sessionDoc.insuranceGuide) {
    // $inc + $pull atômicos: decrementa contador e remove entrada do audit trail
    // em uma única operação, prevenindo divergência entre as duas estruturas.
    // Floor guard { usedSessions: $gt: 0 } previne contador negativo.
    const restoredGuide = await InsuranceGuide.findOneAndUpdate(
      { _id: sessionDoc.insuranceGuide, usedSessions: { $gt: 0 } },
      {
        $inc:  { usedSessions: -1 },
        $pull: { consumptionHistory: { sessionId: sessionDoc._id } },
      },
      { session, new: true }
    );

    if (!restoredGuide) {
      console.warn(`[ConvenioGuard] Guia ${sessionDoc.insuranceGuide} não restaurada (usedSessions já era 0 ou guia não encontrada)`);
      return true;
    }

    console.log(`[ConvenioGuard] Guia ${restoredGuide._id} restaurada (usedSessions ${restoredGuide.usedSessions + 1} → ${restoredGuide.usedSessions})`);

    // Reativação: findByIdAndUpdate não dispara pre-save hooks — status permaneceria
    // 'exhausted' após $inc mesmo com sessões disponíveis. Corrige explicitamente.
    if (restoredGuide.status === 'exhausted' && restoredGuide.usedSessions < restoredGuide.totalSessions) {
      await InsuranceGuide.findByIdAndUpdate(
        restoredGuide._id,
        { $set: { status: 'active' } },
        { session }
      );
      console.log(`[ConvenioGuard] Guia ${restoredGuide._id} reativada: exhausted → active`);
    }
  }

  return true;
}
