// scripts/fix-benjamim-guia-16145509-batch-removal.js
// Remove as 2 sessões órfãs (26/05 e 29/05) do Benjamim Rocha Simão do lote genérico
// LOT-CONVENIO-1781791840385, revertendo-as para pending_billing — mesmo padrão
// aplicado ao caso Joaquim Rocha Simão (2026-07-20), mesmo lote, mesma causa raiz
// (buildBatchFromGuides sem filtro de data).
//
// Uso: node scripts/fix-benjamim-guia-16145509-batch-removal.js           (dry-run)
//      node scripts/fix-benjamim-guia-16145509-batch-removal.js --apply   (executa)

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const APPLY = process.argv.includes('--apply');

const BATCH_ID = new mongoose.Types.ObjectId('6a33fc600e0535d53e7c4f6c');
const SESSION_IDS = [
  new mongoose.Types.ObjectId('6a14ae6fdf43507213eaa8c1'),
  new mongoose.Types.ObjectId('6a14ae6fdf43507213eaa8c2')
];

async function main() {
  await mongoose.connect(MONGO_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 30000 });

  const InsuranceBatch = mongoose.connection.collection('insurancebatches');
  const Session = mongoose.connection.collection('sessions');
  const Payment = mongoose.connection.collection('payments');

  const batch = await InsuranceBatch.findOne({ _id: BATCH_ID });
  if (!batch) throw new Error('Lote não encontrado');

  const removedEntries = batch.sessions.filter(e => SESSION_IDS.some(id => id.equals(e.session)));
  const keptEntries = batch.sessions.filter(e => !SESSION_IDS.some(id => id.equals(e.session)));

  if (removedEntries.length !== SESSION_IDS.length) {
    throw new Error(`Esperava 2 entradas no lote, encontrei ${removedEntries.length}`);
  }

  const grossRemoved = removedEntries.reduce((sum, e) => sum + (e.grossAmount || 0), 0);
  const netRemoved = removedEntries.reduce((sum, e) => sum + (e.netAmount || 0), 0);

  console.log(`Lote ${batch.batchNumber}:`);
  console.log(`  totalSessions: ${batch.totalSessions} -> ${batch.totalSessions - removedEntries.length}`);
  console.log(`  totalGross:    ${batch.totalGross} -> ${batch.totalGross - grossRemoved}`);
  console.log(`  totalNet:      ${batch.totalNet} -> ${batch.totalNet - netRemoved}`);

  const sessions = await Session.find({ _id: { $in: SESSION_IDS } }).toArray();
  for (const s of sessions) {
    console.log(`  Session ${s._id}: billingBatchId ${s.billingBatchId} -> null`);
  }

  const payments = await Payment.find({ session: { $in: SESSION_IDS } }).toArray();
  for (const p of payments) {
    console.log(`  Payment ${p._id}: insurance.status ${p.insurance?.status} -> pending_billing`);
  }

  if (!APPLY) {
    console.log('\n[DRY-RUN] Nenhuma escrita realizada. Rode com --apply para executar.');
    await mongoose.disconnect();
    return;
  }

  await InsuranceBatch.updateOne(
    { _id: BATCH_ID },
    {
      $set: {
        sessions: keptEntries,
        totalSessions: batch.totalSessions - removedEntries.length,
        totalGross: batch.totalGross - grossRemoved,
        totalNet: batch.totalNet - netRemoved
      }
    }
  );

  await Session.updateMany(
    { _id: { $in: SESSION_IDS } },
    { $set: { billingBatchId: null } }
  );

  await Payment.updateMany(
    { session: { $in: SESSION_IDS } },
    {
      $set: { 'insurance.status': 'pending_billing' },
      $unset: { 'insurance.billedAt': '', billedAt: '' }
    }
  );

  console.log('\n[APPLY] Alterações gravadas.');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
