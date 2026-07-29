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
const investigate = (data.investigate || []).filter(p => p.status === 'paid');

if (investigate.length === 0) {
  console.log('✅ Nenhum payment paid na categoria investigar.');
  await mongoose.disconnect();
  process.exit(0);
}

const totalPaidOrphan = investigate.reduce((s, p) => s + (p.amount || 0), 0);
console.log(`💸 Payments paid órfãos: ${investigate.length}`);
console.log(`💰 Valor total: R$ ${totalPaidOrphan.toFixed(2)}\n`);

// Simula se esses payments entram no caixa hoje, ontem, este mês, etc.
const today = new Date();
const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

const toISODate = (d) => d.toISOString().slice(0, 10);

const ranges = {
  today: { start: toISODate(today), end: toISODate(today) },
  yesterday: { start: toISODate(yesterday), end: toISODate(yesterday) },
  thisMonth: { start: toISODate(startOfMonth), end: toISODate(endOfMonth) }
};

// Verifica quais payments entram no caixa real (mesmo match do calculateCash)
const cashMatch = {
  status: 'paid',
  amount: { $gt: 0 },
  kind: { $ne: 'package_consumed' },
  $and: [
    {
      $or: [
        { isFromPackage: { $ne: true } },
        { kind: 'session_payment' }
      ]
    }
  ]
};

const ids = investigate.map(p => new mongoose.Types.ObjectId(p._id));
const realPayments = await payments.find({
  _id: { $in: ids },
  ...cashMatch
}).toArray();

console.log(`✅ Dessas, ${realPayments.length} entram no cálculo do caixa (match calculateCash)`);
console.log(`💰 Impacto real no caixa: R$ ${realPayments.reduce((s, p) => s + (p.amount || 0), 0).toFixed(2)}\n`);

// Agrupa por dia
const byDay = {};
for (const p of realPayments) {
  const d = p.financialDate || p.paymentDate || p.createdAt;
  const day = d ? new Date(d).toISOString().slice(0, 10) : 'sem-data';
  byDay[day] = byDay[day] || { count: 0, total: 0 };
  byDay[day].count++;
  byDay[day].total += (p.amount || 0);
}

console.log('══════════════════════════════════════════════════════════');
console.log('  IMPACTO POR DIA (payments que entram no caixa)');
console.log('══════════════════════════════════════════════════════════');
for (const [day, val] of Object.entries(byDay).sort()) {
  console.log(`  ${day} | ${String(val.count).padStart(3)} | R$ ${val.total.toFixed(2)}`);
}

// Impacto por período
console.log('\n══════════════════════════════════════════════════════════');
console.log('  IMPACTO POR PERÍODO');
console.log('══════════════════════════════════════════════════════════');
for (const [label, range] of Object.entries(ranges)) {
  const affected = realPayments.filter(p => {
    const d = p.financialDate || p.paymentDate || p.createdAt;
    if (!d) return false;
    const day = new Date(d).toISOString().slice(0, 10);
    return day >= range.start && day <= range.end;
  });
  const total = affected.reduce((s, p) => s + (p.amount || 0), 0);
  console.log(`  ${label.padEnd(12)} | ${String(affected.length).padStart(3)} | R$ ${total.toFixed(2)}`);
}

// Salva baseline
const baselinePath = join(backupsDir, `orphan-payments-baseline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(baselinePath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourceReport: reportFiles[0],
  totalPaidOrphan: investigate.length,
  totalPaidOrphanValue: totalPaidOrphan,
  entersCashflowCount: realPayments.length,
  entersCashflowValue: realPayments.reduce((s, p) => s + (p.amount || 0), 0),
  byDay,
  payments: realPayments.map(p => ({
    _id: p._id.toString(),
    amount: p.amount,
    financialDate: p.financialDate,
    paymentDate: p.paymentDate,
    createdAt: p.createdAt,
    kind: p.kind,
    billingType: p.billingType,
    paymentMethod: p.paymentMethod
  }))
}, null, 2));

console.log(`\n💾 Baseline salva em: ${baselinePath}`);

await mongoose.disconnect();
