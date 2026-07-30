// back/services/financialGuard/syncAppointmentPaymentStatus.js
/**
 * Sincroniza appointment.paymentStatus / isPaid quando o Payment vinculado muda
 * para um status terminal de não-pagamento (canceled/refunded).
 *
 * Regras de segurança:
 * - Nunca altera appointments de liminar/crédito judicial.
 * - Nunca altera appointments com pacote ativo (a origem financeira é o pacote).
 * - Nunca altera se existir outro Payment ativo (paid) para o mesmo appointment.
 * - Nunca altera se existir recebível de convênio ativo.
 * - operationalStatus = completed → SKIP (requer revisão manual, pois pode ter
 *   havido recebimento real por outro caminho).
 * - operationalStatus = canceled → paymentStatus = canceled, isPaid = false.
 * - operationalStatus em [scheduled, confirmed, pre_agendado, pending] →
 *   paymentStatus = pending, isPaid = false.
 *
 * Essa sincronização é side-effect: roda fora da transação principal do Payment,
 * seguindo o mesmo padrão do sync de paymentForms em routes/payment.v2.js.
 */

import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Package from '../../models/Package.js';

const PENDING_OP_STATUSES = ['scheduled', 'confirmed', 'pre_agendado', 'pending'];

function isLiminar(appointment) {
  return appointment.billingType === 'liminar' ||
    appointment.paymentMethod === 'liminar_credit' ||
    appointment.paymentOrigin === 'liminar_credit' ||
    !!appointment.liminarContract;
}

function resolveAppointmentId(payment) {
  if (payment.appointment) return payment.appointment.toString();
  if (payment.appointmentId) {
    const str = typeof payment.appointmentId === 'string'
      ? payment.appointmentId
      : payment.appointmentId.toString();
    if (mongoose.Types.ObjectId.isValid(str)) return str;
  }
  return null;
}

function determineTargetStatus(appointment) {
  if (appointment.operationalStatus === 'canceled') return 'canceled';
  if (PENDING_OP_STATUSES.includes(appointment.operationalStatus)) return 'pending';
  return null; // completed ou desconhecido → revisão manual
}

export async function syncAppointmentPaymentStatus(payment, options = {}) {
  const { reason = 'payment_status_sync', userId } = options;
  const appointmentId = resolveAppointmentId(payment);

  if (!appointmentId) {
    return { synced: false, reason: 'NO_APPOINTMENT_LINK' };
  }

  const appointment = await Appointment.findById(appointmentId).lean();
  if (!appointment) {
    return { synced: false, reason: 'APPOINTMENT_NOT_FOUND' };
  }

  // Proteção: liminar/crédito judicial
  if (isLiminar(appointment)) {
    return { synced: false, reason: 'LIMINAR_PROTECTED' };
  }

  // Proteção: pacote ativo é a origem financeira
  if (appointment.package) {
    const pkg = await Package.findById(appointment.package).select('status').lean();
    if (pkg && pkg.status !== 'canceled') {
      return { synced: false, reason: 'PACKAGE_PROTECTED' };
    }
  }

  // Proteção: existe outro Payment ativo (paid) para esse appointment?
  const activePaid = await Payment.findOne({
    $or: [
      { appointment: appointment._id },
      { appointmentId: appointmentId }
    ],
    status: 'paid',
    _id: { $ne: payment._id }
  }).select('_id').lean();

  if (activePaid) {
    return { synced: false, reason: 'OTHER_PAID_PAYMENT_EXISTS' };
  }

  // Proteção: existe recebível de convênio ativo?
  const activeConvenio = await Payment.findOne({
    $or: [
      { appointment: appointment._id },
      { appointmentId: appointmentId }
    ],
    billingType: 'convenio',
    status: { $in: ['pending', 'pending_billing', 'billed', 'received'] },
    _id: { $ne: payment._id }
  }).select('_id').lean();

  if (activeConvenio) {
    return { synced: false, reason: 'ACTIVE_CONVENIO_RECEIVABLE' };
  }

  const targetStatus = determineTargetStatus(appointment);
  if (!targetStatus) {
    return {
      synced: false,
      reason: 'REQUIRES_MANUAL_REVIEW',
      operationalStatus: appointment.operationalStatus
    };
  }

  // Só atualiza se realmente mudar algo
  if (appointment.paymentStatus === targetStatus && appointment.isPaid === false) {
    return { synced: false, reason: 'ALREADY_SYNCED' };
  }

  const update = {
    $set: {
      paymentStatus: targetStatus,
      isPaid: false,
      updatedAt: new Date()
    },
    $push: {
      history: {
        action: 'payment_status_sync',
        newStatus: targetStatus,
        changedBy: userId || null,
        timestamp: new Date(),
        context: 'financeiro',
        details: {
          reason,
          paymentId: payment._id.toString(),
          previousPaymentStatus: appointment.paymentStatus,
          previousIsPaid: appointment.isPaid
        }
      }
    }
  };

  await Appointment.findByIdAndUpdate(appointmentId, update);

  return {
    synced: true,
    appointmentId,
    previousPaymentStatus: appointment.paymentStatus,
    previousIsPaid: appointment.isPaid,
    newPaymentStatus: targetStatus,
    newIsPaid: false
  };
}

export default { syncAppointmentPaymentStatus };
