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
const DELETE_CONFIRMED = args.includes('--delete-confirmed');
const DATE_START = process.env.DATE_START;
const DATE_END = process.env.DATE_END;

await mongoose.connect(mongoUri);

const db = mongoose.connection.db;
const payments = db.collection('payments');
const appointments = db.collection('appointments');
const patients = db.collection('patients');
const sessions = db.collection('sessions');
const packages = db.collection('packages');
const monthlySettlements = db.collection('monthlysettlements');
const insuranceGuides = db.collection('insuranceguides');
const users = db.collection('users');

const query = {};
if (DATE_START || DATE_END) {
  query.createdAt = {};
  if (DATE_START) query.createdAt.$gte = new Date(DATE_START);
  if (DATE_END) query.createdAt.$lte = new Date(DATE_END);
}

console.log('\n🔍 Auditando payments órfãos...');
if (DATE_START || DATE_END) {
  console.log(`   Período: ${DATE_START || 'início'} até ${DATE_END || 'agora'}`);
}

const cursor = payments.find({
  ...query,
  // 🛡️ Ignora payments já tratados em saneamentos legados
  // healthy, relinked, legacy_patient_deleted, manual_review — todos já foram avaliados
  integrityStatus: null
});
const orphans = {
  confirmed_trash: [],
  investigate: [],
  review: []
};

let checked = 0;
for await (const p of cursor) {
  checked++;

  const refs = {
    patient: p.patient ? await patients.findOne({ _id: p.patient }) : null,
    appointment: p.appointment ? await appointments.findOne({ _id: p.appointment }) : null,
    session: p.session ? await sessions.findOne({ _id: p.session }) : null,
    package: p.package ? await packages.findOne({ _id: p.package }) : null,
    monthlySettlement: p.monthlySettlement ? await monthlySettlements.findOne({ _id: p.monthlySettlement }) : null,
    insuranceGuide: p.insuranceGuide ? await insuranceGuides.findOne({ _id: p.insuranceGuide }) : null,
    createdBy: p.createdBy ? await users.findOne({ _id: p.createdBy }) : null
  };

  const missing = {
    patient: p.patient && !refs.patient,
    appointment: p.appointment && !refs.appointment,
    session: p.session && !refs.session,
    package: p.package && !refs.package,
    monthlySettlement: p.monthlySettlement && !refs.monthlySettlement,
    insuranceGuide: p.insuranceGuide && !refs.insuranceGuide
  };

  const hasPatient = !!refs.patient;
  const hasAppointment = !!refs.appointment;
  const hasSession = !!refs.session;
  const hasPackage = !!refs.package;

  // Consideramos órfão quando o vínculo principal (patient) está quebrado.
  // Appointment deletado mas patient existente não é órfão — pode ter sido remoção legítima.
  // Session/package/insuranceGuide são referências secundárias e podem ser nulas legítimamente.
  const missingPatient = p.patient && !refs.patient;
  const missingAppointment = p.appointment && !refs.appointment;
  // Só considera missingAppointment como problema se o patient também não existir
  // ou se houver inconsistência entre referências (tratado por integrityStatus).
  const missingPrincipal = missingPatient || (missingAppointment && !hasPatient);
  const missingSecondary = (p.session && !refs.session) ||
                           (p.package && !refs.package) ||
                           (p.monthlySettlement && !refs.monthlySettlement) ||
                           (p.insuranceGuide && !refs.insuranceGuide);

  // Lixo confirmado: nenhum vínculo principal válido (patient, appointment, session, package).
  // Se existe session ou package, pode ser payment legítimo que perdeu só patient/appointment.
  const isTrash = !hasPatient && !hasAppointment && !hasSession && !hasPackage;
  const needsInvestigation = missingPrincipal || missingSecondary;

  const record = {
    _id: p._id.toString(),
    amount: p.amount,
    status: p.status,
    paymentMethod: p.paymentMethod,
    billingType: p.billingType,
    kind: p.kind,
    source: p.source,
    description: p.description,
    notes: p.notes,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    paidAt: p.paidAt,
    financialDate: p.financialDate,
    createdBy: p.createdBy?.toString(),
    createdByExists: !!refs.createdBy,
    patient: p.patient?.toString(),
    patientExists: hasPatient,
    appointment: p.appointment?.toString(),
    appointmentExists: hasAppointment,
    session: p.session?.toString(),
    sessionExists: !!refs.session,
    package: p.package?.toString(),
    packageExists: !!refs.package,
    monthlySettlement: p.monthlySettlement?.toString(),
    monthlySettlementExists: !missing.monthlySettlement,
    insuranceGuide: p.insuranceGuide?.toString(),
    insuranceGuideExists: !missing.insuranceGuide,
    missingReasons: [
      missingPatient ? 'patient' : null,
      missingAppointment ? 'appointment' : null,
      missingSecondary ? 'secondary-ref' : null
    ].filter(Boolean)
  };

  if (!missingPrincipal && !missingSecondary) {
    // Não é órfão — ignora
  } else if (isTrash) {
    orphans.confirmed_trash.push(record);
  } else if (needsInvestigation) {
    orphans.investigate.push(record);
  } else {
    orphans.review.push(record);
  }
}

const sum = (arr) => arr.reduce((s, p) => s + (p.amount || 0), 0);
const countByStatus = (arr) => arr.reduce((acc, p) => {
  acc[p.status] = acc[p.status] || { count: 0, total: 0 };
  acc[p.status].count++;
  acc[p.status].total += (p.amount || 0);
  return acc;
}, {});

const paidImpact = (arr) => arr
  .filter(p => p.status === 'paid')
  .reduce((s, p) => s + (p.amount || 0), 0);

console.log(`\n📊 Total verificado: ${checked}`);
console.log('\n══════════════════════════════════════════════════════════');
console.log('  RESUMO DE ÓRFÃOS');
console.log('══════════════════════════════════════════════════════════');
console.log(`\n🗑️  Lixo confirmado (nenhuma referência válida): ${orphans.confirmed_trash.length}`);
console.log(`   Valor total: R$ ${sum(orphans.confirmed_trash).toFixed(2)}`);
console.log(`   Impacto caixa (status=paid): R$ ${paidImpact(orphans.confirmed_trash).toFixed(2)}`);
for (const [status, data] of Object.entries(countByStatus(orphans.confirmed_trash))) {
  console.log(`   - ${status}: ${data.count} | R$ ${data.total.toFixed(2)}`);
}

console.log(`\n🔍 Investigar (vínculo principal parcial: patient/appointment): ${orphans.investigate.length}`);
console.log(`   Valor total: R$ ${sum(orphans.investigate).toFixed(2)}`);
console.log(`   Impacto caixa (status=paid): R$ ${paidImpact(orphans.investigate).toFixed(2)}`);
for (const [status, data] of Object.entries(countByStatus(orphans.investigate))) {
  console.log(`   - ${status}: ${data.count} | R$ ${data.total.toFixed(2)}`);
}



console.log(`\n💰 Valor total em risco: R$ ${sum([...orphans.confirmed_trash, ...orphans.investigate, ...orphans.review]).toFixed(2)}`);
console.log(`💸 Impacto financeiro real (status=paid): R$ ${paidImpact([...orphans.confirmed_trash, ...orphans.investigate, ...orphans.review]).toFixed(2)}`);

// Amostra de lixo confirmado para validação manual
if (orphans.confirmed_trash.length > 0) {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  AMOSTRA DE 5 REGISTROS — LIXO CONFIRMADO');
  console.log('══════════════════════════════════════════════════════════');
  for (const p of orphans.confirmed_trash.slice(0, 5)) {
    console.log(`\n  _id:        ${p._id}`);
    console.log(`  amount:     R$ ${p.amount}`);
    console.log(`  status:     ${p.status}`);
    console.log(`  kind:       ${p.kind}`);
    console.log(`  method:     ${p.paymentMethod}`);
    console.log(`  createdAt:  ${p.createdAt}`);
    console.log(`  patient:    ${p.patient || 'null'} | exists=${p.patientExists}`);
    console.log(`  appointment:${p.appointment || 'null'} | exists=${p.appointmentExists}`);
    console.log(`  session:    ${p.session || 'null'} | exists=${p.sessionExists}`);
    console.log(`  package:    ${p.package || 'null'} | exists=${p.packageExists}`);
  }
}

// Enriquecer "investigar" com nome do paciente quando existir
for (const p of orphans.investigate) {
  if (p.patient && p.patientExists) {
    const pat = await patients.findOne({ _id: new mongoose.Types.ObjectId(p.patient) });
    p.patientName = pat?.fullName || null;
  }
}

// Sempre salva relatório completo em JSON
const reportPath = join(__dirname, '../../backups-mongo', `orphan-payments-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.mkdir(dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  summary: {
    totalChecked: checked,
    confirmedTrash: { count: orphans.confirmed_trash.length, total: sum(orphans.confirmed_trash), paid: paidImpact(orphans.confirmed_trash) },
    investigate: { count: orphans.investigate.length, total: sum(orphans.investigate), paid: paidImpact(orphans.investigate) },
    review: { count: orphans.review.length, total: sum(orphans.review), paid: paidImpact(orphans.review) }
  },
  confirmed_trash: orphans.confirmed_trash,
  investigate: orphans.investigate,
  review: orphans.review
}, null, 2));
console.log(`\n💾 Relatório completo salvo em: ${reportPath}`);

if (DELETE_CONFIRMED && orphans.confirmed_trash.length > 0) {
  const backupPath = join(__dirname, '../../backups-mongo', `orphan-payments-confirmed-trash-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.mkdir(dirname(backupPath), { recursive: true });
  await fs.writeFile(backupPath, JSON.stringify(orphans.confirmed_trash, null, 2));

  const ids = orphans.confirmed_trash.map(p => new mongoose.Types.ObjectId(p._id));
  const result = await payments.deleteMany({ _id: { $in: ids } });
  console.log(`\n🗑️  Deletados (lixo confirmado): ${result.deletedCount}/${orphans.confirmed_trash.length}`);
} else if (DELETE_CONFIRMED) {
  console.log('\nℹ️  Nenhum lixo confirmado para deletar.');
} else {
  console.log('\nℹ️  Modo simulação.');
  console.log('   Para deletar só o lixo confirmado:');
  console.log('   node back/scripts/auditoria-payments-orfaos.mjs --delete-confirmed');
}

await mongoose.disconnect();
console.log('\n✅ Auditoria concluída.');
