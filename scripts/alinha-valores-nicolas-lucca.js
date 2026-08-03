#!/usr/bin/env node
/**
 * Alinha grossAmount dos lotes (InsuranceBatch.sessions) com o valor do Payment
 * vinculado, SOMENTE para o paciente Nicolas Lucca.
 *
 * Uso: node scripts/alinha-valores-nicolas-lucca.js [--dry-run]
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import '../models/index.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGODB_URI nao configurado'); process.exit(1); }

const DRY_RUN = process.argv.includes('--dry-run');
const PATIENT_ID = '69655746dcdf49e2c282800b';
const patientOid = new mongoose.Types.ObjectId(PATIENT_ID);

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Conectado ao MongoDB');
  console.log(DRY_RUN ? '\n=== MODO DRY-RUN ===' : '\n=== MODO EXECUCAO ===');

  // Todas as sessões do Nicolas
  const sessions = await Session.find({ patient: patientOid, status: 'completed' }).select('_id appointmentId').lean();
  const sessionIds = sessions.map(s => s._id.toString());
  const sessionSet = new Set(sessionIds);

  // Batches que contêm sessões do Nicolas
  const batches = await InsuranceBatch.find({ 'sessions.session': { $in: sessions.map(s => s._id) } }).lean();
  console.log(`Batches afetados: ${batches.length}`);

  // Backup
  const backupDir = path.join(process.cwd(), 'backups-mongo', `alinha-valores-nicolas-lucca-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'batches-backup.json'), JSON.stringify(batches, null, 2));
  console.log(`Backup salvo em: ${backupDir}`);

  // Payments vinculados às sessões do Nicolas
  const payments = await Payment.find({
    session: { $in: sessions.map(s => s._id) },
    status: { $nin: ['cancelled', 'canceled'] }
  }).select('session appointment amount insurance.grossAmount').lean();
  const paymentBySession = Object.fromEntries(payments.map(p => [p.session?.toString?.(), p]));
  const paymentByAppointment = Object.fromEntries(payments.filter(p => p.appointment).map(p => [p.appointment?.toString?.(), p]));

  const plan = [];
  for (const batch of batches) {
    const affected = [];
    for (const s of batch.sessions || []) {
      const sid = s.session?.toString?.();
      if (!sessionSet.has(sid)) continue;
      const pmt = paymentBySession[sid] || paymentByAppointment[s.appointment?.toString?.()];
      if (!pmt) continue;
      const correctValue = pmt.insurance?.grossAmount ?? pmt.amount ?? s.grossAmount;
      if (correctValue !== s.grossAmount) {
        affected.push({ session: sid, old: s.grossAmount, new: correctValue, paymentId: pmt._id.toString() });
      }
    }
    if (affected.length) plan.push({ batchId: batch._id.toString(), batchNumber: batch.batchNumber, affected });
  }

  console.log('\nPlano de alteracao:');
  for (const p of plan) {
    console.log(`\nBatch ${p.batchNumber} (${p.batchId}):`);
    for (const a of p.affected) console.log(`  sessao ${a.session}: ${a.old} -> ${a.new}`);
  }

  if (DRY_RUN) {
    console.log('\nDry-run finalizado. Nenhuma alteracao realizada.');
    await mongoose.disconnect();
    return;
  }

  for (const p of plan) {
    const batch = await InsuranceBatch.findById(p.batchId);
    if (!batch) continue;
    let changed = false;
    for (const s of batch.sessions) {
      const sid = s.session?.toString?.();
      const affected = p.affected.find(a => a.session === sid);
      if (affected) {
        s.grossAmount = affected.new;
        changed = true;
      }
    }
    if (changed) {
      batch.totalGross = batch.sessions.reduce((sum, s) => sum + (s.grossAmount || 0), 0);
      batch.totalNet = batch.totalGross; // ajustar se houver ISS/glosa
      batch.totalSessions = batch.sessions.length;
      await batch.save();
      console.log(`Batch ${batch.batchNumber} atualizado: totalGross=${batch.totalGross}`);
    }
  }

  console.log('\nAlinhamento finalizado.');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
