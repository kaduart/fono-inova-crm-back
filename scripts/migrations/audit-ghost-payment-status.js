#!/usr/bin/env node
/**
 * 🔍 Auditoria PR C — Ghost Payment Status
 *
 * Classifica appointments marcados como pagos mas sem Payment/Package vinculado.
 *
 * Critérios:
 *   Grupo A (ghost puro): sem Payment, sem Package, sem Session → candidato a limpeza
 *   Grupo B (histórico/migração): sem Payment atual, mas com indícios de migração/recibo antigo/cancelado
 *   Grupo C (possível bug ativo): atualizações recentes, paciente ativo, appointment futuro ou pendente
 *
 * Uso:
 *   node scripts/migrations/audit-ghost-payment-status.js
 *   node scripts/migrations/audit-ghost-payment-status.js --json > /tmp/ghost-audit.json
 */

import mongoose from 'mongoose';
import fs from 'fs';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI não definida');
  process.exit(1);
}

const JSON_MODE = process.argv.includes('--json');

// Limite temporal para considerar "recente" (após as correções V2)
const V2_CUTOFF = new Date('2026-06-01T00:00:00.000Z');
const RECENT_WINDOW = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // últimos 30 dias

async function run() {
  if (!JSON_MODE) {
    console.log('🔍 Auditoria Ghost Payment Status\n');
  }
  const startTime = Date.now();

  await mongoose.connect(MONGO_URI);

  const Appointment = mongoose.connection.db.collection('appointments');
  const Payment = mongoose.connection.db.collection('payments');
  const PackageColl = mongoose.connection.db.collection('packages');
  const Session = mongoose.connection.db.collection('sessions');
  const Patient = mongoose.connection.db.collection('patients');

  // Busca appointments ghost: marcados como pagos mas sem origem financeira válida.
  // Liminar/crédito judicial NÃO gera Payment por sessão — o caixa foi reconhecido
  // no recebimento do contrato. Esses appointments podem estar "pagos" sem Payment
  // e sem Package legitimamente.
  //
  // ⚠️ NÃO excluímos por appointment.payment/appointment.package aqui. O campo
  // embedded `appointment.payment` pode estar desatualizado (Payment cancelado na
  // collection mas ainda referenciado como paid no appointment). A verificação de
  // origem financeira é feita em cima das collections reais.
  const ghosts = await Appointment.find({
    $and: [
      {
        $or: [
          { isPaid: true },
          { paymentStatus: { $in: ['paid', 'package_paid'] } }
        ]
      },
      // Exclui liminar/crédito judicial
      {
        billingType: { $ne: 'liminar' },
        paymentMethod: { $ne: 'liminar_credit' },
        paymentOrigin: { $ne: 'liminar_credit' },
        $or: [
          { liminarContract: { $exists: false } },
          { liminarContract: null }
        ]
      }
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
    package: 1,
    liminarContract: 1,
    createdAt: 1,
    updatedAt: 1,
    migratedFrom: 1,
    legacyReceipt: 1,
    notes: 1
  }).toArray();

  console.error(`👻 ${ghosts.length} appointments ghost encontrados`);

  const groupA = [];
  const groupB = [];
  const groupC = [];
  const details = [];

  // Origens financeiras válidas que justificam appointment como pago sem Payment paid.
  const appointmentIds = ghosts.map(a => a._id);
  const [paidPayments, packagesByAppointment, convenioReceivables] = await Promise.all([
    Payment.find({
      $or: [
        { appointment: { $in: appointmentIds } },
        { appointmentId: { $in: appointmentIds.map(id => id.toString()) } }
      ],
      status: 'paid'
    }).project({ appointment: 1, appointmentId: 1 }).toArray(),
    PackageColl.find({ appointments: { $in: appointmentIds } }).project({ appointments: 1 }).toArray(),
    Payment.find({
      $or: [
        { appointment: { $in: appointmentIds } },
        { appointmentId: { $in: appointmentIds.map(id => id.toString()) } }
      ],
      billingType: 'convenio',
      status: { $in: ['pending', 'pending_billing', 'billed', 'received'] }
    }).project({ appointment: 1, appointmentId: 1 }).toArray()
  ]);

  const resolveAppointmentId = (p) => {
    if (p.appointment) return p.appointment.toString();
    if (p.appointmentId) {
      const str = typeof p.appointmentId === 'string' ? p.appointmentId : p.appointmentId.toString();
      if (mongoose.Types.ObjectId.isValid(str)) return str;
    }
    return null;
  };

  const paidByAppointment = new Set();
  for (const p of paidPayments) {
    const id = resolveAppointmentId(p);
    if (id) paidByAppointment.add(id);
  }

  const packageByAppointment = new Set();
  for (const pkg of packagesByAppointment) {
    for (const apptId of (pkg.appointments || [])) {
      packageByAppointment.add(apptId?.toString());
    }
  }

  const convenioByAppointment = new Set();
  for (const p of convenioReceivables) {
    const id = resolveAppointmentId(p);
    if (id) convenioByAppointment.add(id);
  }

  for (const appt of ghosts) {
    const appointmentId = appt._id;
    const patientId = appt.patient;
    const apptIdStr = appointmentId.toString();

    // Se existe origem financeira válida, não é ghost.
    const hasPaidPayment = paidByAppointment.has(apptIdStr);
    const hasPackage = !!appt.package || packageByAppointment.has(apptIdStr);
    const hasConvenioReceivable = convenioByAppointment.has(apptIdStr);
    if (hasPaidPayment || hasPackage || hasConvenioReceivable) continue;

    const [paymentCount, packageCount, sessionCount, patient] = await Promise.all([
      Payment.countDocuments({ $or: [{ appointment: appointmentId }, { appointmentId }] }),
      PackageColl.countDocuments({ appointments: appointmentId }),
      Session.countDocuments({ appointmentId: appointmentId }),
      patientId ? Patient.findOne({ _id: patientId }, { status: 1, fullName: 1 }) : Promise.resolve(null)
    ]);

    const hasMigrationMarker = !!(
      appt.migratedFrom ||
      appt.legacyReceipt ||
      (appt.notes && /migra|legado|importado|sync/i.test(appt.notes))
    );

    const isCanceled = ['canceled', 'cancelled'].includes(appt.status) ||
                       ['canceled', 'cancelled'].includes(appt.operationalStatus) ||
                       ['canceled', 'cancelled'].includes(appt.clinicalStatus);

    const isFuture = appt.date && new Date(appt.date) > new Date();
    const createdAfterV2 = appt.createdAt && new Date(appt.createdAt) > V2_CUTOFF;
    const updatedRecently = appt.updatedAt && new Date(appt.updatedAt) > RECENT_WINDOW;
    const isOperationalPending = ['pending', 'scheduled', 'confirmed', 'pre_agendado'].includes(appt.operationalStatus);
    const patientActive = patient?.status === 'active' || !patient?.status;

    const item = {
      appointmentId: appointmentId.toString(),
      patientId: patientId?.toString() || '',
      patientName: patient?.fullName || appt.patientName || 'N/A',
      date: appt.date,
      status: appt.status,
      operationalStatus: appt.operationalStatus,
      clinicalStatus: appt.clinicalStatus,
      paymentStatus: appt.paymentStatus,
      isPaid: appt.isPaid,
      createdAt: appt.createdAt,
      updatedAt: appt.updatedAt,
      hasMigrationMarker,
      isCanceled,
      isFuture,
      createdAfterV2,
      updatedRecently,
      isOperationalPending,
      patientActive,
      paymentCount,
      packageCount,
      sessionCount
    };

    // Classificação
    // Grupo A: ghost completo, sem vínculos, sem marcas históricas → candidato direto a limpeza
    const isPureGhost = paymentCount === 0 && packageCount === 0 && sessionCount === 0;
    const hasNoPayment = paymentCount === 0;
    const isHistorical = hasMigrationMarker || isCanceled || (appt.createdAt && new Date(appt.createdAt) < V2_CUTOFF);
    const isActiveBug = createdAfterV2 && patientActive && (isFuture || isOperationalPending);

    item.classificationReason = [];

    if (isActiveBug && hasNoPayment) {
      groupC.push(item);
      item.group = 'C';
      item.classificationReason.push('active_bug');
    } else if (isPureGhost && !isHistorical) {
      groupA.push(item);
      item.group = 'A';
      item.classificationReason.push('pure_ghost');
    } else if (hasNoPayment && isHistorical) {
      groupB.push(item);
      item.group = 'B';
      item.classificationReason.push('historical_migration');
    } else if (isPureGhost) {
      // Ghost puro mas com alguma marca histórica → grupo B por segurança
      groupB.push(item);
      item.group = 'B';
      item.classificationReason.push('pure_ghost_historical');
    } else {
      // Tem Session/Package mas nenhum Payment — não é ghost puro; revisar manualmente
      groupC.push(item);
      item.group = 'C';
      item.classificationReason.push('no_payment_with_session_or_package');
    }

    details.push(item);
  }

  await mongoose.disconnect();
  if (!JSON_MODE) console.log(`⏱️ Tempo de execução: ${Date.now() - startTime}ms`);

  // Distribuição temporal (apenas ghosts reais)
  const byYearMonth = {};
  for (const item of details) {
    const d = item.createdAt ? new Date(item.createdAt) : null;
    if (!d || isNaN(d)) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byYearMonth[key] = (byYearMonth[key] || 0) + 1;
  }

  const summary = {
    rawCandidates: ghosts.length,
    total: details.length,
    groupA: {
      label: 'Ghost puro (candidato a limpeza)',
      count: groupA.length
    },
    groupB: {
      label: 'Histórico/migração',
      count: groupB.length
    },
    groupC: {
      label: 'Possível bug ativo / revisão manual',
      count: groupC.length
    },
    byYearMonth
  };

  const report = { summary, details };

  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 CLASSIFICAÇÃO GHOST PAYMENT STATUS                      ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`\nTotal analisado: ${summary.total}`);
  console.log(`  🅰️  ${summary.groupA.label}: ${summary.groupA.count}`);
  console.log(`  🅱️  ${summary.groupB.label}: ${summary.groupB.count}`);
  console.log(`  🅲️  ${summary.groupC.label}: ${summary.groupC.count}`);

  if (groupC.length > 0) {
    console.log('\n🚨 Grupo C — Requer revisão manual:');
    for (const item of groupC.slice(0, 10)) {
      console.log(`  ${item.appointmentId} | paciente: ${item.patientName} | date: ${item.date} | opStatus: ${item.operationalStatus} | createdAt: ${item.createdAt}`);
    }
  }

  const reportPath = `/tmp/ghost-payment-status-audit-${Date.now()}.json`;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Relatório completo: ${reportPath}`);
}

run().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
