/**
 * fix-orphan-paid-payments.js
 *
 * Diagnostica e corrige pagamentos 'paid' que aparecem como órfãos
 * na reconciliação (sem vínculo de session resolvível).
 *
 * CAUSAS CONHECIDAS:
 *   1. Package full/prepaid — payment criado no nível do pacote, sem session link
 *   2. Ghost liminar session_payment (sem isFromPackage) — fonte: liminarHandler
 *   3. Dados de teste (amount < 1)
 *   4. Payment com session link mas session cancelada/inexistente
 *
 * MODO:
 *   dry-run:  node --env-file=.env scripts/fix-orphan-paid-payments.js
 *   execução: node --env-file=.env scripts/fix-orphan-paid-payments.js --fix
 *
 * O que o fix faz:
 *   - Pagamentos de pacote sem isFromPackage → seta isFromPackage: true
 *   - Dados de teste (amount < 1) → status: 'canceled'
 *   - Session link quebrado (session deletada/cancelada) → remove session ref + seta isFromPackage: true
 */

import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('❌ MONGO_URI não definida'); process.exit(1); }

const DRY_RUN = !process.argv.includes('--fix');
console.log(`\nModo: ${DRY_RUN ? '🔍 DRY-RUN (nada será alterado)' : '⚡ EXECUÇÃO REAL'}\n`);

await mongoose.connect(MONGO_URI);
const db = mongoose.connection.db;

// ─── 1. Buscar payments paid sem session link (verdadeiros órfãos candidatos) ───
const candidates = await db.collection('payments').find({
  status: 'paid',
  amount: { $gt: 0 },
  kind: { $ne: 'package_consumed' },
  isFromPackage: { $ne: true },
  $or: [
    { session: { $exists: false } },
    { session: null }
  ]
}).project({
  _id: 1, amount: 1, kind: 1, billingType: 1, paymentMethod: 1,
  financialDate: 1, paymentDate: 1, createdAt: 1,
  patient: 1, doctor: 1, appointment: 1, package: 1,
  notes: 1, isFromPackage: 1, session: 1
}).toArray();

console.log(`📦 Candidatos a orphan (paid, sem session link, sem isFromPackage): ${candidates.length}`);

if (candidates.length === 0) {
  console.log('✅ Nenhum payment órfão encontrado. Nada a corrigir.');
  await mongoose.disconnect();
  process.exit(0);
}

// ─── 2. Enriquecer com dados de package/appointment/patient ───
const packageIds = candidates.map(p => p.package).filter(Boolean);
const appointmentIds = candidates.map(p => p.appointment).filter(Boolean);
const patientIds = candidates.map(p => p.patient).filter(Boolean);

const [packages, appointments, patients] = await Promise.all([
  packageIds.length
    ? db.collection('packages').find({ _id: { $in: packageIds } })
        .project({ _id: 1, model: 1, paymentType: 1, totalValue: 1, totalPaid: 1, type: 1 }).toArray()
    : [],
  appointmentIds.length
    ? db.collection('appointments').find({ _id: { $in: appointmentIds } })
        .project({ _id: 1, status: 1, operationalStatus: 1, paymentStatus: 1 }).toArray()
    : [],
  patientIds.length
    ? db.collection('patients').find({ _id: { $in: patientIds } })
        .project({ _id: 1, fullName: 1 }).toArray()
    : []
]);

const pkgMap = new Map(packages.map(p => [p._id.toString(), p]));
const apptMap = new Map(appointments.map(a => [a._id.toString(), a]));
const patientMap = new Map(patients.map(p => [p._id.toString(), p]));

// ─── 3. Classificar cada payment ───
const groups = {
  packagePayment: [],  // tem package link → isFromPackage: true
  testData: [],        // amount < 1 → cancelar
  brokenAppointment: [], // appointment cancelado sem session → isFromPackage: true
  noContext: []        // sem package, sem appointment → investigar
};

for (const p of candidates) {
  const pkg = p.package ? pkgMap.get(p.package.toString()) : null;
  const appt = p.appointment ? apptMap.get(p.appointment.toString()) : null;
  const patient = p.patient ? patientMap.get(p.patient.toString()) : null;
  const patientName = patient?.fullName || p.patient?.toString() || 'desconhecido';

  const info = {
    _id: p._id,
    amount: p.amount,
    kind: p.kind,
    billingType: p.billingType,
    patientName,
    notes: p.notes,
    pkg,
    appt
  };

  if (p.amount < 1) {
    groups.testData.push(info);
  } else if (pkg) {
    groups.packagePayment.push(info);
  } else if (appt && ['canceled', 'force_cancelled'].includes(appt.operationalStatus || appt.status)) {
    groups.brokenAppointment.push(info);
  } else {
    groups.noContext.push(info);
  }
}

// ─── 4. Relatório ───
console.log('\n══════════════════════════════════════════════');
console.log('DIAGNÓSTICO DE PAYMENTS ÓRFÃOS');
console.log('══════════════════════════════════════════════\n');

console.log(`📦 Payments de pacote (isFromPackage ausente): ${groups.packagePayment.length}`);
for (const p of groups.packagePayment) {
  const pkg = p.pkg;
  console.log(`   [${p._id}] R$${p.amount} | ${p.patientName} | kind=${p.kind} | pkg: model=${pkg.model}, paymentType=${pkg.paymentType}, totalPaid=${pkg.totalPaid}`);
}

console.log(`\n🗑️  Dados de teste (amount < R$1): ${groups.testData.length}`);
for (const p of groups.testData) {
  console.log(`   [${p._id}] R$${p.amount} | ${p.patientName} | kind=${p.kind}`);
}

console.log(`\n💀 Appointment cancelado sem session: ${groups.brokenAppointment.length}`);
for (const p of groups.brokenAppointment) {
  console.log(`   [${p._id}] R$${p.amount} | ${p.patientName} | appt status=${p.appt?.operationalStatus || p.appt?.status}`);
}

console.log(`\n❓ Sem contexto (investigar manualmente): ${groups.noContext.length}`);
for (const p of groups.noContext) {
  console.log(`   [${p._id}] R$${p.amount} | ${p.patientName} | kind=${p.kind} | notes=${p.notes || '-'}`);
}

const totalAmount = candidates.reduce((s, p) => s + p.amount, 0);
console.log(`\n💰 Total em R$: ${totalAmount.toFixed(2)}`);
console.log(`📊 Total de payments: ${candidates.length}`);

if (DRY_RUN) {
  console.log('\n⚠️  DRY-RUN: nenhuma alteração feita.');
  console.log('   Para executar: node --env-file=.env scripts/fix-orphan-paid-payments.js --fix\n');
  await mongoose.disconnect();
  process.exit(0);
}

// ─── 5. EXECUÇÃO DO FIX ───
console.log('\n⚡ Executando correções...\n');

let fixed = 0;
let canceled = 0;
let skipped = 0;

// Fix: packagePayment → isFromPackage: true
if (groups.packagePayment.length > 0) {
  const ids = groups.packagePayment.map(p => p._id);
  const result = await db.collection('payments').updateMany(
    { _id: { $in: ids } },
    { $set: { isFromPackage: true, _fixedAt: new Date(), _fixNote: 'fix-orphan-paid-payments: package sem isFromPackage' } }
  );
  console.log(`✅ Payments de pacote marcados com isFromPackage=true: ${result.modifiedCount}`);
  fixed += result.modifiedCount;
}

// Fix: testData → canceled
if (groups.testData.length > 0) {
  const ids = groups.testData.map(p => p._id);
  const result = await db.collection('payments').updateMany(
    { _id: { $in: ids } },
    { $set: { status: 'canceled', _fixedAt: new Date(), _fixNote: 'fix-orphan-paid-payments: teste (amount < 1)' } }
  );
  console.log(`✅ Dados de teste cancelados: ${result.modifiedCount}`);
  canceled += result.modifiedCount;
}

// Fix: brokenAppointment → isFromPackage: true (remove da conta como sessão real)
if (groups.brokenAppointment.length > 0) {
  const ids = groups.brokenAppointment.map(p => p._id);
  const result = await db.collection('payments').updateMany(
    { _id: { $in: ids } },
    { $set: { isFromPackage: true, _fixedAt: new Date(), _fixNote: 'fix-orphan-paid-payments: appointment cancelado sem session' } }
  );
  console.log(`✅ Payments de appointment cancelado: ${result.modifiedCount}`);
  fixed += result.modifiedCount;
}

// noContext: não tocar
if (groups.noContext.length > 0) {
  console.log(`⚠️  ${groups.noContext.length} payments sem contexto — NÃO alterados. Investigar manualmente.`);
  skipped += groups.noContext.length;
}

console.log('\n══════════════════════════════════════════════');
console.log('RESUMO');
console.log('══════════════════════════════════════════════');
console.log(`Marcados isFromPackage=true: ${fixed}`);
console.log(`Cancelados (teste):           ${canceled}`);
console.log(`Não alterados (investigar):   ${skipped}`);
console.log('══════════════════════════════════════════════\n');

await mongoose.disconnect();
