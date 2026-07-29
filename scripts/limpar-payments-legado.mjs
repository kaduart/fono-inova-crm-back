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
const GROUP = args.find(a => a.startsWith('--group='))?.split('=')[1] || 'all';
const VALID_GROUPS = ['manual-fantasma', 'reconciliacao-1-real', 'session-divergentes', 'package-receipt', 'all'];

if (!VALID_GROUPS.includes(GROUP)) {
  console.error(`Grupo inválido: ${GROUP}`);
  console.error(`Válidos: ${VALID_GROUPS.join(', ')}`);
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
const classificationFiles = (await fs.readdir(backupsDir))
  .filter(f => f.startsWith('paid-orphans-classification-') && f.endsWith('.json'))
  .sort()
  .reverse();

if (classificationFiles.length === 0) {
  console.error('❌ Nenhum arquivo de classificação encontrado em backups-mongo/');
  process.exit(1);
}

const classificationPath = join(backupsDir, classificationFiles[0]);
console.log(`📄 Usando classificação: ${classificationFiles[0]}\n`);

const classification = JSON.parse(await fs.readFile(classificationPath, 'utf8'));
const items = classification.categories?.RELINK_OU_ANONIMIZAR?.items || [];

async function classifyItem(p) {
  const payId = toObjectId(p._id);
  const pay = payId ? await payments.findOne({ _id: payId }) : null;
  const appointment = p.refs?.appointment?.id ? await appointments.findOne({ _id: toObjectId(p.refs.appointment.id) }) : null;
  const session = p.refs?.session?.id ? await sessions.findOne({ _id: toObjectId(p.refs.session.id) }) : null;
  const pkg = p.refs?.package?.id ? await packages.findOne({ _id: toObjectId(p.refs.package.id) }) : null;

  const paymentPatientId = pay?.patient?.toString?.() || pay?.patientId || p.refs?.patient?.id;
  const sessionPatientId = session?.patient?.toString?.() || session?.patientId;
  const appointmentPatientId = appointment?.patient?.toString?.() || appointment?.patientId;
  const packagePatientId = pkg?.patientId?.toString?.() || pkg?.patient?.toString?.();

  const ids = [paymentPatientId, sessionPatientId, appointmentPatientId, packagePatientId].filter(Boolean);
  const uniqueIds = [...new Set(ids)];
  const hasDivergence = uniqueIds.length > 1;

  // Grupo 1: manual fantasma
  if (p.kind === 'manual' && !appointment && session && ['130', '150'].includes(String(p.amount))) {
    return 'manual-fantasma';
  }

  // Grupo 2: reconciliação R$ 1
  if (p.amount === 1 && pay?.notes?.includes('RECONCILIAÇÃO')) {
    return 'reconciliacao-1-real';
  }

  // Grupo 4: package_receipt
  if (p.kind === 'package_receipt') {
    return 'package-receipt';
  }

  // Grupo 3: session_payment com divergência de patientId
  if (p.kind === 'session_payment' && hasDivergence) {
    return 'session-divergentes';
  }

  return 'uncategorized';
}

const classified = [];
for (const p of items) {
  const group = await classifyItem(p);
  classified.push({ ...p, group });
}

function printGroup(name, label) {
  const groupItems = classified.filter(c => c.group === name);
  if (groupItems.length === 0) {
    console.log(`\n═══ ${label}: 0 itens ═══`);
    return groupItems;
  }

  const total = groupItems.reduce((s, p) => s + (p.amount || 0), 0);
  console.log(`\n═══ ${label}: ${groupItems.length} itens | ${formatMoney(total)} ═══`);

  for (const p of groupItems) {
    console.log(`  ${p._id} | ${formatMoney(p.amount)} | ${p.kind} | ${p.paymentMethod}`);
    console.log(`    paymentDate: ${p.paymentDate || p.paidAt || p.financialDate || p.createdAt}`);
    console.log(`    refs: patient=${p.refs?.patient?.exists} appt=${p.refs?.appointment?.exists} session=${p.refs?.session?.exists} pkg=${p.refs?.package?.exists}`);
  }
  return groupItems;
}

const groupsToProcess = GROUP === 'all'
  ? ['manual-fantasma', 'reconciliacao-1-real']
  : [GROUP];

console.log('══════════════════════════════════════════════════════════');
console.log('  ANÁLISE DOS GRUPOS');
console.log('══════════════════════════════════════════════════════════');

printGroup('manual-fantasma', 'Grupo 1 — manual fantasma');
printGroup('reconciliacao-1-real', 'Grupo 2 — reconciliação R$ 1');
printGroup('session-divergentes', 'Grupo 3 — session_payment divergentes');
printGroup('package-receipt', 'Grupo 4 — package_receipt');
const uncategorized = printGroup('uncategorized', 'Não classificados');

if (uncategorized.length > 0) {
  console.log('\n⚠️  Atenção: itens não classificados não serão tocados.');
}

const targetItems = classified.filter(c => groupsToProcess.includes(c.group));

if (targetItems.length === 0) {
  console.log(`\n✅ Nenhum item do grupo "${GROUP}" para processar.`);
  await mongoose.disconnect();
  process.exit(0);
}

const totalValue = targetItems.reduce((s, p) => s + (p.amount || 0), 0);

console.log('\n══════════════════════════════════════════════════════════');
console.log(`  AÇÃO: ${DRY_RUN ? 'DRY-RUN' : 'CONFIRMAÇÃO'}`);
console.log(`  Grupo: ${GROUP}`);
console.log(`  Itens a ${DRY_RUN ? 'simular' : 'deletar'}: ${targetItems.length}`);
console.log(`  Valor total: ${formatMoney(totalValue)}`);
console.log('══════════════════════════════════════════════════════════');

if (DRY_RUN) {
  console.log('\n⚠️  MODO SIMULAÇÃO. Nada foi alterado.');
  console.log(`   Para executar a deleção, rode com: --group=${GROUP} --confirm`);
  await mongoose.disconnect();
  process.exit(0);
}

// Backup antes de deletar
const backupPath = join(backupsDir, `payments-deleted-${GROUP}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const fullDocs = await payments.find({ _id: { $in: targetItems.map(p => toObjectId(p._id)).filter(Boolean) } }).toArray();
await fs.writeFile(backupPath, JSON.stringify({
  deletedAt: new Date().toISOString(),
  group: GROUP,
  count: fullDocs.length,
  total: totalValue,
  classificationFile: classificationFiles[0],
  payments: fullDocs
}, null, 2));

console.log(`\n💾 Backup salvo em: ${backupPath}`);

const idsToDelete = targetItems.map(p => toObjectId(p._id)).filter(Boolean);
const result = await payments.deleteMany({ _id: { $in: idsToDelete } });

console.log(`\n✅ Deletados: ${result.deletedCount}/${idsToDelete.length} payments`);
console.log(`   Grupo: ${GROUP}`);
console.log(`   Valor: ${formatMoney(totalValue)}`);

await mongoose.disconnect();
