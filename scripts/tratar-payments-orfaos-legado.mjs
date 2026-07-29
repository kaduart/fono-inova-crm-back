import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!mongoUri) {
  console.error('MONGODB_URI/MONGO_URI não encontrado');
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--confirm');
const OPERATION = args.find(a => a.startsWith('--op='))?.split('=')[1];

if (!['fix-package-receipt', 'mark-legacy', 'fix-session-mismatch', 'fix-manual-mismatch', 'mark-healthy'].includes(OPERATION)) {
  console.error('Uso: node tratar-payments-orfaos-legado.mjs --op=<operacao> [--confirm]');
  console.error('Operações:');
  console.error('  fix-package-receipt    Corrige os 2 package_receipt pelo package.patient');
  console.error('  mark-legacy            Marca os 5 legacy_patient_deleted');
  console.error('  fix-session-mismatch   Corrige os 6 session_payment pelo appointment.patient');
  console.error('  fix-manual-mismatch    Corrige manual com appointment.patient existente');
  console.error('  mark-healthy           Marca payments com patient existente como healthy');
  process.exit(1);
}

function toObjectId(id) {
  try {
    return new mongoose.Types.ObjectId(id);
  } catch {
    return null;
  }
}

function formatMoney(n) {
  return `R$ ${Number(n || 0).toFixed(2)}`;
}

await mongoose.connect(mongoUri);
const db = mongoose.connection.db;
const payments = db.collection('payments');
const appointments = db.collection('appointments');
const patients = db.collection('patients');
const sessions = db.collection('sessions');
const packages = db.collection('packages');

const backupsDir = join(__dirname, '../../backups-mongo');

// Carrega o relatório detalhado mais recente
const detailFiles = (await fs.readdir(backupsDir))
  .filter(f => f.startsWith('paid-orphans-detailed-22-') && f.endsWith('.json'))
  .sort()
  .reverse();

if (detailFiles.length === 0) {
  console.error('❌ Nenhum relatório paid-orphans-detailed-22 encontrado');
  process.exit(1);
}

const detailPath = join(backupsDir, detailFiles[0]);
const detail = JSON.parse(await fs.readFile(detailPath, 'utf8'));

const targetItems = detail.items.filter(item => {
  if (OPERATION === 'fix-package-receipt') return item.analysis.suggestion === 'corrigir_vinculo_inconsistente' && item.payment.kind === 'package_receipt';
  if (OPERATION === 'mark-legacy') return item.analysis.suggestion === 'legado_patient_deleted';
  if (OPERATION === 'fix-session-mismatch') return item.analysis.suggestion === 'corrigir_vinculo_inconsistente' && item.payment.kind === 'session_payment';
  if (OPERATION === 'fix-manual-mismatch') return item.analysis.suggestion === 'corrigir_vinculo_inconsistente' && item.payment.kind === 'manual';
  if (OPERATION === 'mark-healthy') return item.analysis.suggestion === 'relink_possivel';
  return false;
});

if (targetItems.length === 0) {
  console.log(`✅ Nenhum item para operação "${OPERATION}"`);
  await mongoose.disconnect();
  process.exit(0);
}

console.log(`Operação: ${OPERATION}`);
console.log(`Itens: ${targetItems.length}`);
console.log(`Valor total: ${formatMoney(targetItems.reduce((s, i) => s + (i.payment.amount || 0), 0))}\n`);

const operations = [];

for (const item of targetItems) {
  const payId = toObjectId(item.payment._id);
  const pay = await payments.findOne({ _id: payId });
  if (!pay) {
    console.log(`⚠️ Payment não encontrado: ${item.payment._id}`);
    continue;
  }

  const appointment = item.payment.appointmentId ? await appointments.findOne({ _id: toObjectId(item.payment.appointmentId) }) : null;
  const session = item.payment.sessionId ? await sessions.findOne({ _id: toObjectId(item.payment.sessionId) }) : null;
  const pkg = item.payment.packageId ? await packages.findOne({ _id: toObjectId(item.payment.packageId) }) : null;

  if (OPERATION === 'fix-package-receipt') {
    if (!pkg || !(pkg.patientId || pkg.patient)) {
      console.log(`⚠️ Sem package.patient para ${item.payment._id}`);
      continue;
    }
    const targetPatientId = (pkg.patientId || pkg.patient.toString()).toString();
    const targetPatientName = (await patients.findOne({ _id: toObjectId(targetPatientId) }))?.fullName || null;

    operations.push({
      paymentId: item.payment._id,
      amount: item.payment.amount,
      operation: 'relink_package_receipt',
      from: {
        patientId: pay.patient?.toString?.() || pay.patientId,
        patientName: item.patient?.fullName || null
      },
      to: {
        patientId: targetPatientId,
        patientName: targetPatientName
      },
      update: {
        $set: {
          patient: toObjectId(targetPatientId),
          patientId: targetPatientId,
          integrityStatus: 'relinked',
          'integrityMetadata.detectedAt': new Date(),
          'integrityMetadata.originalPatientId': pay.patient?.toString?.() || pay.patientId,
          'integrityMetadata.originalPatientName': item.patient?.fullName || null,
          'integrityMetadata.reason': 'package_receipt_patient_mismatch',
          'integrityMetadata.notes': `Relink automático: patient corrigido de ${pay.patient?.toString?.() || pay.patientId} para ${targetPatientId} (patient do package)`,
          'integrityMetadata.treatedAt': new Date(),
          'integrityMetadata.treatedBy': 'tratar-payments-orfaos-legado.mjs'
        }
      }
    });
    console.log(`  ${item.payment._id} | ${formatMoney(item.payment.amount)} | ${item.payment.kind} | patient ${pay.patient?.toString?.() || pay.patientId} → ${targetPatientId}`);
  }

  if (OPERATION === 'mark-legacy') {
    const originalPatientId = pay.patient?.toString?.() || pay.patientId;
    operations.push({
      paymentId: item.payment._id,
      amount: item.payment.amount,
      operation: 'mark_legacy_patient_deleted',
      from: { patientId: originalPatientId },
      to: { integrityStatus: 'legacy_patient_deleted' },
      update: {
        $set: {
          integrityStatus: 'legacy_patient_deleted',
          'integrityMetadata.detectedAt': new Date(),
          'integrityMetadata.originalPatientId': originalPatientId,
          'integrityMetadata.originalPatientName': item.patient?.fullName || null,
          'integrityMetadata.reason': 'patient_deleted_without_cascade',
          'integrityMetadata.notes': 'Paciente deletado sem cascade. Payment mantido por registro financeiro. Session/Appointment ainda existem.',
          'integrityMetadata.treatedAt': new Date(),
          'integrityMetadata.treatedBy': 'tratar-payments-orfaos-legado.mjs'
        }
      }
    });
    console.log(`  ${item.payment._id} | ${formatMoney(item.payment.amount)} | ${item.payment.kind} | marcado como legacy_patient_deleted`);
  }

  if (OPERATION === 'fix-session-mismatch') {
    if (!appointment || !appointment.patient) {
      console.log(`⚠️ Sem appointment.patient para ${item.payment._id}`);
      continue;
    }
    const targetPatientId = appointment.patient.toString();
    const targetPatientName = (await patients.findOne({ _id: toObjectId(targetPatientId) }))?.fullName || null;

    operations.push({
      paymentId: item.payment._id,
      amount: item.payment.amount,
      operation: 'relink_session_mismatch',
      from: {
        patientId: pay.patient?.toString?.() || pay.patientId,
        appointmentPatientId: appointment.patient.toString(),
        sessionPatientId: session?.patient?.toString?.() || session?.patientId || null
      },
      to: {
        patientId: targetPatientId,
        patientName: targetPatientName
      },
      update: {
        $set: {
          patient: toObjectId(targetPatientId),
          patientId: targetPatientId,
          integrityStatus: 'relinked',
          'integrityMetadata.detectedAt': new Date(),
          'integrityMetadata.originalPatientId': pay.patient?.toString?.() || pay.patientId,
          'integrityMetadata.originalPatientName': item.patient?.fullName || null,
          'integrityMetadata.reason': 'session_payment_patient_mismatch',
          'integrityMetadata.notes': `Relink histórico controlado: patient corrigido para appointment.patient (${targetPatientId}). Session.patient divergia: ${session?.patient?.toString?.() || session?.patientId || 'nulo'}`,
          'integrityMetadata.treatedAt': new Date(),
          'integrityMetadata.treatedBy': 'tratar-payments-orfaos-legado.mjs'
        }
      }
    });
    console.log(`  ${item.payment._id} | ${formatMoney(item.payment.amount)} | ${item.payment.kind} | patient ${pay.patient?.toString?.() || pay.patientId} → ${targetPatientId} (appointment.patient)`);

    // Também corrige a session, se existir
    if (session && session._id) {
      operations.push({
        paymentId: session._id.toString(),
        amount: 0,
        operation: 'relink_session_patient',
        collection: 'sessions',
        from: { patientId: session.patient?.toString?.() || session.patientId },
        to: { patientId: targetPatientId },
        update: {
          $set: {
            patient: toObjectId(targetPatientId),
            patientId: targetPatientId
          }
        }
      });
      console.log(`    ↳ session ${session._id.toString()} patient corrigido para ${targetPatientId}`);
    }
  }

  if (OPERATION === 'fix-manual-mismatch') {
    if (!appointment || !appointment.patient) {
      console.log(`⚠️ Sem appointment.patient para ${item.payment._id}`);
      continue;
    }
    const targetPatientId = appointment.patient.toString();
    const targetPatientName = (await patients.findOne({ _id: toObjectId(targetPatientId) }))?.fullName || null;

    operations.push({
      paymentId: item.payment._id,
      amount: item.payment.amount,
      operation: 'relink_manual_mismatch',
      from: {
        patientId: pay.patient?.toString?.() || pay.patientId,
        appointmentPatientId: appointment.patient.toString(),
        sessionPatientId: session?.patient?.toString?.() || session?.patientId || null
      },
      to: {
        patientId: targetPatientId,
        patientName: targetPatientName
      },
      update: {
        $set: {
          patient: toObjectId(targetPatientId),
          patientId: targetPatientId,
          integrityStatus: 'relinked',
          'integrityMetadata.detectedAt': new Date(),
          'integrityMetadata.originalPatientId': pay.patient?.toString?.() || pay.patientId,
          'integrityMetadata.originalPatientName': item.patient?.fullName || null,
          'integrityMetadata.reason': 'manual_payment_patient_mismatch',
          'integrityMetadata.notes': `Relink histórico controlado: patient corrigido para appointment.patient (${targetPatientId}). Session.patient divergia: ${session?.patient?.toString?.() || session?.patientId || 'nulo'}`,
          'integrityMetadata.treatedAt': new Date(),
          'integrityMetadata.treatedBy': 'tratar-payments-orfaos-legado.mjs'
        }
      }
    });
    console.log(`  ${item.payment._id} | ${formatMoney(item.payment.amount)} | ${item.payment.kind} | patient ${pay.patient?.toString?.() || pay.patientId} → ${targetPatientId} (appointment.patient)`);

    if (session && session._id) {
      operations.push({
        paymentId: session._id.toString(),
        amount: 0,
        operation: 'relink_session_patient',
        collection: 'sessions',
        from: { patientId: session.patient?.toString?.() || session.patientId },
        to: { patientId: targetPatientId },
        update: {
          $set: {
            patient: toObjectId(targetPatientId),
            patientId: targetPatientId
          }
        }
      });
      console.log(`    ↳ session ${session._id.toString()} patient corrigido para ${targetPatientId}`);
    }
  }

  if (OPERATION === 'mark-healthy') {
    const originalPatientId = pay.patient?.toString?.() || pay.patientId;
    operations.push({
      paymentId: item.payment._id,
      amount: item.payment.amount,
      operation: 'mark_healthy_existing_patient',
      from: { patientId: originalPatientId },
      to: { integrityStatus: 'healthy' },
      update: {
        $set: {
          integrityStatus: 'healthy',
          'integrityMetadata.detectedAt': new Date(),
          'integrityMetadata.originalPatientId': originalPatientId,
          'integrityMetadata.originalPatientName': item.patient?.fullName || null,
          'integrityMetadata.reason': 'patient_exists_appointment_deleted',
          'integrityMetadata.notes': 'Patient existe e é válido. Appointment removido, mas payment permanece consistente.',
          'integrityMetadata.treatedAt': new Date(),
          'integrityMetadata.treatedBy': 'tratar-payments-orfaos-legado.mjs'
        }
      }
    });
    console.log(`  ${item.payment._id} | ${formatMoney(item.payment.amount)} | ${item.payment.kind} | marcado como healthy (patient existe)`);
  }
}

if (operations.length === 0) {
  console.log('✅ Nenhuma operação a executar.');
  await mongoose.disconnect();
  process.exit(0);
}

if (DRY_RUN) {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  DRY-RUN: nada foi alterado');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`\nPara executar: node scripts/tratar-payments-orfaos-legado.mjs --op=${OPERATION} --confirm`);
  await mongoose.disconnect();
  process.exit(0);
}

// Backup antes de executar
const backupPath = join(backupsDir, `payments-legacy-treatment-${OPERATION}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const paymentIds = operations.filter(o => o.collection !== 'sessions').map(o => toObjectId(o.paymentId));
const originalPayments = await payments.find({ _id: { $in: paymentIds } }).toArray();
await fs.writeFile(backupPath, JSON.stringify({
  treatedAt: new Date().toISOString(),
  operation: OPERATION,
  operations,
  originalPayments
}, null, 2));
console.log(`\n💾 Backup salvo em: ${backupPath}`);

// Executa as operações
let updatedPayments = 0;
let updatedSessions = 0;

for (const op of operations) {
  const collection = op.collection === 'sessions' ? sessions : payments;
  const id = toObjectId(op.paymentId);
  const result = await collection.updateOne({ _id: id }, op.update);

  if (op.collection === 'sessions') {
    if (result.modifiedCount > 0) updatedSessions++;
  } else {
    if (result.modifiedCount > 0) updatedPayments++;
  }
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('  RESULTADO');
console.log('══════════════════════════════════════════════════════════');
console.log(`Payments atualizados: ${updatedPayments}`);
console.log(`Sessions atualizadas: ${updatedSessions}`);
console.log(`Operação: ${OPERATION}`);
console.log(`Backup: ${backupPath}`);

await mongoose.disconnect();
