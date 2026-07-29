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
const users = db.collection('users');

const backupsDir = join(__dirname, '../../backups-mongo');
const files = (await fs.readdir(backupsDir))
  .filter(f => f.startsWith('orphan-payments-report-') && f.endsWith('.json'))
  .sort()
  .reverse();

if (files.length === 0) {
  console.error('❌ Nenhum relatório de orphan payments encontrado');
  process.exit(1);
}

const reportPath = join(backupsDir, files[0]);
console.log(`📄 Relatório: ${files[0]}\n`);

const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
const paidInvestigate = (report.investigate || []).filter(p => p.status === 'paid');

console.log(`Investigando ${paidInvestigate.length} payments paid em investigar...\n`);

const enriched = [];
for (const p of paidInvestigate) {
  const pay = p._id ? await payments.findOne({ _id: toObjectId(p._id) }) : null;
  const paymentPatientId = pay?.patient?.toString?.() || pay?.patientId || p.patient;
  const paymentAppointmentId = pay?.appointment?.toString?.() || pay?.appointmentId || p.appointment;
  const paymentSessionId = pay?.session?.toString?.() || pay?.sessionId || p.session;
  const paymentPackageId = pay?.package?.toString?.() || pay?.packageId || p.package;

  const patient = paymentPatientId ? await patients.findOne({ _id: toObjectId(paymentPatientId) }) : null;
  const appointment = paymentAppointmentId ? await appointments.findOne({ _id: toObjectId(paymentAppointmentId) }) : null;
  const session = paymentSessionId ? await sessions.findOne({ _id: toObjectId(paymentSessionId) }) : null;
  const pkg = paymentPackageId ? await packages.findOne({ _id: toObjectId(paymentPackageId) }) : null;
  const createdBy = pay?.createdBy ? await users.findOne({ _id: toObjectId(pay.createdBy) }) : null;

  const sessionPatientId = session?.patient?.toString?.() || session?.patientId;
  const appointmentPatientId = appointment?.patient?.toString?.() || appointment?.patientId;
  const packagePatientId = pkg?.patientId?.toString?.() || pkg?.patient?.toString?.();

  const linkedPatientIds = [
    paymentPatientId,
    sessionPatientId,
    appointmentPatientId,
    packagePatientId
  ].filter(Boolean);
  const uniquePatientIds = [...new Set(linkedPatientIds)];
  const patientMismatch = uniquePatientIds.length > 1;

  let suggestion = 'revisao_manual';

  if (!patient && !appointment && !session && !pkg) {
    suggestion = 'lixo_confirmado';
  } else if (p.amount === 1 && pay?.notes?.includes('RECONCILIAÇÃO')) {
    suggestion = 'lixo_confirmado';
  } else if (p.kind === 'manual' && !appointment && session && ['130', '150'].includes(String(p.amount))) {
    suggestion = 'lixo_confirmado';
  } else if (patient && !patientMismatch) {
    suggestion = 'relink_possivel';
  } else if (sessionPatientId && !patient && !patientMismatch) {
    const realPatient = await patients.findOne({ _id: toObjectId(sessionPatientId) });
    if (realPatient) {
      suggestion = 'relink_para_session_patient';
    } else {
      suggestion = 'legado_patient_deleted';
    }
  } else if (appointmentPatientId && !patient && !patientMismatch) {
    const realPatient = await patients.findOne({ _id: toObjectId(appointmentPatientId) });
    if (realPatient) {
      suggestion = 'relink_para_appointment_patient';
    } else {
      suggestion = 'legado_patient_deleted';
    }
  } else if (packagePatientId && !patient && !patientMismatch) {
    const realPatient = await patients.findOne({ _id: toObjectId(packagePatientId) });
    if (realPatient) {
      suggestion = 'relink_para_package_patient';
    } else {
      suggestion = 'legado_patient_deleted';
    }
  } else if (patientMismatch) {
    suggestion = 'corrigir_vinculo_inconsistente';
  } else if (!patient && (session || appointment || pkg)) {
    suggestion = 'legado_patient_deleted';
  }

  enriched.push({
    payment: {
      _id: p._id,
      amount: p.amount,
      createdAt: pay?.createdAt || p.createdAt,
      kind: pay?.kind || p.kind,
      status: pay?.status || p.status,
      origin: pay?.origin || null,
      source: pay?.source || null,
      createdBy: createdBy?.name || createdBy?.email || pay?.createdBy || null,
      notes: pay?.notes || null,
      description: pay?.description || null,
      paymentMethod: pay?.paymentMethod || p.paymentMethod,
      paidAt: pay?.paidAt || p.paidAt,
      financialDate: pay?.financialDate || p.financialDate,
      paymentDate: pay?.paymentDate || p.paymentDate,
      patientId: paymentPatientId,
      appointmentId: paymentAppointmentId,
      sessionId: paymentSessionId,
      packageId: paymentPackageId
    },
    patient: patient ? {
      _id: patient._id.toString(),
      fullName: patient.fullName,
      phone: patient.phone
    } : null,
    appointment: appointment ? {
      _id: appointment._id.toString(),
      date: appointment.date,
      time: appointment.time,
      operationalStatus: appointment.operationalStatus,
      patientId: appointmentPatientId
    } : null,
    session: session ? {
      _id: session._id.toString(),
      date: session.date,
      time: session.time,
      status: session.status,
      sessionValue: session.sessionValue,
      patientId: sessionPatientId
    } : null,
    package: pkg ? {
      _id: pkg._id.toString(),
      specialty: pkg.specialty,
      totalValue: pkg.totalValue,
      status: pkg.status,
      patientId: packagePatientId
    } : null,
    analysis: {
      patientExists: !!patient,
      appointmentExists: !!appointment,
      sessionExists: !!session,
      packageExists: !!pkg,
      uniquePatientIds,
      patientMismatch,
      suggestion
    }
  });
}

const bySuggestion = enriched.reduce((acc, item) => {
  const s = item.analysis.suggestion;
  acc[s] = acc[s] || { count: 0, total: 0, items: [] };
  acc[s].count++;
  acc[s].total += (item.payment.amount || 0);
  acc[s].items.push(item);
  return acc;
}, {});

console.log('══════════════════════════════════════════════════════════');
console.log('  CLASSIFICAÇÃO SUGERIDA DOS 22 PAYMENTS PAID');
console.log('══════════════════════════════════════════════════════════\n');

for (const [suggestion, data] of Object.entries(bySuggestion)) {
  console.log(`\n${suggestion}: ${data.count} | ${formatMoney(data.total)}`);
  for (const item of data.items) {
    const p = item.payment;
    console.log(`  ${p._id} | ${formatMoney(p.amount)} | ${p.kind} | ${p.paymentMethod}`);
    console.log(`    createdAt: ${p.createdAt}`);
    console.log(`    patientExists: ${item.analysis.patientExists} | apptExists: ${item.analysis.appointmentExists} | sessionExists: ${item.analysis.sessionExists} | pkgExists: ${item.analysis.packageExists}`);
    console.log(`    mismatch: ${item.analysis.patientMismatch} | uniquePatientIds: [${item.analysis.uniquePatientIds.join(', ')}]`);
  }
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('  DETALHES COMPLETOS');
console.log('══════════════════════════════════════════════════════════');

for (const item of enriched) {
  const p = item.payment;
  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`Payment: ${p._id}`);
  console.log(`  Valor: ${formatMoney(p.amount)}`);
  console.log(`  Status: ${p.status}`);
  console.log(`  Kind: ${p.kind}`);
  console.log(`  Método: ${p.paymentMethod}`);
  console.log(`  Criado em: ${p.createdAt}`);
  console.log(`  Pago em: ${p.paidAt || p.paymentDate || p.financialDate}`);
  console.log(`  Origin: ${p.origin || '-'}`);
  console.log(`  Source: ${p.source || '-'}`);
  console.log(`  Criado por: ${p.createdBy || '-'}`);
  console.log(`  Notes: ${p.notes || '-'}`);
  console.log(`  Description: ${p.description || '-'}`);
  console.log(`  Sugestão: ${item.analysis.suggestion}`);

  console.log(`  Patient (payment): ${p.patientId || '-'} | existe=${item.analysis.patientExists}`);
  if (item.patient) {
    console.log(`    Nome: ${item.patient.fullName} | Tel: ${item.patient.phone || '-'}`);
  }

  console.log(`  Appointment (payment): ${p.appointmentId || '-'} | existe=${item.analysis.appointmentExists}`);
  if (item.appointment) {
    console.log(`    Data: ${item.appointment.date} ${item.appointment.time} | status=${item.appointment.operationalStatus} | patientId=${item.appointment.patientId}`);
  }

  console.log(`  Session (payment): ${p.sessionId || '-'} | existe=${item.analysis.sessionExists}`);
  if (item.session) {
    console.log(`    Data: ${item.session.date} ${item.session.time} | status=${item.session.status} | sessionValue=${item.session.sessionValue} | patientId=${item.session.patientId}`);
  }

  console.log(`  Package (payment): ${p.packageId || '-'} | existe=${item.analysis.packageExists}`);
  if (item.package) {
    console.log(`    Specialty: ${item.package.specialty} | totalValue=${item.package.totalValue} | status=${item.package.status} | patientId=${item.package.patientId}`);
  }
}

const outputPath = join(backupsDir, `paid-orphans-detailed-22-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(outputPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourceReport: files[0],
  total: paidInvestigate.length,
  totalValue: paidInvestigate.reduce((s, p) => s + (p.amount || 0), 0),
  bySuggestion,
  items: enriched
}, null, 2));

console.log(`\n\n💾 Relatório completo salvo em: ${outputPath}`);

await mongoose.disconnect();
