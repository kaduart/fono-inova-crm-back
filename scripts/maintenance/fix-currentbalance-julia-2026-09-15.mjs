#!/usr/bin/env node
/**
 * Correção pontual: o script repair-julia-boarati-patientbalance-2026-09-15.mjs
 * (Fase A) marcou as 4 duplicatas como isDeleted=true corretamente, mas
 * esqueceu de decrementar currentBalance nessa mesma escrita — deixou o
 * contador em 1200 em vez de 400 (diferença exata de R$800 = 4x R$200).
 *
 * As 12 transações individuais já estão corretas (conferido). Este script
 * só corrige o contador agregado, com compare-and-swap (só aplica se
 * currentBalance ainda estiver exatamente em 1200 — não decide nada).
 *
 * Uso: node scripts/maintenance/fix-currentbalance-julia-2026-09-15.mjs
 */
import 'dotenv/config';
import mongoose from 'mongoose';

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const patientId = new mongoose.Types.ObjectId('6a5a9269ce43485b2af4edbc');
  const coll = db.collection('patientbalances');

  const before = await coll.findOne({ patient: patientId });
  console.log('currentBalance ANTES:', before.currentBalance);

  if (before.currentBalance !== 1200) {
    console.log(`[FIX] currentBalance não está mais em 1200 (está em ${before.currentBalance}) — nada a fazer ou estado mudou, abortando sem gravar.`);
    await mongoose.disconnect();
    return;
  }

  const result = await coll.updateOne(
    { patient: patientId, currentBalance: 1200 },
    { $inc: { currentBalance: -800 }, $set: { lastTransactionAt: new Date() } }
  );
  console.log('matchedCount:', result.matchedCount, 'modifiedCount:', result.modifiedCount);

  const after = await coll.findOne({ patient: patientId });
  console.log('currentBalance DEPOIS:', after.currentBalance, '| totalDebited:', after.totalDebited, '| totalCredited:', after.totalCredited);

  await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
