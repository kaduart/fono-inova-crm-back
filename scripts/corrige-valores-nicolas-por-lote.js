#!/usr/bin/env node
/**
 * Corrige valores dos payments/batches do Nicolas Lucca com base na DATA DE ENVIO
 * DO LOTE (sentDate), não na data da sessão. Regra: enviado antes de 01/06/2026 =
 * R$ 80,00; enviado a partir de 01/06/2026 = R$ 100,00.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import '../models/index.js';
import Payment from '../models/Payment.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import Session from '../models/Session.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGODB_URI nao configurado'); process.exit(1); }

const DRY_RUN = process.argv.includes('--dry-run');
const PATIENT_ID = '69655746dcdf49e2c282800b';
const patientOid = new mongoose.Types.ObjectId(PATIENT_ID);
const CUTOFF = new Date('2026-06-01T00:00:00-03:00');

function valorPorDataEnvio(sentDate) {
  return new Date(sentDate) >= CUTOFF ? 100 : 80;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Conectado ao MongoDB');
  console.log(DRY_RUN ? '\n=== MODO DRY-RUN ===' : '\n=== MODO EXECUCAO ===');

  const payments = await Payment.find({
    patient: patientOid,
    billingType: 'convenio',
    status: { $nin: ['cancelled', 'canceled'] }
  }).lean();

  const backupDir = path.join(process.cwd(), 'backups-mongo', `corrige-valores-nicolas-por-lote-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'payments-backup.json'), JSON.stringify(payments, null, 2));

  const sessionIds = payments.map(p => p.session).filter(Boolean);
  const batches = await InsuranceBatch.find({ 'sessions.session': { $in: sessionIds } }).lean();
  fs.writeFileSync(path.join(backupDir, 'batches-backup.json'), JSON.stringify(batches, null, 2));
  console.log(`Backup salvo em: ${backupDir}`);

  const sessionDateById = Object.fromEntries(
    (await Session.find({ _id: { $in: sessionIds } }).select('date').lean())
      .map(s => [s._id.toString(), s.date])
  );

  const batchBySession = {};
  for (const b of batches) {
    for (const s of b.sessions || []) {
      batchBySession[s.session?.toString?.()] = { batch: b, batchSession: s };
    }
  }

  const paymentPlan = [];
  for (const p of payments) {
    const sid = p.session?.toString?.();
    const entry = batchBySession[sid];
    if (!entry) continue;
    const sentDate = entry.batch.sentDate;
    if (!sentDate) continue;
    const novoValor = valorPorDataEnvio(sentDate);
    const atualAmount = p.amount;
    const atualGross = p.insurance?.grossAmount;
    if (atualAmount === novoValor && (atualGross === novoValor || atualGross === undefined || atualGross === null)) continue;
    paymentPlan.push({
      paymentId: p._id.toString(),
      sessionId: sid,
      sessionDate: sessionDateById[sid],
      sentDate,
      oldAmount: atualAmount,
      oldGross: atualGross,
      newValue: novoValor
    });
  }

  const batchPlan = [];
  for (const b of batches) {
    const novoValor = valorPorDataEnvio(b.sentDate);
    const affected = [];
    for (const s of b.sessions || []) {
      if (s.grossAmount !== novoValor) {
        affected.push({ session: s.session?.toString?.(), old: s.grossAmount, new: novoValor });
      }
    }
    if (affected.length) {
      batchPlan.push({ batchId: b._id.toString(), batchNumber: b.batchNumber, sentDate: b.sentDate, affected });
    }
  }

  console.log(`\nPayments a corrigir: ${paymentPlan.length}`);
  paymentPlan.slice(0, 20).forEach(p => console.log(`  ${p.paymentId} sessao ${p.sessionId} enviado ${new Date(p.sentDate).toISOString()}: ${p.oldAmount}/${p.oldGross} -> ${p.newValue}`));
  if (paymentPlan.length > 20) console.log(`  ... e mais ${paymentPlan.length - 20}`);

  console.log(`\nBatches a corrigir: ${batchPlan.length}`);
  batchPlan.forEach(b => {
    console.log(`  ${b.batchNumber} enviado ${new Date(b.sentDate).toISOString()}: ${b.affected.length} sessoes`);
  });

  if (DRY_RUN) {
    console.log('\nDry-run finalizado. Nenhuma alteracao realizada.');
    await mongoose.disconnect();
    return;
  }

  for (const p of paymentPlan) {
    await Payment.findByIdAndUpdate(p.paymentId, {
      $set: {
        amount: p.newValue,
        'insurance.grossAmount': p.newValue,
        updatedAt: new Date()
      }
    });
  }
  console.log(`\n${paymentPlan.length} payments atualizados.`);

  for (const bp of batchPlan) {
    const batch = await InsuranceBatch.findById(bp.batchId);
    if (!batch) continue;
    for (const s of batch.sessions) {
      s.grossAmount = valorPorDataEnvio(batch.sentDate);
    }
    batch.totalGross = batch.sessions.reduce((sum, s) => sum + (s.grossAmount || 0), 0);
    batch.totalNet = batch.totalGross;
    batch.totalSessions = batch.sessions.length;
    await batch.save();
    console.log(`Batch ${batch.batchNumber} (enviado ${batch.sentDate}) atualizado: totalGross=${batch.totalGross}`);
  }

  console.log('Correcao finalizada.');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
