import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import PatientBalance from '../models/PatientBalance.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import { consolidatePatientDebt } from './patientDebtItems.js';
import { LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS } from '../constants/financial.js';

const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

export function getRemainingPatientCredit(transactions = []) {
  return round(transactions.filter(t => t.type === 'credit' && !t.isDeleted
    && typeof t.correlationId === 'string' && t.correlationId.startsWith('receive_credit_'))
    .reduce((sum, t) => sum + Math.max(0, (Number(t.amount) || 0) - (Number(t.creditUsedAmount) || 0)), 0));
}

export function summarizePatientPending(payments, transactions = []) {
  const particular = payments.filter(p => p.status === 'pending'
    && !LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS.includes(p.kind)
    && !['convenio', 'insurance', 'liminar'].includes(p.billingType)
    && (!p.appointment || p.appointment.operationalStatus === 'completed'));
  const sum = items => round(items.reduce((total, p) => total + (Number(p.amount) || 0), 0));
  const totalPendingParticular = sum(particular);
  const availableCredit = getRemainingPatientCredit(transactions);
  const totalPendingParticularNet = round(Math.max(0, totalPendingParticular - availableCredit));
  const insurance = payments.filter(p => ['convenio', 'insurance'].includes(p.billingType)
    && !LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS.includes(p.kind));
  const totalPendingConvenioAwaitingBilling = sum(insurance.filter(p => p.status === 'pending'));
  const totalPendingConvenioBilled = sum(insurance.filter(p => p.status === 'billed'));
  return {
    payments: particular,
    receivablePayments: payments.filter(p => p.status === 'pending'
      && !LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS.includes(p.kind)
      && !['convenio', 'insurance', 'liminar'].includes(p.billingType)),
    stats: {
      totalPending: round(totalPendingParticular + totalPendingConvenioAwaitingBilling),
      totalPendingParticular,
      totalPendingParticularNet,
      availableCredit,
      appliedCredit: round(Math.min(availableCredit, totalPendingParticular)),
      netAvailableCredit: round(Math.max(0, availableCredit - totalPendingParticular)),
      totalPendingConvenioAwaitingBilling,
      totalPendingConvenioBilled,
      totalPendingNet: round(totalPendingParticularNet + totalPendingConvenioAwaitingBilling + totalPendingConvenioBilled),
    },
  };
}

// O perfil e a lista de débitos leem a mesma fonte atual, sem depender da projeção assíncrona.
export async function getPatientPendingSnapshot(patientId) {
  return (await getPatientPendingSnapshots([patientId])).get(String(patientId));
}

// Uma consulta por coleção para a página inteira, sem uma requisição por paciente.
export async function getPatientPendingSnapshots(patientIds) {
  const ids = [...new Set(patientIds.map(String))];
  if (!ids.length) return new Map();
  const oids = ids.map(id => new mongoose.Types.ObjectId(id));
  const keys = [...oids, ...ids];
  const [sessions, appointments, packages, balances] = await Promise.all([
    Session.find({ patient: { $in: keys } }).lean(),
    Appointment.find({ patient: { $in: keys } }).lean(),
    Package.find({ patient: { $in: keys } }).select('patient model status').lean(),
    PatientBalance.find({ patient: { $in: oids } }).select('patient transactions').lean(),
  ]);
  const payments = await
    Payment.find({
      $or: [{ patient: { $in: keys } }, { patientId: { $in: keys } },
        { session: { $in: sessions.flatMap(s => [s._id, String(s._id)]) } },
        { sessions: { $in: sessions.flatMap(s => [s._id, String(s._id)]) } },
        { advanceSessions: { $in: sessions.flatMap(s => [s._id, String(s._id)]) } },
        { appointment: { $in: appointments.map(a => a._id) } },
        { appointmentId: { $in: appointments.map(a => String(a._id)) } }],
    }).sort({ createdAt: -1 })
      .lean();
  const appointmentById = new Map(appointments.map(a => [String(a._id), a]));
  for (const payment of payments) {
    const appointmentId = payment.appointment?._id || payment.appointment || payment.appointmentId;
    const appointment = appointmentById.get(String(appointmentId));
    if (appointment) payment.appointment = appointment;
  }
  const grouped = new Map(ids.map(id => [id, []]));
  for (const payment of payments) {
    const linkedSession = sessions.find(s => String(s._id) === String(payment.session));
    const linkedAppointment = appointments.find(a => String(a._id) === String(payment.appointment?._id || payment.appointment || payment.appointmentId));
    const id = String(payment.patient || payment.patientId || linkedSession?.patient || linkedAppointment?.patient);
    grouped.get(id)?.push(payment);
  }
  const balanceByPatient = new Map(balances.map(b => [String(b.patient), b]));
  return new Map(ids.map(id => {
    const transactions = balanceByPatient.get(id)?.transactions || [];
    const patientPayments = grouped.get(id) || [];
    const snapshot = summarizePatientPending(patientPayments, transactions);
    const debt = consolidatePatientDebt({ payments: patientPayments, transactions,
      sessions: sessions.filter(s => String(s.patient) === id),
      appointments: appointments.filter(a => String(a.patient) === id),
      packages: packages.filter(p => String(p.patient) === id), pendingPayments: snapshot.payments });
    const net = round(Math.max(0, debt.total - snapshot.stats.availableCredit));
    snapshot.debtItems = debt.items;
    Object.assign(snapshot.stats, { totalPendingParticular: debt.total,
      totalPending: round(debt.total + snapshot.stats.totalPendingConvenioAwaitingBilling),
      totalPendingParticularNet: net, appliedCredit: round(Math.min(snapshot.stats.availableCredit, debt.total)),
      netAvailableCredit: round(Math.max(0, snapshot.stats.availableCredit - debt.total)),
      totalPendingNet: round(net + snapshot.stats.totalPendingConvenioAwaitingBilling + snapshot.stats.totalPendingConvenioBilled),
      collectibleCount: debt.collectibleCount, reviewCount: debt.reviewCount, reviewAmount: debt.reviewAmount });
    return [id, snapshot];
  }));
}
