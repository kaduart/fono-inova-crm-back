// services/financialGuard/guards/convenio.guard.js
// 🏥 Guard para regras financeiras de CONVÊNIO

import Payment from '../../../models/Payment.js';
import { transitionPaymentStatus } from '../../../services/paymentStatusService.js';

/**
 * Convênio Guard - Regras financeiras de convênio
 *
 * Contextos suportados:
 * - CANCEL_APPOINTMENT: Cancela payment pending ao cancelar agendamento de convênio
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

    const { payment: updatedPayment } = await transitionPaymentStatus(payment._id, 'canceled', {
      session,
      reason: reason || 'convenio_cancel'
    });

    updatedPayment.canceledAt = new Date();
    updatedPayment.canceledReason = reason;
    await updatedPayment.save({ session });

    console.log(`[ConvenioGuard] Payment ${paymentId} cancelado`, { amount: payment.amount, reason });

    return {
      handled: true,
      paymentId: payment._id.toString(),
      amount: payment.amount,
      status: 'canceled'
    };
  }
};
