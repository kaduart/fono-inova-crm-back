import 'dotenv/config';
import mongoose from 'mongoose';
import { mkdir, writeFile } from 'node:fs/promises';
import Package from '../../models/Package.js';
import PackagesView from '../../models/PackagesView.js';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import { planSettledPackageClosure } from '../../services/packageSettlementClosure.js';
import { LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS } from '../../constants/financial.js';
import '../../models/InsuranceGuide.js';
import { calculatePackagePaymentTotals, reconcilePackagePaymentIds } from '../../services/packagePaymentReconciliation.js';
import { buildPackageView } from '../../domains/billing/services/PackageProjectionService.js';

const patient = '685b0cfaaec14c7163585b5b';
// Relação enviada pelo usuário (somente pacotes particulares por sessão).
const relationIds = ['6a343eea9dcf417d494e35d9', '6a746ed4f69cb76a5e463df7', '6abe4c13bd9f2094944edb9d',
  '69e22ce64e856f552b1aa3e4', '69e272481198805572486583', '69e2730611988055724866d9',
  '6a1d9ecb4bafb710ab15bafa', '6a1d9f1b4bafb710ab15bc81', '6a1d9f484bafb710ab15bda8',
  '6a343e939dcf417d494e3448', '6a343f4d9dcf417d494e3735', '6a746daaf69cb76a5e463a38',
  '6a7f5b001356b5ac803b1431', '6aa150d27d4ff22a69deb708'];
let ids = ['6a746daaf69cb76a5e463a38', '6a7f5b001356b5ac803b1431', '6aa150d27d4ff22a69deb708'];
mongoose.set('autoIndex', false);
await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
try {
  let audit = [];
  if (process.argv.includes('--all-paid')) {
    let candidates = await Package.find({ _id: { $in: relationIds }, patient, model: 'per_session', type: { $nin: ['convenio', 'liminar'] } }).lean();
    // Pedido do usuário: preservar outubro e setembro pertencente aos pacotes em andamento.
    const ongoingIds = await Appointment.distinct('package', { package: { $in: candidates.map(p => p._id) },
      date: { $gte: new Date('2026-10-01T03:00:00Z') } });
    candidates = candidates.filter(pkg => !ongoingIds.some(id => String(id) === String(pkg._id)));
    const candidateIds = candidates.map(pkg => pkg._id);
    const appointments = await Appointment.find({ package: { $in: candidateIds } }).select('_id package operationalStatus session').lean();
    const packageByAppointment = new Map(appointments.map(a => [String(a._id), String(a.package)]));
    const packageBySession = new Map(appointments.filter(a => a.session).map(a => [String(a.session), String(a.package)]));
    const payments = await Payment.find({
      patient, kind: { $nin: LEGACY_FINANCIAL_VIEW_EXCLUDED_KINDS },
      $or: [{ package: { $in: candidateIds } }, { appointment: { $in: appointments.map(a => a._id) } }, { session: { $in: appointments.map(a => a.session).filter(Boolean) } }],
    }).select('package appointment session amount status kind').lean();
    const paymentsByPackage = new Map();
    for (const payment of payments) {
      const packageId = payment.package ? String(payment.package) : packageByAppointment.get(String(payment.appointment)) || packageBySession.get(String(payment.session));
      if (!packageId) continue;
      if (!paymentsByPackage.has(packageId)) paymentsByPackage.set(packageId, []);
      paymentsByPackage.get(packageId).push(payment);
    }
    ids = candidates.filter(pkg => paymentsByPackage.get(String(pkg._id))?.some(p => p.status === 'paid')).map(pkg => String(pkg._id));
    audit = candidates.filter(pkg => ids.includes(String(pkg._id))).map(pkg => ({
      id: pkg._id, specialty: pkg.specialty,
      before: { totalPaid: pkg.totalPaid, balance: pkg.balance },
      expected: calculatePackagePaymentTotals(pkg, paymentsByPackage.get(String(pkg._id))),
      closurePlan: planSettledPackageClosure(pkg, appointments.filter(a => String(a.package) === String(pkg._id)), paymentsByPackage.get(String(pkg._id))),
    }));
    if (process.argv.includes('--close-settled')) {
      ids = audit.filter(item => item.closurePlan || candidates.find(pkg => String(pkg._id) === String(item.id))?.settlementClosure?.closedAt)
        .map(item => String(item.id));
    }
  }
  const before = await Package.find({ _id: { $in: ids }, patient, model: 'per_session' }).lean();
  if (before.length !== ids.length) throw new Error('Pacotes ou paciente não correspondem ao escopo autorizado');
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ mode: 'dry-run', ids, audit }));
  } else {
    const views = await PackagesView.find({ packageId: { $in: ids } }).lean();
    const appointments = await Appointment.find({ package: { $in: ids } }).lean();
    const sessions = await Session.find({ package: { $in: ids } }).lean();
    const payments = await Payment.find({ $or: [{ package: { $in: ids } }, { appointment: { $in: appointments.map(a => a._id) } }] }).lean();
    const directory = new URL('./artifacts/', import.meta.url);
    await mkdir(directory, { recursive: true });
    const backup = new URL(`isis-packages-${Date.now()}-before.json`, directory);
    await writeFile(backup, JSON.stringify({ packages: before, views, appointments, sessions, payments }, null, 2), { flag: 'wx' });
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => reconcilePackagePaymentIds(ids, session, { closeSettled: process.argv.includes('--close-settled') }));
    } finally {
      await session.endSession();
    }
    // Reparo pontual: usa o mesmo rebuild integral do worker canônico.
    for (const id of ids) await buildPackageView(id, { correlationId: 'repair_isis_package_payments_2026_10_07' });
    const after = await Package.find({ _id: { $in: ids } }).select('status totalPaid balance financialStatus settlementClosure').lean();
    const afterViews = await PackagesView.find({ packageId: { $in: ids } }).select('packageId status totalPaid balance financialStatus').lean();
    for (const pkg of after) {
      const view = afterViews.find(v => String(v.packageId) === String(pkg._id));
      if (!view || view.totalPaid !== pkg.totalPaid || view.balance !== pkg.balance || view.status !== pkg.status) throw new Error(`View divergente: ${pkg._id}`);
      if (pkg.settlementClosure?.closedAt) {
        const canceledIds = pkg.settlementClosure.canceledAppointmentIds;
        const remainingAppointments = await Appointment.countDocuments({ _id: { $in: canceledIds }, operationalStatus: { $ne: 'canceled' } });
        const remainingPayments = await Payment.countDocuments({ appointment: { $in: canceledIds }, status: { $in: ['pending', 'scheduled'] } });
        if (remainingAppointments || remainingPayments) throw new Error(`Cancelamento incompleto: ${pkg._id}`);
      }
    }
    console.log(JSON.stringify({ verified: true, count: ids.length, audit, packages: after, backup: backup.pathname }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
  process.exit(process.exitCode || 0);
}
