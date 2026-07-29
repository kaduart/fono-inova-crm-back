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

await mongoose.connect(mongoUri);
const db = mongoose.connection.db;
const payments = db.collection('payments');
const appointments = db.collection('appointments');
const patients = db.collection('patients');
const sessions = db.collection('sessions');
const packages = db.collection('packages');

const backupsDir = join(__dirname, '../../backups-mongo');
const files = await fs.readdir(backupsDir);
const reportFiles = files
  .filter(f => f.startsWith('orphan-payments-report-') && f.endsWith('.json'))
  .sort()
  .reverse();

if (reportFiles.length === 0) {
  console.error('❌ Nenhum relatório de orphan payments encontrado');
  process.exit(1);
}

const latestReport = join(backupsDir, reportFiles[0]);
console.log(`📄 Relatório: ${reportFiles[0]}\n`);

const data = JSON.parse(await fs.readFile(latestReport, 'utf8'));
const paidOrphans = (data.investigate || []).filter(p => p.status === 'paid');

if (paidOrphans.length === 0) {
  console.log('✅ Nenhum payment paid órfão encontrado.');
  await mongoose.disconnect();
  process.exit(0);
}

console.log(`💸 Payments paid órfãos: ${paidOrphans.length}`);
console.log(`💰 Valor total: R$ ${paidOrphans.reduce((s, p) => s + (p.amount || 0), 0).toFixed(2)}\n`);

// Enriquecer com dados reais do banco
const enriched = [];
for (const p of paidOrphans) {
  const pay = await payments.findOne({ _id: new mongoose.Types.ObjectId(p._id) });
  const patient = p.patient ? await patients.findOne({ _id: new mongoose.Types.ObjectId(p.patient) }) : null;
  const appointment = p.appointment ? await appointments.findOne({ _id: new mongoose.Types.ObjectId(p.appointment) }) : null;
  const session = p.session ? await sessions.findOne({ _id: new mongoose.Types.ObjectId(p.session) }) : null;
  const pkg = p.package ? await packages.findOne({ _id: new mongoose.Types.ObjectId(p.package) }) : null;

  const hasPatient = !!patient;
  const hasAppointment = !!appointment;
  const hasSession = !!session;
  const hasPackage = !!pkg;

  let category;
  if (!hasPatient && !hasAppointment && !hasSession && !hasPackage) {
    category = 'DELETE_SEGURO';
  } else if (!hasPatient && (hasSession || hasPackage)) {
    category = 'RELINK_OU_ANONIMIZAR';
  } else {
    category = 'REVISAO_MANUAL';
  }

  enriched.push({
    _id: p._id,
    amount: p.amount,
    status: p.status,
    kind: p.kind,
    paymentMethod: p.paymentMethod,
    billingType: p.billingType,
    source: p.source,
    description: p.description,
    notes: p.notes,
    createdAt: p.createdAt,
    paidAt: p.paidAt,
    financialDate: p.financialDate,
    paymentDate: p.paymentDate,
    createdBy: p.createdBy,
    createdByExists: p.createdByExists,
    refs: {
      patient: { id: p.patient, exists: hasPatient, name: patient?.fullName || null },
      appointment: { id: p.appointment, exists: hasAppointment, date: appointment?.date || null, time: appointment?.time || null },
      session: { id: p.session, exists: hasSession, date: session?.date || null, time: session?.time || null },
      package: { id: p.package, exists: hasPackage, specialty: pkg?.specialty || null, totalValue: pkg?.totalValue || null }
    },
    category,
    raw: pay
  });
}

const byCategory = enriched.reduce((acc, p) => {
  acc[p.category] = acc[p.category] || { count: 0, total: 0, items: [] };
  acc[p.category].count++;
  acc[p.category].total += (p.amount || 0);
  acc[p.category].items.push(p);
  return acc;
}, {});

console.log('══════════════════════════════════════════════════════════');
console.log('  CLASSIFICAÇÃO DOS PAYMENTS PAID ÓRFÃOS');
console.log('══════════════════════════════════════════════════════════');

for (const [category, data] of Object.entries(byCategory)) {
  console.log(`\n${category}: ${data.count} payments | R$ ${data.total.toFixed(2)}`);
  for (const p of data.items) {
    console.log(`  ${p._id} | R$ ${String(p.amount).padStart(7)} | ${String(p.kind).padEnd(20)} | patient=${p.refs.patient.exists} appt=${p.refs.appointment.exists} session=${p.refs.session.exists} pkg=${p.refs.package.exists}`);
  }
}

// Detalhes da categoria RELINK/ANONIMIZAR
if (byCategory.RELINK_OU_ANONIMIZAR) {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  DETALHES — RELINK_OU_ANONIMIZAR');
  console.log('══════════════════════════════════════════════════════════');
  for (const p of byCategory.RELINK_OU_ANONIMIZAR.items) {
    console.log(`\n  ${p._id}`);
    console.log(`    Valor:        R$ ${p.amount}`);
    console.log(`    Data pagto:   ${p.paymentDate || p.paidAt || p.createdAt}`);
    console.log(`    Método:       ${p.paymentMethod}`);
    console.log(`    Kind:         ${p.kind}`);
    console.log(`    Paciente:     ${p.refs.patient.exists ? p.refs.patient.name : 'INEXISTENTE'}`);
    console.log(`    Appointment:  ${p.refs.appointment.exists ? `${p.refs.appointment.date} ${p.refs.appointment.time}` : 'inexistente'}`);
    console.log(`    Session:      ${p.refs.session.exists ? `${p.refs.session.date} ${p.refs.session.time}` : 'inexistente'}`);
    console.log(`    Package:      ${p.refs.package.exists ? `${p.refs.package.specialty} (R$ ${p.refs.package.totalValue})` : 'inexistente'}`);
  }
}

// Salvar análise
const analysisPath = join(backupsDir, `paid-orphans-classification-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(analysisPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourceReport: reportFiles[0],
  totalPaidOrphans: paidOrphans.length,
  totalValue: paidOrphans.reduce((s, p) => s + (p.amount || 0), 0),
  categories: byCategory
}, null, 2));

console.log(`\n💾 Análise salva em: ${analysisPath}`);

await mongoose.disconnect();
