// Scoped repair for the package investigated with the user. Default: read-only.
// Run from back/: node scripts/maintenance/repair-package-retroactive-2026-09-01.mjs [--apply]
import 'dotenv/config';
import mongoose from 'mongoose';
import { applyFinancialProtection } from '../../services/appointment/policies/appointmentFinancialPolicy.js';

const ids = Object.fromEntries(Object.entries({
  package: '6a9811c2943c9ac437792235', appointment: '6a956a6e13426564def16dce',
  session: '6a956a6e13426564def16dd1', payment: '6a9737f8b82dac16d0bcf455'
}).map(([key, id]) => [key, new mongoose.Types.ObjectId(id)]));
const apply = process.argv.includes('--apply');
const same = (left, right) => String(left) === String(right);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const timeout = setTimeout(() => { console.error('REPAIR_TIMEOUT'); process.exit(2); }, 45000);
try {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  const transaction = await mongoose.startSession();
  try {
    await transaction.withTransaction(async () => {
      const options = { session: transaction };
      const pkg = await db.collection('packages').findOne({ _id: ids.package }, options);
      const appt = await db.collection('appointments').findOne({ _id: ids.appointment }, options);
      const sess = await db.collection('sessions').findOne({ _id: ids.session }, options);
      const pay = await db.collection('payments').findOne({ _id: ids.payment }, options);
      assert(pkg && appt && sess && pay, 'Missing source document');
      assert(pkg.totalSessions === 2 && pkg.totalValue === 400 && pkg.sessionValue === 200, 'Contract changed');
      assert(pkg.sessionsDone === 1 && pkg.preConsumedCount === 1, 'Consumption changed');
      assert(appt.operationalStatus === 'completed' && sess.status === 'completed', 'Clinical state changed');
      assert(pay.status === 'paid' && pay.amount === 200 && !pay.isFromPackage, 'Payment changed');
      assert(same(pay.appointment, appt._id) && same(pay.session, sess._id) &&
        same(appt.session, sess._id) && same(sess.appointmentId, appt._id), 'Broken source links');
      for (const doc of [appt, sess, pay]) {
        assert(same(doc.patient, pkg.patient), 'Patient mismatch');
        assert(!doc.package || same(doc.package, pkg._id), 'Already belongs to another package');
        assert(!['convenio', 'liminar'].includes(doc.billingType), 'Protected billing origin');
      }
      const receipts = await db.collection('payments').find({
        $or: [{ package: pkg._id }, { _id: pay._id }], status: 'paid', isFromPackage: { $ne: true }
      }, options).toArray();
      const totalPaid = receipts.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      assert(receipts.length === 2 && totalPaid === 400, 'Receipt totals changed');
      const alreadyRepaired = [appt, sess, pay].every(doc => same(doc.package, pkg._id)) &&
        pkg.totalPaid === 400 && pkg.sessions.some(id => same(id, sess._id)) &&
        pkg.appointments.some(id => same(id, appt._id)) && pkg.payments.some(id => same(id, pay._id));
      console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', alreadyRepaired,
        packageId: String(pkg._id), before: { totalPaid: pkg.totalPaid, sessions: pkg.sessions.length },
        after: { totalPaid, sessions: 2, sessionsDone: 1 },
        preserved: ['payment amounts, methods and dates', 'clinical statuses', 'ledger entries'] }));
      if (!apply || alreadyRepaired) return;
      await db.collection('appointments').updateOne({ _id: appt._id }, {
        $set: applyFinancialProtection(appt, { package: pkg._id })
      }, options);
      await db.collection('sessions').updateOne({ _id: sess._id }, { $set: { package: pkg._id } }, options);
      await db.collection('payments').updateOne({ _id: pay._id }, { $set: { package: pkg._id } }, options);
      await db.collection('packages').updateOne({ _id: pkg._id }, {
        $set: { totalPaid, balance: 0, financialStatus: 'paid' },
        $addToSet: { sessions: sess._id, appointments: appt._id, payments: pay._id }
      }, options);
      await db.collection('auditlogs').insertOne({
        action: 'package_retroactive_link_repaired', entityType: 'Package', entityId: pkg._id,
        source: 'repair-package-retroactive-2026-09-01', createdAt: new Date(),
        before: { totalPaid: pkg.totalPaid, appointments: pkg.appointments, sessions: pkg.sessions, payments: pkg.payments },
        after: { totalPaid, linkedAppointment: appt._id, linkedSession: sess._id, linkedPayment: pay._id },
        metadata: { reason: 'Retroactive session counted but not linked; both receipts already paid. No new receipt.' }
      }, options);
    });
  } finally { await transaction.endSession(); }
  if (apply) {
    const { buildPackageView } = await import('../../domains/billing/services/PackageProjectionService.js');
    await buildPackageView(String(ids.package));
    console.log('PACKAGE_VIEW_REBUILT');
  }
} catch (error) {
  console.error('REPAIR_FAILED', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
  clearTimeout(timeout);
}
