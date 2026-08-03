#!/usr/bin/env node
/**
 * Corrige valores dos payments/batches do Nicolas Lucca para sessões ANTES de
 * 01/06/2026: de R$ 100,00 de volta para R$ 80,00. Sessões a partir de junho/2026
 * permanecem em R$ 100,00.
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
const VALOR_ANTIGO = 80;

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Conectado ao MongoDB');
  console.log(DRY_RUN ? '\n=== MODO DRY-RUN ===' : '\n=== MODO EXECUCAO ===');

  const payments = await Payment.find({
    patient: patientOid,
    billingType: 'convenio',
    status: { $nin: ['cancelled', 'canceled'] }
  }).lean();

  // Backup
  const backupDir = path.join(process.cwd(), 'backups-mongo', `corrige-valores-nicolas-antes-junho-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'payments-backup.json'), JSON.stringify(payments, null, 2));

  const sessionIds = payments.map(p => p.session).filter(Boolean);
  const sessions = await Session.find({ _id: { $in: sessionIds } }).select('date').lean();
  const sessionDateById = Object.fromEntries(sessions.map(s => [s._id.toString(), s.date]));

  const paymentPlan = [];
  for (const p of payments) {
    const date = sessionDateById[p.session?.toString?.()] || p.serviceDate;
    if (!date || new Date(date) >= CUTOFF) continue;
    const oldAmount = p.amount;
    const oldGross = p.insurance?.grossAmount;
    if (oldAmount === VALOR_ANTIGO && (oldGross === VALOR_ANTIGO || oldGross === undefined || oldGross === null)) continue;
    paymentPlan.push({
      paymentId: p._id.toString(),
      sessionId: p.session?.toString?.(),
      date,
      oldAmount,
      oldGross,
      newAmount: VALOR_ANTIGO,
      newGross: VALOR_ANTIGO
    });
  }

  // Batches
  const batches = await InsuranceBatch.find({ 'sessions.session': { $in: sessionIds } }).lean();
  fs.writeFileSync(path.join(backupDir, 'batches-backup.json'), JSON.stringify(batches, null, 2));
  console.log(`Backup salvo em: ${backupDir}`);

  const batchPlan = [];
  for (const b of batches) {
    const affected = [];
    for (const s of b.sessions || []) {
      const sid = s.session?.toString?.();
      const date = sessionDateById[sid];
      if (!date || new Date(date) >= CUTOFF) continue;
      if (s.grossAmount !== VALOR_ANTIGO) affected.push({ session: sid, old: s.grossAmount, new: VALOR_ANTIGO });
    }
    if (affected.length) batchPlan.push({ batchId: b._id.toString(), batchNumber: b.batchNumber, affected });
  }

  console.log(`\nPayments a corrigir (< junho/2026): ${paymentPlan.length}`);
  paymentPlan.slice(0, 20).forEach(p => console.log(`  ${p.paymentId} sessao ${p.sessionId} ${new Date(p.date).toISOString()}: ${p.oldAmount}/${p.oldGross} -> ${p.newAmount}`));
  if (paymentPlan.length > 20) console.log(`  ... e mais ${paymentPlan.length - 20}`);

  console.log(`\nBatches a corrigir (< junho/2026): ${batchPlan.length}`);
  batchPlan.forEach(b => {
    console.log(`  ${b.batchNumber} (${b.batchId}): ${b.affected.length} sessoes`);
  });

  if (DRY_RUN) {
    console.log('\nDry-run finalizado. Nenhuma alteracao realizada.');
    await mongoose.disconnect();
    return;
  }

  for (const p of paymentPlan) {
    await Payment.findByIdAndUpdate(p.paymentId, {
      $set: {
        amount: p.newAmount,
        'insurance.grossAmount': p.newGross,
        updatedAt: new Date()
      }
    });
  }
  console.log(`\n${paymentPlan.length} payments atualizados.`);

  for (const bp of batchPlan) {
    const batch = await InsuranceBatch.findById(bp.batchId);
    if (!batch) continue;
    for (const s of batch.sessions) {
      const affected = bp.affected.find(a => a.session === s.session?.toString?.());
      if (affected) s.grossAmount = affected.new;
    }
    batch.totalGross = batch.sessions.reduce((sum, s) => sum + (s.grossAmount || 0), 0);
    batch.totalNet = batch.totalGross;
    batch.totalSessions = batch.sessions.length;
    await batch.save();
    console.log(`Batch ${batch.batchNumber} atualizado: totalGross=${batch.totalGross}`);
  }

  console.log('Correcao finalizada.');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
