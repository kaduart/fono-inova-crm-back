import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import PatientBalance from '../models/PatientBalance.js';
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
  const [payments, balances] = await Promise.all([
    Payment.find({
      $or: [{ patient: { $in: keys } }, { patientId: { $in: keys } }],
      status: { $in: ['pending', 'billed'] },
      kind: { $nin: LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS },
    }).sort({ createdAt: -1 })
      .populate('appointment', 'date time specialty sessionValue package operationalStatus').lean(),
    PatientBalance.find({ patient: { $in: oids } }).select('patient transactions').lean(),
  ]);
  const grouped = new Map(ids.map(id => [id, []]));
  for (const payment of payments) {
    const id = String(payment.patient || payment.patientId);
    grouped.get(id)?.push(payment);
  }
  const balanceByPatient = new Map(balances.map(b => [String(b.patient), b]));
  return new Map(ids.map(id => [id, summarizePatientPending(grouped.get(id), balanceByPatient.get(id)?.transactions)]));
}
