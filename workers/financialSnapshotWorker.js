/**
 * 💰 Financial Snapshot Worker — V2 PURO
 *
 * Princípio: ZERO aggregate em runtime.
 * Todo evento financeiro incrementa/atualiza o snapshot diário.
 *
 * Eventos suportados:
 * - PAYMENT_PROCESS_REQUESTED  → produced + countPending
 * - PAYMENT_COMPLETED          → received + countPaid
 * - PAYMENT_PARTIAL            → received + countPartial
 * - PAYMENT_FAILED/CANCELLED   → compensação (decrementa produced/pending)
 * - SESSION_COMPLETED          → production (convenio/particular)
 * - APPOINTMENT_CONFIRMED      → scheduled
 * - APPOINTMENT_PENDING        → pending
 * - APPOINTMENT_CANCELLED      → compensação scheduled/pending
 */

import FinancialDailySnapshot from '../models/FinancialDailySnapshot.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger(null, 'FinancialSnapshotWorker');

const toDateStr = (d) => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().split('T')[0];
};

const methodMap = {
  dinheiro: 'cash',
  pix: 'pix',
  credit_card: 'credit_card',
  debit_card: 'debit_card',
  cartao: 'credit_card',
  'cartão': 'credit_card',
  transferencia: 'bank_transfer',
  'transferência': 'bank_transfer',
  cash: 'cash',
  bank_transfer: 'bank_transfer',
  insurance: 'insurance',
  convenio: 'insurance',
  particular: 'cash',
};

function normalizeMethod(method) {
  return methodMap[method] || 'unknown';
}

function normalizeCategory(category) {
  const map = {
    session_payment: 'session',
    package_receipt: 'package',
    avulso: 'avulso',
    expense: 'expense',
    appointment_payment: 'session',
    standalone: 'avulso',
    multi_payment: 'session',
  };
  return map[category] || 'unknown';
}

async function updateSnapshot({ date, clinicId = 'default', eventId = null }, ops) {
  const dateStr = toDateStr(date);
  if (!dateStr) return;

  // 🛡️ Idempotência: se eventId já foi processado, ignora
  if (eventId) {
    const exists = await FinancialDailySnapshot.findOne(
      { date: dateStr, clinicId, processedEvents: eventId },
      { _id: 1 }
    ).lean();
    if (exists) {
      log.info('snapshot_event_already_processed', 'Evento já aplicado no snapshot', { dateStr, clinicId, eventId });
      return;
    }
  }

  const update = {
    $set: { updatedAt: new Date(), lastEventAt: new Date() },
  };

  if (ops.$inc && Object.keys(ops.$inc).length) {
    update.$inc = ops.$inc;
  }
  if (ops.$set && Object.keys(ops.$set).length) {
    Object.assign(update.$set, ops.$set);
  }
  if (eventId) {
    update.$addToSet = { processedEvents: eventId };
  }

  try {
    await FinancialDailySnapshot.findOneAndUpdate(
      { date: dateStr, clinicId },
      update,
      { upsert: true, new: true }
    );
  } catch (err) {
    log.error('snapshot_update_failed', err.message, { date: dateStr, clinicId, eventId, ops });
  }
}

// ─── PAYMENT EVENTS ─────────────────────────────────────────────────────────

export async function onPaymentRequested(payload) {
  // produced é registrado na data de criação do payment (paymentDate ou hoje)
  const dateStr = payload.paymentDate || toDateStr(new Date());
  const amount = Number(payload.amount) || 0;
  const method = normalizeMethod(payload.paymentMethod);
  const category = normalizeCategory(payload.category || payload.type);

  await updateSnapshot(
    { date: dateStr, clinicId: payload.clinicId || 'default', eventId: payload.eventId || payload._id || `req_${Date.now()}` },
    {
      $inc: {
        'payments.produced': amount,
        'payments.count': 1,
        'payments.countPending': 1,
        [`payments.byMethod.${method}`]: amount,
        [`payments.byCategory.${category}`]: amount,
      },
    }
  );
}

export async function onPaymentCompleted(payload) {
  const payment = await Payment.findById(payload.paymentId || payload._id)
    .select('paymentDate billingType insurance.receivedAmount amount paymentMethod category status')
    .lean();

  if (!payment) return;

  const dateStr = payment.paymentDate || toDateStr(new Date());
  const amount = Number(payment.amount) || 0;
  const received = Number(payment.insurance?.receivedAmount || payment.amount) || 0;
  const method = normalizeMethod(payment.paymentMethod);

  const inc = {
    'payments.received': received,
    'payments.countPaid': 1,
    [`payments.byMethod.${method}`]: received,
  };

  // Se antes estava pending, compensa
  if (payment.status === 'pending') {
    inc['payments.countPending'] = -1;
  }

  await updateSnapshot(
    { date: dateStr, clinicId: payload.clinicId || 'default', eventId: payload.eventId || payload._id || `comp_${Date.now()}` },
    { $inc: inc }
  );
}

export async function onPaymentPartial(payload) {
  const payment = await Payment.findById(payload.paymentId || payload._id)
    .select('paymentDate amount insurance.receivedAmount paymentMethod status')
    .lean();

  if (!payment) return;

  const dateStr = payment.paymentDate || toDateStr(new Date());
  const received = Number(payment.insurance?.receivedAmount || 0);
  const method = normalizeMethod(payment.paymentMethod);

  const inc = {
    'payments.received': received,
    'payments.countPartial': 1,
    [`payments.byMethod.${method}`]: received,
  };

  if (payment.status === 'pending') {
    inc['payments.countPending'] = -1;
  }

  await updateSnapshot(
    { date: dateStr, clinicId: payload.clinicId || 'default', eventId: payload.eventId || payload._id || `part_${Date.now()}` },
    { $inc: inc }
  );
}

export async function onPaymentFailedOrCancelled(payload) {
  const payment = await Payment.findById(payload.paymentId || payload._id)
    .select('paymentDate amount status')
    .lean();

  if (!payment) return;

  const dateStr = payment.paymentDate || toDateStr(new Date());
  const amount = Number(payment.amount) || 0;

  await updateSnapshot(
    { date: dateStr, clinicId: payload.clinicId || 'default', eventId: payload.eventId || payload._id || `fail_${Date.now()}` },
    {
      $inc: {
        'payments.produced': -amount,
        'payments.count': -1,
        'payments.countPending': payment.status === 'pending' ? -1 : 0,
      },
    }
  );
}

// ─── SESSION EVENTS ─────────────────────────────────────────────────────────

export async function onSessionCompleted(payload) {
  const session = await Session.findById(payload.sessionId || payload._id)
    .select('date sessionValue paymentMethod package status')
    .lean();

  if (!session || session.status !== 'completed') return;

  const dateStr = toDateStr(session.date);
  if (!dateStr) return;

  const value = session.sessionValue || 0;
  const method = session.paymentMethod || 'unknown';

  const inc = {
    'production.total': value,
    'production.count': 1,
  };

  if (method === 'convenio') {
    inc['production.byPaymentMethod.convenio.total'] = value;
    inc['production.byPaymentMethod.convenio.count'] = 1;
    inc['convenio.atendido.total'] = value;
    inc['convenio.atendido.count'] = 1;
  } else if (method === 'particular') {
    inc['production.byPaymentMethod.particular.total'] = value;
    inc['production.byPaymentMethod.particular.count'] = 1;
  } else if (method === 'pix') {
    inc['production.byPaymentMethod.pix.total'] = value;
    inc['production.byPaymentMethod.pix.count'] = 1;
  } else if (method === 'credit_card') {
    inc['production.byPaymentMethod.credit_card.total'] = value;
    inc['production.byPaymentMethod.credit_card.count'] = 1;
  }

  await updateSnapshot({ date: dateStr, clinicId: payload.clinicId || 'default' }, { $inc: inc });
}

// ─── APPOINTMENT EVENTS ─────────────────────────────────────────────────────

export async function onAppointmentConfirmed(payload) {
  const appointment = await Appointment.findById(payload.appointmentId || payload._id)
    .select('date sessionValue package paymentMethod operationalStatus clinicalStatus')
    .lean();

  if (!appointment) return;
  if (!['confirmed', 'scheduled'].includes(appointment.operationalStatus)) return;
  if (['completed', 'cancelled'].includes(appointment.clinicalStatus)) return;

  const dateStr = toDateStr(appointment.date);
  if (!dateStr) return;

  const value = appointment.sessionValue || 0;
  const isAvulso = !appointment.package;
  const isConvenio = appointment.paymentMethod === 'convenio';

  const inc = {
    'scheduled.total': value,
    'scheduled.count': 1,
  };

  if (isAvulso) {
    inc['scheduled.avulso.total'] = value;
    inc['scheduled.avulso.count'] = 1;
  }
  if (isConvenio) {
    inc['scheduled.convenio.total'] = value;
    inc['scheduled.convenio.count'] = 1;
  }

  await updateSnapshot({ date: dateStr, clinicId: payload.clinicId || 'default' }, { $inc: inc });
}

export async function onAppointmentPending(payload) {
  const appointment = await Appointment.findById(payload.appointmentId || payload._id)
    .select('date sessionValue operationalStatus clinicalStatus')
    .lean();

  if (!appointment || appointment.operationalStatus !== 'pending' || appointment.clinicalStatus === 'completed') return;

  const dateStr = toDateStr(appointment.date);
  if (!dateStr) return;

  await updateSnapshot(
    { date: dateStr, clinicId: payload.clinicId || 'default', eventId: payload.eventId || payload._id || `pend_${appointment._id}` },
    { $inc: { 'pending.total': appointment.sessionValue || 0, 'pending.count': 1 } }
  );
}

export async function onAppointmentCancelled(payload) {
  const dateStr = toDateStr(payload.date);
  if (!dateStr) return;

  await updateSnapshot(
    { date: dateStr, clinicId: payload.clinicId || 'default', eventId: payload.eventId || payload._id || `cncl_${Date.now()}` },
    { $inc: { 'scheduled.count': -1, 'pending.count': -1 } }
  );
}

// ─── ROUTER / ENTRYPOINT ────────────────────────────────────────────────────

export async function processFinancialEvent(eventType, payload) {
  switch (eventType) {
    case 'PAYMENT_PROCESS_REQUESTED':
    case 'PAYMENT_REQUESTED':
      return onPaymentRequested(payload);
    case 'PAYMENT_COMPLETED':
      return onPaymentCompleted(payload);
    case 'PAYMENT_PARTIAL':
      return onPaymentPartial(payload);
    case 'PAYMENT_FAILED':
    case 'PAYMENT_CANCELLED':
      return onPaymentFailedOrCancelled(payload);
    case 'SESSION_COMPLETED':
      return onSessionCompleted(payload);
    case 'APPOINTMENT_CONFIRMED':
    case 'APPOINTMENT_SCHEDULED':
      return onAppointmentConfirmed(payload);
    case 'APPOINTMENT_PENDING':
      return onAppointmentPending(payload);
    case 'APPOINTMENT_CANCELLED':
      return onAppointmentCancelled(payload);
    default:
      return;
  }
}

export default { processFinancialEvent };
