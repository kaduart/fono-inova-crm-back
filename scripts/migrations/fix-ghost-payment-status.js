// back/scripts/migrations/fix-ghost-payment-status.js
//
// Corrige appointments marcados como pagos (paymentStatus='paid'/'package_paid',
// isPaid=true) cujo Payment real na collection foi cancelado.
//
// Critérios de segurança (alinhados com FinancialAuditEngine):
// - Não altera liminar/crédito judicial.
// - Não altera se existir pacote ativo, outro Payment paid ou recebível convênio ativo.
// - Appointment operationalStatus = 'canceled'  → paymentStatus='canceled', isPaid=false
// - Appointment operationalStatus em ['scheduled','confirmed','pre_agendado','pending']
//                                                → paymentStatus='pending', isPaid=false
// - Appointment operationalStatus = 'completed' → mantém para revisão manual
//
// Uso:
//   node scripts/migrations/fix-ghost-payment-status.js --dry-run
//   node scripts/migrations/fix-ghost-payment-status.js --execute

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const isDryRun = process.argv.includes('--dry-run');
const isExecute = process.argv.includes('--execute');

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI/MONGO_URI não definida');
  process.exit(1);
}

if (!isDryRun && !isExecute) {
  console.error('❌ Informe --dry-run ou --execute');
  process.exit(1);
}

const PENDING_OP_STATUSES = ['scheduled', 'confirmed', 'pre_agendado', 'pending'];

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const appointments = db.collection('appointments');
  const payments = db.collection('payments');

  // Busca appointments marcados como pagos
  const paidAppointments = await appointments.find({
    $or: [
      { paymentStatus: 'paid' },
      { paymentStatus: 'package_paid' },
      { isPaid: true }
    ]
  }).toArray();

  let totalGhost = 0;
  let fixed = 0;
  let skippedCompleted = 0;
  let skippedValidOrigin = 0;
  let skippedPaymentOk = 0;
  const report = [];

  console.log(`[DRY-RUN=${isDryRun}] Verificando ${paidAppointments.length} appointments marcados como pagos...\n`);

  for (const appt of paidAppointments) {
    const apptId = appt._id.toString();

    // Resolve o paymentId, mesmo se estiver corrompido como sub-documento
    let paymentId = appt.payment?._id ?? appt.payment;
    if (typeof paymentId === 'string' && /^[a-f0-9]{24}$/i.test(paymentId)) {
      paymentId = new mongoose.Types.ObjectId(paymentId);
    }

    // Proteção: liminar/crédito judicial
    const isLiminar = appt.billingType === 'liminar' ||
      appt.paymentMethod === 'liminar_credit' ||
      appt.paymentOrigin === 'liminar_credit' ||
      !!appt.liminarContract;

    if (isLiminar) {
      skippedValidOrigin++;
      continue;
    }

    // Proteção: pacote ativo é a origem financeira
    const hasActivePackage = appt.package || appt.serviceType === 'package_session';

    // Proteção: guia de convênio ativa
    const hasInsuranceGuide = appt.insuranceGuide;

    if (hasActivePackage || hasInsuranceGuide) {
      skippedValidOrigin++;
      continue;
    }

    // Se tem payment ativo na collection (qualquer um vinculado ao appointment), não é ghost
    const activePaid = await payments.findOne({
      $or: [
        { appointment: appt._id },
        { appointmentId: apptId }
      ],
      status: 'paid'
    }, { projection: { _id: 1 } });

    if (activePaid) {
      skippedPaymentOk++;
      continue;
    }

    // Se tem recebível de convênio ativo, não é ghost
    const activeConvenio = await payments.findOne({
      $or: [
        { appointment: appt._id },
        { appointmentId: apptId }
      ],
      billingType: 'convenio',
      status: { $in: ['pending', 'pending_billing', 'billed', 'received'] }
    }, { projection: { _id: 1 } });

    if (activeConvenio) {
      skippedValidOrigin++;
      continue;
    }

    // É ghost
    totalGhost++;

    let newPaymentStatus;
    let action;

    if (appt.operationalStatus === 'canceled') {
      newPaymentStatus = 'canceled';
      action = 'SET_CANCELED';
    } else if (PENDING_OP_STATUSES.includes(appt.operationalStatus)) {
      newPaymentStatus = 'pending';
      action = 'SET_PENDING';
    } else if (appt.operationalStatus === 'completed') {
      skippedCompleted++;
      report.push({
        appointmentId: apptId,
        operationalStatus: appt.operationalStatus,
        paymentStatus: appt.paymentStatus,
        isPaid: appt.isPaid,
        paymentId: paymentId?.toString?.(),
        action: 'SKIP_COMPLETED',
        reason: 'Appointment completed com payment cancelado — requer revisão manual'
      });
      continue;
    } else {
      skippedCompleted++;
      report.push({
        appointmentId: apptId,
        operationalStatus: appt.operationalStatus,
        paymentStatus: appt.paymentStatus,
        isPaid: appt.isPaid,
        paymentId: paymentId?.toString?.(),
        action: 'SKIP_UNKNOWN_STATUS',
        reason: `operationalStatus não mapeado: ${appt.operationalStatus}`
      });
      continue;
    }

    report.push({
      appointmentId: apptId,
      operationalStatus: appt.operationalStatus,
      paymentStatus: appt.paymentStatus,
      isPaid: appt.isPaid,
      paymentId: paymentId?.toString?.(),
      action,
      newPaymentStatus,
      newIsPaid: false
    });

    if (isExecute) {
      await appointments.updateOne(
        { _id: appt._id },
        {
          $set: {
            paymentStatus: newPaymentStatus,
            isPaid: false,
            updatedAt: new Date(),
          },
          $push: {
            history: {
              action: 'ghost_payment_status_fix',
              newStatus: newPaymentStatus,
              timestamp: new Date(),
              context: 'migração PR C.1',
              details: {
                reason: 'Payment cancelado sem origem financeira válida',
                previousPaymentStatus: appt.paymentStatus,
                previousIsPaid: appt.isPaid,
                paymentId: paymentId?.toString?.()
              }
            }
          }
        }
      );
      fixed++;
      console.log(`✅ ${apptId}: ${appt.operationalStatus} → paymentStatus=${newPaymentStatus}, isPaid=false`);
    } else {
      fixed++;
      console.log(`[DRY-RUN] ${apptId}: ${appt.operationalStatus} → paymentStatus=${newPaymentStatus}, isPaid=false`);
    }
  }

  console.log('\n=== RESUMO ===');
  console.log(`Appointments pagos analisados: ${paidAppointments.length}`);
  console.log(`Ghosts encontrados:            ${totalGhost}`);
  console.log(`Corrigidos/OK (dry-run):       ${fixed}`);
  console.log(`Ignorados (origem válida):     ${skippedValidOrigin}`);
  console.log(`Ignorados (payment ativo):      ${skippedPaymentOk}`);
  console.log(`Ignorados (completed/unknown):  ${skippedCompleted}`);
  console.log(`Modo:                          ${isExecute ? 'EXECUTE' : 'DRY-RUN'}`);

  if (report.length > 0 && !isExecute) {
    console.log('\n=== DETALHES ===');
    console.log(JSON.stringify(report.slice(0, 100), null, 2));
    if (report.length > 100) {
      console.log(`... e mais ${report.length - 100} registros`);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Erro:', err);
  process.exit(1);
});
