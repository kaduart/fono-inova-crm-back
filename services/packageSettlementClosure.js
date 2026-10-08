import { cancelAppointments } from '../domain/appointment/cancelAppointments.js';
import { cancelPendingSessions } from '../domain/session/cancelPendingSessions.js';
import { cancelPendingPayments } from '../domain/payment/cancelPendingPayments.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import Session from '../models/Session.js';

const OPEN_STATUSES = ['pre_agendado', 'scheduled', 'confirmed', 'pending'];
const idOf = value => String(value?._id || value);

export function planSettledPackageClosure(pkg, appointments, payments) {
  if (pkg.settlementClosure?.closedAt) return null;
  const completed = appointments.filter(a => a.operationalStatus === 'completed');
  if (!completed.length) return null;
  if (appointments.some(a => !['completed', 'canceled', ...OPEN_STATUSES].includes(a.operationalStatus))) return null;
  const appointmentForPayment = payment => appointments.find(a =>
    (payment.appointment && idOf(payment.appointment) === idOf(a._id)) ||
    (!payment.appointment && payment.session && a.session && idOf(payment.session) === idOf(a.session)));
  for (const appointment of completed) {
    const linked = payments.filter(p => appointmentForPayment(p) === appointment && !['canceled', 'refunded'].includes(p.status));
    // Ausência de pagamento ou baixa parcial não comprova quitação.
    if (!linked.length || linked.some(p => p.status !== 'paid')) return null;
  }
  const remaining = appointments.filter(a => OPEN_STATUSES.includes(a.operationalStatus));
  const appointmentIds = remaining.map(a => a._id);
  const remainingIds = new Set(appointmentIds.map(idOf));
  if (payments.some(p => remainingIds.has(idOf(appointmentForPayment(p)?._id)) && !['pending', 'scheduled', 'canceled'].includes(p.status))) return null;
  if (payments.some(p => !appointmentForPayment(p) && !['canceled', 'refunded'].includes(p.status))) return null;
  const completedIds = new Set(completed.map(a => idOf(a._id)));
  const billableValue = Math.round(payments.filter(p => p.status === 'paid' && completedIds.has(idOf(appointmentForPayment(p)?._id)))
    .reduce((sum, p) => sum + Number(p.amount || 0), Number(pkg.fundedByTransfer || 0)) * 100) / 100;
  return { appointmentIds, billableValue };
}

export async function applySettledPackageClosure(pkg, plan, mongoSession) {
  if (!mongoSession) throw new Error('Encerramento de pacote exige transação');
  const sessions = plan.appointmentIds.length ? await Session.find({ appointmentId: { $in: plan.appointmentIds } })
    .select('_id').session(mongoSession).lean() : [];
  const filter = { _id: { $in: plan.appointmentIds }, operationalStatus: { $in: OPEN_STATUSES } };
  await cancelPendingSessions({ appointmentId: { $in: plan.appointmentIds }, status: { $nin: ['completed', 'canceled'] } }, mongoSession);
  await cancelAppointments(filter, mongoSession);
  await cancelPendingPayments({ $or: [{ appointment: { $in: plan.appointmentIds } }, { session: { $in: sessions.map(s => s._id) } }],
    status: { $in: ['pending', 'scheduled'] } }, mongoSession);
  const closure = { closedAt: new Date(), reason: 'performed_sessions_settled',
    contractValue: pkg.totalValue, billableValue: plan.billableValue, canceledAppointmentIds: plan.appointmentIds };
  await saveToOutbox({ eventType: 'PACKAGE_UPDATED', aggregateType: 'Package', aggregateId: pkg._id,
    payload: { packageId: idOf(pkg._id), patientId: idOf(pkg.patient), reason: closure.reason } }, mongoSession);
  for (const appointmentId of plan.appointmentIds) {
    await saveToOutbox({ eventType: 'APPOINTMENT_CANCELLED', aggregateType: 'Appointment', aggregateId: appointmentId,
      payload: { appointmentId: idOf(appointmentId), packageId: idOf(pkg._id), patientId: idOf(pkg.patient), reason: closure.reason } }, mongoSession);
  }
  return closure;
}
