#!/usr/bin/env node
/**
 * 🔍 Investigação PR C — Origem dos Ghost Appointments
 *
 * Foco: entender por que appointments estão marcados como pagos
 * (isPaid=true / paymentStatus='paid'/'package_paid') sem origem financeira
 * válida (Payment paid, Package ou crédito liminar).
 *
 * Verifica para cada ghost:
 *   - Session associada (isPaid, paymentStatus, paymentOrigin, status)
 *   - InsuranceGuide / InsurancePlan / InsuranceBatch
 *   - Payment de convênio real (billed/received/pending)
 *   - LiminarContract
 *   - Package.appointments (vínculo inverso)
 *   - Condição de segurança para correção automática
 *
 * Uso:
 *   node scripts/migrations/investigate-ghost-convenio-sessions.js
 *   node scripts/migrations/investigate-ghost-convenio-sessions.js --json > /tmp/investigation.json
 */

import mongoose from 'mongoose';
import fs from 'fs';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const JSON_MODE = process.argv.includes('--json');
const SESSION_FACTORY_FIX_DATE = new Date('2026-07-07T00:00:00.000Z');

async function run() {
  if (!JSON_MODE) console.log('🔍 Investigação Ghost Convenio Sessions\n');
  const startTime = Date.now();

  await mongoose.connect(MONGO_URI);

  const Appointment = mongoose.connection.db.collection('appointments');
  const Payment = mongoose.connection.db.collection('payments');
  const Session = mongoose.connection.db.collection('sessions');
  const InsuranceGuide = mongoose.connection.db.collection('insuranceguides');
  const InsurancePlan = mongoose.connection.db.collection('insuranceplans');
  const InsuranceBatch = mongoose.connection.db.collection('insurancebatches');
  const Patient = mongoose.connection.db.collection('patients');

  // Ghosts com Session mas sem Payment/Package (grupo C da auditoria)
  const ghosts = await Appointment.find({
    $and: [
      { paymentStatus: { $in: ['paid', 'package_paid'] } },
      { isPaid: true },
      { $or: [{ payment: { $exists: false } }, { payment: null }] },
      { $or: [{ package: { $exists: false } }, { package: null }] },
      // tem session
      { $or: [
        { session: { $exists: true, $ne: null } },
        // sessions antigas podem estar no array sessions
        { sessions: { $exists: true, $ne: [] } }
      ]}
    ]
  }).project({
    _id: 1,
    patient: 1,
    patientName: 1,
    date: 1,
    status: 1,
    operationalStatus: 1,
    clinicalStatus: 1,
    paymentStatus: 1,
    isPaid: 1,
    billingType: 1,
    paymentMethod: 1,
    paymentOrigin: 1,
    insuranceGuide: 1,
    insurancePlan: 1,
    session: 1,
    sessions: 1,
    createdAt: 1,
    updatedAt: 1,
    metadata: 1,
    migratedFrom: 1,
    legacyReceipt: 1,
    notes: 1
  }).toArray();

  const safeToFix = [];
  const needsManualReview = [];
  const details = [];

  for (const appt of ghosts) {
    const appointmentId = appt._id;
    const sessionId = appt.session || (appt.sessions?.[0]);

    const [session, payments, batches, guide, plan, patient] = await Promise.all([
      sessionId ? Session.findOne({ _id: sessionId }) : Promise.resolve(null),
      Payment.find({
        $or: [
          { appointment: appointmentId },
          { appointmentId: appointmentId },
          ...(sessionId ? [{ session: sessionId }, { sessionId: sessionId }] : [])
        ]
      }).toArray(),
      InsuranceBatch.find({ 'items.guideId': appt.insuranceGuide }).toArray(),
      appt.insuranceGuide ? InsuranceGuide.findOne({ _id: appt.insuranceGuide }) : Promise.resolve(null),
      appt.insurancePlan ? InsurancePlan.findOne({ _id: appt.insurancePlan }) : Promise.resolve(null),
      appt.patient ? Patient.findOne({ _id: appt.patient }, { fullName: 1 }) : Promise.resolve(null)
    ]);

    const realInsurancePayment = payments.find(p =>
      p.billingType === 'convenio' ||
      p.kind === 'session_payment' && p.insurance?.guideId
    );

    const hasRealFinancialSettlement = !!realInsurancePayment &&
      ['billed', 'received', 'paid'].includes(realInsurancePayment.status);

    const sessionCreatedBeforeFactoryFix = session?.createdAt &&
      new Date(session.createdAt) < SESSION_FACTORY_FIX_DATE;

    const sessionIsConvenioOrigin =
      session?.paymentOrigin === 'convenio' ||
      session?.paymentMethod === 'convenio' ||
      appt.billingType === 'convenio' ||
      appt.paymentMethod === 'convenio' ||
      !!appt.insuranceGuide;

    const sessionPaidMarkerFromBug =
      session?.isPaid === true &&
      (session?.paymentStatus === 'paid' || session?.paymentStatus === 'package_paid');

    // Critérios para correção segura:
    // - é de convênio
    // - não existe payment real de convênio em estado settled
    // - não está em lote já enviado/recebido
    // - a session nasceu antes do fix do sessionFactory OU tem marcadores de bug
    const isSafe =
      sessionIsConvenioOrigin &&
      !hasRealFinancialSettlement &&
      !batches.some(b => ['sent', 'received', 'processed'].includes(b.status)) &&
      (sessionPaidMarkerFromBug || sessionCreatedBeforeFactoryFix);

    const item = {
      appointmentId: appointmentId.toString(),
      patientId: appt.patient?.toString?.() || '',
      patientName: patient?.fullName || appt.patientName || 'N/A',
      date: appt.date,
      appointmentStatus: {
        status: appt.status,
        operationalStatus: appt.operationalStatus,
        clinicalStatus: appt.clinicalStatus,
        paymentStatus: appt.paymentStatus,
        isPaid: appt.isPaid,
        billingType: appt.billingType,
        paymentMethod: appt.paymentMethod,
        paymentOrigin: appt.paymentOrigin
      },
      session: session ? {
        sessionId: session._id.toString(),
        status: session.status,
        isPaid: session.isPaid,
        paymentStatus: session.paymentStatus,
        paymentOrigin: session.paymentOrigin,
        paymentMethod: session.paymentMethod,
        insuranceGuide: session.insuranceGuide?.toString?.(),
        guideConsumed: session.guideConsumed,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      } : null,
      payments: payments.map(p => ({
        paymentId: p._id.toString(),
        status: p.status,
        billingType: p.billingType,
        kind: p.kind,
        amount: p.amount,
        insuranceStatus: p.insurance?.status
      })),
      insuranceContext: {
        guideId: appt.insuranceGuide?.toString?.(),
        planId: appt.insurancePlan?.toString?.(),
        guideUsedSessions: guide?.usedSessions,
        guideTotalSessions: guide?.totalSessions,
        planStatus: plan?.status
      },
      batches: batches.map(b => ({
        batchId: b._id.toString(),
        status: b.status,
        sentAt: b.sentAt,
        receivedAt: b.receivedAt
      })),
      createdAt: appt.createdAt,
      updatedAt: appt.updatedAt,
      metadata: appt.metadata,
      diagnostics: {
        sessionCreatedBeforeFactoryFix,
        sessionPaidMarkerFromBug,
        sessionIsConvenioOrigin,
        hasRealFinancialSettlement,
        hasBatchedGuide: batches.length > 0,
        isSafeToFix: isSafe
      }
    };

    details.push(item);

    if (isSafe) {
      safeToFix.push(item);
    } else {
      needsManualReview.push(item);
    }
  }

  await mongoose.disconnect();
  if (!JSON_MODE) console.log(`⏱️ Tempo de execução: ${Date.now() - startTime}ms`);

  const summary = {
    totalInvestigated: ghosts.length,
    safeToFix: safeToFix.length,
    needsManualReview: needsManualReview.length
  };

  const report = { summary, safeToFix, needsManualReview, details };

  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 INVESTIGAÇÃO GHOST CONVÊNIO COM SESSION                 ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`\nTotal investigado: ${summary.totalInvestigated}`);
  console.log(`  ✅ Seguros para correção automática: ${summary.safeToFix}`);
  console.log(`  ⚠️  Requer revisão manual: ${summary.needsManualReview}`);

  if (safeToFix.length > 0) {
    console.log('\n✅ Casos seguros para correção:');
    for (const item of safeToFix) {
      console.log(`  ${item.appointmentId} | ${item.patientName} | ${item.appointmentStatus.operationalStatus} | session.isPaid=${item.session?.isPaid} session.paymentStatus=${item.session?.paymentStatus}`);
    }
  }

  if (needsManualReview.length > 0) {
    console.log('\n⚠️  Casos que precisam de revisão:');
    for (const item of needsManualReview) {
      console.log(`  ${item.appointmentId} | ${item.patientName} | op=${item.appointmentStatus.operationalStatus} | payments=${item.payments.length} | batches=${item.batches.length} | safe=${item.diagnostics.isSafeToFix}`);
    }
  }

  const reportPath = `/tmp/investigate-ghost-convenio-sessions-${Date.now()}.json`;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Relatório completo: ${reportPath}`);
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
