// Read-only diagnostic: no model hooks, updates or financial reconciliation.
import 'dotenv/config';
import mongoose from 'mongoose';

const timeout = setTimeout(() => { console.error('DIAGNOSTIC_TIMEOUT'); process.exit(2); }, 25000);
try {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  const packageId = new mongoose.Types.ObjectId(process.argv[2]);
  const pkg = await db.collection('packages').findOne({ _id: packageId }, {
    projection: { patient: 1, totalSessions: 1, sessionsDone: 1, preConsumedCount: 1, totalValue: 1,
      totalPaid: 1, sessionValue: 1, balance: 1, date: 1, createdAt: 1, updatedAt: 1,
      model: 1, paymentType: 1, sessions: 1, appointments: 1, payments: 1 }
  });
  console.log('PACKAGE', JSON.stringify(pkg));
  const view = await db.collection('packages_view').findOne({ packageId }, {
    projection: { totalPaid: 1, totalSessions: 1, sessionsDone: 1, sessions: 1, startDate: 1 }
  });
  console.log('PACKAGE_VIEW', JSON.stringify(view));
  if (pkg) {
    const entityIds = [packageId];
    for (const name of ['appointments', 'sessions', 'payments']) {
      const rows = await db.collection(name).find({ patient: pkg.patient }, { projection: {
        package: 1, date: 1, time: 1, status: 1, operationalStatus: 1, amount: 1, sessionValue: 1,
        payment: 1, session: 1, appointment: 1, appointmentId: 1, createdAt: 1, updatedAt: 1,
        financialDate: 1, paidAt: 1, kind: 1, isFromPackage: 1, paymentDate: 1, paymentStatus: 1
      }}).sort({ createdAt: -1 }).limit(30).toArray();
      entityIds.push(...rows.map(row => row._id));
      console.log(name, JSON.stringify(rows));
    }
    const audit = await db.collection('auditlogs').find({
      entityId: { $in: entityIds }, createdAt: { $gte: new Date('2026-09-01'), $lt: new Date('2026-09-04') }
    }, { projection: { action: 1, entityId: 1, source: 1, createdAt: 1, correlationId: 1, diff: 1 } }).limit(80).toArray();
    console.log('AUDIT', JSON.stringify(audit));
    const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name);
    console.log('HISTORY_COLLECTIONS', JSON.stringify(collections.filter(name => /ledger|event|outbox|audit/i.test(name))));
    const ledger = await db.collection('financial_ledger').find({
      patient: pkg.patient, createdAt: { $gte: new Date('2026-09-01'), $lt: new Date('2026-09-04') }
    }, { projection: { type: 1, amount: 1, payment: 1, package: 1, appointment: 1, session: 1,
      occurredAt: 1, createdAt: 1, correlationId: 1, metadata: 1 } }).limit(60).toArray();
    console.log('LEDGER', JSON.stringify(ledger));
  }
} catch (error) {
  console.error('DIAGNOSTIC_FAILED', error.name, error.code || '');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
  clearTimeout(timeout);
}
