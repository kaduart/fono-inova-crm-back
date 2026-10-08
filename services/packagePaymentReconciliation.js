import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import { LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS } from '../constants/financial.js';
import { runTransactionWithRetry } from '../utils/transactionRetry.js';
import { planSettledPackageClosure, applySettledPackageClosure } from './packageSettlementClosure.js';

const idOf = value => value?._id || value;
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculatePackagePaymentTotals(pkg, payments) {
  const totalPaid = round(Number(pkg.fundedByTransfer || 0) + payments.filter(p => p.status === 'paid'
    && !LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS.includes(p.kind))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
  const balance = round(Number(pkg.settlementClosure?.billableValue ?? pkg.totalValue ?? 0) - totalPaid);
  return { totalPaid, balance, financialBalance: balance,
    financialStatus: totalPaid <= 0 ? 'unpaid' : balance <= 0 ? 'paid' : 'partially_paid' };
}

// Resolve o vínculo legado pelo Appointment quando Payment.package não foi gravado.
export async function reconcilePackagesForPayments(payments, mongoSession, options = {}) {
  const sessionIds = payments.filter(p => !p.appointment && !p.appointmentId && p.session).map(p => idOf(p.session));
  const sessions = sessionIds.length ? await Session.find({ _id: { $in: sessionIds } })
    .select('package appointmentId').session(mongoSession || null).lean() : [];
  const appointmentIds = [...payments.map(p => idOf(p.appointment || p.appointmentId)), ...sessions.map(s => s.appointmentId)].filter(Boolean);
  const appointments = appointmentIds.length
    ? await Appointment.find({ _id: { $in: appointmentIds } }).select('_id package').session(mongoSession || null).lean()
    : [];
  const ids = [...new Set([...payments.map(p => idOf(p.package)), ...appointments.map(a => a.package), ...sessions.map(s => s.package)]
    .filter(Boolean).map(String))];
  return reconcilePackagePaymentIds(ids, mongoSession, options);
}

export async function reconcilePackagePaymentIds(ids, mongoSession, options = {}) {
  if (!ids.length) return [];
  if (options.closeSettled && !mongoSession) return runTransactionWithRetry(session => reconcilePackagePaymentIds(ids, session, options));
  const packages = await Package.find({ _id: { $in: ids },
    $or: [{ model: 'per_session' }, { paymentType: 'per-session' }],
    type: { $nin: ['convenio', 'liminar'] },
  }).session(mongoSession || null).lean();
  const affected = [];
  for (const pkg of packages) {
    const appointments = await Appointment.find({ package: pkg._id }).select('_id operationalStatus session').session(mongoSession || null).lean();
    const sessionIds = appointments.map(a => a.session).filter(Boolean);
    const payments = await Payment.find({ $or: [{ package: pkg._id }, { appointment: { $in: appointments.map(a => a._id) } }, { session: { $in: sessionIds } }],
        kind: { $nin: LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS },
      }).select('amount status kind appointment session').session(mongoSession || null).lean();
    const plan = options.closeSettled ? planSettledPackageClosure(pkg, appointments, payments) : null;
    const closure = plan ? await applySettledPackageClosure(pkg, plan, mongoSession) : null;
    if (closure) pkg.settlementClosure = closure;
    await Package.updateOne({ _id: pkg._id }, { $set: { ...calculatePackagePaymentTotals(pkg, payments),
      ...(closure ? { status: 'canceled', settlementClosure: closure } : {}) } },
      { session: mongoSession });
    affected.push(String(pkg._id));
  }
  return affected;
}
