// services/financialGuard/guards/settle.guard.js
// 💵 Guard para regras de QUITAÇÃO (SETTLE) — cross-billingType

import Payment from '../../../models/Payment.js';
import Appointment from '../../../models/Appointment.js';
import FinancialGuardError from '../FinancialGuardError.js';

const ALLOWED_BILLING_TYPES_FOR_SETTLE = ['particular'];

/**
 * Settle Guard - Valida se um payment pode ser quitado manualmente
 *
 * Contextos suportados:
 * - SETTLE_PAYMENT: valida se o payment permite quitação manual
 */
export default {
  async handle({ context, payload, session }) {
    if (context !== 'SETTLE_PAYMENT') {
      return { handled: false, reason: 'CONTEXT_NOT_SUPPORTED' };
    }

    const { paymentIds, payment, packageId } = payload;

    // Se recebeu paymentIds (array), valida todos
    if (paymentIds && Array.isArray(paymentIds)) {
      const payments = await Payment.find({
        _id: { $in: paymentIds }
      }).session(session);

      if (!payments.length) {
        throw new FinancialGuardError('NO_PAYMENTS_FOUND', { paymentIds });
      }

      for (const p of payments) {
        // 1. Valida billingType
        const bt = p.billingType ?? 'particular';
        validateBillingTypeForSettle(bt, p._id.toString());

        // 2. Valida vínculo com pacote (se packageId fornecido)
        if (packageId) {
          await validatePackageLink(p, packageId);
        }
      }

      return {
        handled: true,
        validatedCount: payments.length,
        context: 'SETTLE_PAYMENT'
      };
    }

    // Se recebeu um único payment
    if (payment) {
      const bt = payment.billingType ?? 'particular';
      validateBillingTypeForSettle(bt, payment._id?.toString?.() || 'unknown');

      if (packageId) {
        await validatePackageLink(payment, packageId);
      }

      return {
        handled: true,
        validatedCount: 1,
        context: 'SETTLE_PAYMENT'
      };
    }

    throw new FinancialGuardError('NO_PAYMENT_DATA');
  }
};

async function validatePackageLink(payment, packageId) {
  if (payment.package && payment.package.toString() !== packageId) {
    throw new FinancialGuardError('PAYMENT_PACKAGE_MISMATCH', {
      paymentId: payment._id.toString(),
      paymentPackageId: payment.package.toString(),
      expectedPackageId: packageId
    });
  }

  if (payment.appointment) {
    const appt = await Appointment.findById(payment.appointment).lean();
    if (appt && appt.package && appt.package.toString() !== packageId) {
      throw new FinancialGuardError('APPOINTMENT_PACKAGE_MISMATCH', {
        paymentId: payment._id.toString(),
        appointmentId: appt._id.toString(),
        appointmentPackageId: appt.package.toString(),
        expectedPackageId: packageId
      });
    }
  }
}

function validateBillingTypeForSettle(billingType, paymentId) {
  if (billingType === 'particular') {
    return true;
  }

  const errors = {
    convenio: `Payment ${paymentId} é convênio. Use fluxo de faturamento (BILLING_ONLY).`,
    insurance: `Payment ${paymentId} é insurance. Use fluxo de faturamento (BILLING_ONLY).`,
    liminar: `Payment ${paymentId} é liminar. Não existe quitação manual — consome crédito judicial.`,
  };

  const error = errors[billingType] || `Payment ${paymentId} tem billingType='${billingType}' inválido para quitação.`;

  throw new FinancialGuardError('PAYMENT_FLOW_BLOCKED', {
    billingType,
    paymentId,
    reason: error
  });
}
