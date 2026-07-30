// domain/payment/PaymentLifecycleService.js
// 🔄 Centraliza mutações de ciclo de vida do Payment.
//
// REGRA: este serviço NÃO escreve em Appointment. O schema de Appointment
// armazena `payment` como ObjectId (ref: Payment), e não como sub-documento.
// Qualquer sincronização de `appointment.paymentStatus` / `appointment.isPaid`
// deve ser feita pelo fluxo de cancelamento/complete do appointment
// (cancelAppointmentCommand, completeSessionService.v2 etc.), nunca aqui.
//
// Motivo: escrever `payment.status` em Appointment transforma o campo ObjectId
// em sub-documento, quebrando leituras, populates e validações do schema.

import Payment from '../../models/Payment.js';
import { transitionPaymentStatus } from '../../services/paymentStatusService.js';
import { invalidateCacheForPayment } from '../../services/dailyClosingCacheService.js';
import { invalidateDashboardCache } from '../../routes/financialDashboard.v2.js';

/**
 * Cancela um Payment de forma centralizada.
 *
 * @param {string|ObjectId} paymentId
 * @param {Object} options
 * @param {string} [options.reason='manual'] - motivo do cancelamento
 * @param {string} [options.userId] - usuário que executou
 * @param {mongoose.ClientSession} [options.mongoSession]
 * @returns {Promise<{canceled: boolean, payment?: Payment, reason?: string}>}
 */
export async function cancelPayment(paymentId, options = {}) {
  const {
    reason = 'manual',
    userId,
    mongoSession,
  } = options;

  if (!paymentId) {
    return { canceled: false, reason: 'NO_PAYMENT_ID' };
  }

  const query = Payment.findById(paymentId);
  if (mongoSession) query.session(mongoSession);
  const payment = await query;

  if (!payment) {
    return { canceled: false, reason: 'PAYMENT_NOT_FOUND' };
  }

  if (payment.status === 'canceled' || payment.status === 'refunded') {
    return { canceled: false, alreadyCanceled: true, payment };
  }

  const { payment: updatedPayment } = await transitionPaymentStatus(
    payment._id,
    'canceled',
    {
      session: mongoSession,
      reason: reason || 'manual_cancel',
      userId,
    }
  );

  updatedPayment.canceledAt = new Date();
  updatedPayment.canceledReason = reason;
  updatedPayment.updatedAt = new Date();

  const saveOptions = mongoSession ? { session: mongoSession } : {};
  await updatedPayment.save(saveOptions);

  try {
    await invalidateCacheForPayment(updatedPayment);
  } catch (cacheErr) {
    console.warn('[PaymentLifecycleService] Falha ao invalidar cache de caixa:', cacheErr.message);
  }

  try {
    invalidateDashboardCache();
  } catch (cacheErr) {
    console.warn('[PaymentLifecycleService] Falha ao invalidar cache do dashboard:', cacheErr.message);
  }

  console.log(`[PaymentLifecycleService] Payment ${paymentId} cancelado`, { reason });

  return {
    canceled: true,
    paymentId: updatedPayment._id,
    payment: updatedPayment,
  };
}

/**
 * Refunda um Payment de forma centralizada.
 * Atualmente delega para cancelado com reason de refund; pode evoluir para
 * status='refunded' quando houver distinção de negócio.
 */
export async function refundPayment(paymentId, options = {}) {
  return cancelPayment(paymentId, {
    ...options,
    reason: options.reason || 'refund',
  });
}

export default {
  cancelPayment,
  refundPayment,
};
