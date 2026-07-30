/**
 * Auditoria profunda financeira - classificação read-only
 * Continuação da investigação de LEDGER_DIVERGENCE, DUPLICATE_PAYMENT_SESSION,
 * GHOST_PAYMENT_STATUS e INSURANCE_BATCH_ORPHAN_REF.
 */
import mongoose from 'mongoose';
import FinancialAuditEngine from '../services/financialGuard/auditEngine.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  console.log('=== 1. RESUMO DOS CHECKS ===');
  const engine = new FinancialAuditEngine(db);
  await engine.audit();
  const report = engine.report();
  console.log(JSON.stringify(report.summary, null, 2));

  const ledgerIssues = report.issues.filter(i => i.category === 'LEDGER_DIVERGENCE');
  const duplicateIssues = report.issues.filter(i => i.category === 'DUPLICATE_PAYMENT_SESSION');
  const ghostIssues = report.issues.filter(i => i.category === 'GHOST_PAYMENT_STATUS');
  const orphanBatchIssues = report.issues.filter(i => i.category === 'INSURANCE_BATCH_ORPHAN_REF');

  console.log('\n=== 2. CLASSIFICAÇÃO LEDGER_DIVERGENCE ===');
  const ledgerClass = {
    formulaExtraSessions: 0,
    formulaMismatch: 0,
    noPayment: 0,
    other: 0,
    details: []
  };

  for (const issue of ledgerIssues) {
    const pkg = await db.collection('packages').findOne({ _id: new mongoose.Types.ObjectId(issue.packageId) });
    if (!pkg) {
      ledgerClass.other++;
      continue;
    }

    const pkgPayments = await db.collection('payments').find({
      package: pkg._id,
      status: 'paid'
    }).toArray();

    if (pkgPayments.length === 0 && (pkg.totalPaid || 0) > 0) {
      ledgerClass.noPayment++;
      ledgerClass.details.push({
        packageId: issue.packageId,
        patientId: issue.patientId,
        type: 'NO_PAYMENT',
        totalPaid: pkg.totalPaid,
        totalSessions: pkg.totalSessions,
        sessionsLength: pkg.sessions?.length,
        sessionValue: pkg.sessionValue
      });
      continue;
    }

    const predicted = (pkg.sessionValue || 0) * (pkg.sessions?.length || 0);
    const matchesFormula = Math.abs(predicted - (pkg.totalPaid || 0)) < 1;
    const hasExtraSessions = (pkg.sessions?.length || 0) > (pkg.totalSessions || 0);

    if (matchesFormula && hasExtraSessions) {
      ledgerClass.formulaExtraSessions++;

      const sessionIds = (pkg.sessions || []).map(id =>
        typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id
      );
      const sessions = await db.collection('sessions').find({ _id: { $in: sessionIds } }).toArray();
      const extraSessionIds = sessionIds.filter(id =>
        !sessions.find(s => s._id.toString() === id.toString()) ||
        sessions.find(s => s._id.toString() === id.toString())?.status === 'canceled'
      );

      ledgerClass.details.push({
        packageId: issue.packageId,
        patientId: issue.patientId,
        type: 'FORMULA_EXTRA_SESSIONS',
        totalPaid: pkg.totalPaid,
        predictedByFormula: predicted,
        totalSessions: pkg.totalSessions,
        sessionsLength: pkg.sessions?.length,
        sessionValue: pkg.sessionValue,
        paymentsCount: pkgPayments.length,
        paymentsTotal: pkgPayments.reduce((s, p) => s + (p.amount || 0), 0),
        extraSessionsCount: (pkg.sessions?.length || 0) - (pkg.totalSessions || 0),
        hasCanceledInExtras: sessions.some(s => s.status === 'canceled'),
        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt,
        _migration: pkg._migration
      });
    } else {
      ledgerClass.formulaMismatch++;
      ledgerClass.details.push({
        packageId: issue.packageId,
        patientId: issue.patientId,
        type: 'FORMULA_MISMATCH',
        totalPaid: pkg.totalPaid,
        predictedByFormula: predicted,
        totalSessions: pkg.totalSessions,
        sessionsLength: pkg.sessions?.length,
        sessionValue: pkg.sessionValue,
        paymentsCount: pkgPayments.length,
        paymentsTotal: pkgPayments.reduce((s, p) => s + (p.amount || 0), 0),
        createdAt: pkg.createdAt,
        updatedAt: pkg.updatedAt
      });
    }
  }

  console.log(JSON.stringify(ledgerClass, null, 2));

  console.log('\n=== 3. INVESTIGAÇÃO DUPLICATE_PAYMENT_SESSION ===');
  const duplicateDetails = [];
  for (const issue of duplicateIssues.slice(0, 100)) {
    const sessionId = issue.sessionId;
    if (!sessionId) continue;

    const payments = await db.collection('payments').find({
      session: new mongoose.Types.ObjectId(sessionId),
      status: { $nin: ['canceled', 'refunded'] }
    }).sort({ createdAt: 1 }).toArray();

    const session = await db.collection('sessions').findOne({ _id: new mongoose.Types.ObjectId(sessionId) });
    const appointment = session?.appointment
      ? await db.collection('appointments').findOne({ _id: session.appointment })
      : null;

    duplicateDetails.push({
      sessionId,
      sessionStatus: session?.status,
      sessionDate: session?.date,
      appointmentId: appointment?._id?.toString(),
      appointmentStatus: appointment?.status,
      appointmentPaymentStatus: appointment?.paymentStatus,
      patientId: session?.patient?.toString(),
      paymentCount: payments.length,
      payments: payments.map(p => ({
        paymentId: p._id.toString(),
        amount: p.amount,
        status: p.status,
        kind: p.kind,
        billingType: p.billingType,
        package: p.package?.toString(),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        _migration: p._migration
      }))
    });
  }

  const dupPatterns = {};
  for (const d of duplicateDetails) {
    const key = d.payments.map(p => `${p.kind}:${p.billingType}:${p.status}`).join(' | ');
    dupPatterns[key] = (dupPatterns[key] || 0) + 1;
  }

  console.log('Padrões de duplicidade:');
  console.log(JSON.stringify(dupPatterns, null, 2));
  console.log('\nDetalhes (primeiros 20):');
  console.log(JSON.stringify(duplicateDetails.slice(0, 20), null, 2));

  console.log('\n=== 4. INVESTIGAÇÃO GHOST_PAYMENT_STATUS ===');
  const ghostDetails = [];
  for (const issue of ghostIssues.slice(0, 100)) {
    const appt = await db.collection('appointments').findOne({
      _id: new mongoose.Types.ObjectId(issue.appointmentId)
    });
    if (!appt) continue;

    const sessions = await db.collection('sessions').find({
      appointment: appt._id
    }).toArray();

    const payments = await db.collection('payments').find({
      appointment: appt._id,
      status: 'paid'
    }).toArray();

    ghostDetails.push({
      appointmentId: issue.appointmentId,
      patientId: issue.patientId,
      status: appt.status,
      paymentStatus: appt.paymentStatus,
      isPaid: appt.isPaid,
      billingType: appt.billingType,
      package: appt.package?.toString(),
      hasPackageRef: !!appt.package,
      sessionsCount: sessions.length,
      sessionsStatuses: sessions.map(s => s.status),
      paymentsCount: payments.length,
      paymentsTotal: payments.reduce((s, p) => s + (p.amount || 0), 0),
      createdAt: appt.createdAt,
      updatedAt: appt.updatedAt
    });
  }

  const ghostPatterns = {};
  for (const g of ghostDetails) {
    const key = `billing=${g.billingType}|status=${g.status}|pkg=${g.hasPackageRef}|sessions=${g.sessionsCount}|payments=${g.paymentsCount}`;
    ghostPatterns[key] = (ghostPatterns[key] || 0) + 1;
  }

  console.log('Padrões ghost:');
  console.log(JSON.stringify(ghostPatterns, null, 2));
  console.log('\nDetalhes (primeiros 20):');
  console.log(JSON.stringify(ghostDetails.slice(0, 20), null, 2));

  console.log('\n=== 5. INVESTIGAÇÃO INSURANCE_BATCH_ORPHAN_REF ===');
  const orphanDetails = [];
  for (const issue of orphanBatchIssues.slice(0, 100)) {
    const batch = await db.collection('insurancebatches').findOne({
      _id: new mongoose.Types.ObjectId(issue.batchId)
    });

    orphanDetails.push({
      batchId: issue.batchId,
      batchNumber: issue.batchNumber,
      batchStatus: batch?.status,
      batchProvider: batch?.provider?.toString(),
      refType: issue.paymentId ? 'payment' : 'session',
      refId: issue.paymentId || issue.sessionId,
      createdAt: batch?.createdAt,
      updatedAt: batch?.updatedAt
    });
  }

  const orphanPatterns = {};
  for (const o of orphanDetails) {
    const key = `status=${o.batchStatus}|refType=${o.refType}`;
    orphanPatterns[key] = (orphanPatterns[key] || 0) + 1;
  }

  console.log('Padrões orphan batch:');
  console.log(JSON.stringify(orphanPatterns, null, 2));
  console.log('\nDetalhes (primeiros 30):');
  console.log(JSON.stringify(orphanDetails.slice(0, 30), null, 2));

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
