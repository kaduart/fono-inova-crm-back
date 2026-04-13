// services/financialGuard/guards/particular.guard.js
// 💵 Guard para regras financeiras de PARTICULAR (per-session)

import Payment from '../../../models/Payment.js';

/**
 * Particular Guard - Regras financeiras de particular
 * 
 * Contextos suportados:
 * - CANCEL_APPOINTMENT: Cancela payment ao cancelar agendamento
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
      console.warn(`[ParticularGuard] Payment ${paymentId} não encontrado`);
      return { handled: false, reason: 'PAYMENT_NOT_FOUND' };
    }

    // 🛡️ Idempotência
    if (payment.status === 'canceled') {
      console.log(`[ParticularGuard] Payment ${paymentId} já cancelado`);
      return { handled: true, alreadyCanceled: true, paymentId };
    }

    // 🛡️ REGRA SAGRADA: NÃO cancela payment de pacote
    // (esse guard é só para particular, mas double-check não machuca)
    if (payment.kind === 'package_receipt' || payment.kind === 'session_payment') {
      console.log(`[ParticularGuard] Payment ${paymentId} é de pacote - preservado`, {
        kind: payment.kind
      });
      return { 
        handled: false, 
        reason: 'PACKAGE_PAYMENT_PRESERVED',
        kind: payment.kind 
      };
    }

    // Cancela payment
    payment.status = 'canceled';
    payment.canceledAt = new Date();
    payment.canceledReason = reason;
    payment.updatedAt = new Date();

    await payment.save({ session });

    console.log(`[ParticularGuard] Payment ${paymentId} cancelado`, {
      amount: payment.amount,
      reason
    });

    return {
      handled: true,
      paymentId: payment._id.toString(),
      amount: payment.amount,
      status: 'canceled'
    };
  }
};
