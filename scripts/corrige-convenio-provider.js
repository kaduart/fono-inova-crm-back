#!/usr/bin/env node
/**
 * Corrige batches/payments com insuranceProvider='convenio' para o provider real
 * da guia vinculada. Batches misturados (Anápolis + Campinas) sao separados em
 * batches distintos por provider.
 *
 * Uso: node scripts/corrige-convenio-provider.js [--dry-run]
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import '../models/index.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error('MONGODB_URI nao configurado'); process.exit(1); }

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('Conectado ao MongoDB');
  console.log(DRY_RUN ? '\n=== MODO DRY-RUN (nenhuma alteracao) ===' : '\n=== MODO EXECUCAO ===');

  const targetProviders = ['convenio', 'Convênio', 'Convenio'];

  const batches = await InsuranceBatch.find({ insuranceProvider: { $in: targetProviders } }).lean();
  const payment = await Payment.findOne({
    billingType: 'convenio',
    package: null,
    'insurance.provider': { $in: targetProviders }
  }).lean();

  console.log(`Batches encontrados: ${batches.length}`);
  console.log(`Payment avulso encontrado: ${payment ? payment._id : 'nenhum'}`);

  // Backup em arquivo local
  const backupDir = path.join(process.cwd(), 'backups-mongo', `corrige-convenio-provider-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'batches-backup.json'), JSON.stringify(batches, null, 2));
  if (payment) fs.writeFileSync(path.join(backupDir, 'payment-backup.json'), JSON.stringify(payment, null, 2));
  console.log(`Backup salvo em: ${backupDir}`);

  const plan = [];

  for (const batch of batches) {
    const sessionIds = (batch.sessions || []).map(s => s.session).filter(Boolean);
    const sessions = await Session.find({ _id: { $in: sessionIds } }).select('insuranceGuide billingBatchId').lean();
    const guideIds = sessions.map(s => s.insuranceGuide).filter(Boolean);
    const guides = await InsuranceGuide.find({ _id: { $in: guideIds } }).select('insurance number').lean();
    const guideById = Object.fromEntries(guides.map(g => [g._id.toString(), g]));

    const byProvider = {};
    const sessionProviderById = {};
    for (const s of sessions) {
      const g = s.insuranceGuide ? guideById[s.insuranceGuide.toString()] : null;
      const provider = g?.insurance || 'outros';
      sessionProviderById[s._id.toString()] = provider;
      if (!byProvider[provider]) byProvider[provider] = [];
      byProvider[provider].push({ sessionId: s._id.toString(), provider });
    }

    const split = Object.entries(byProvider).map(([provider, sess]) => ({
      provider,
      count: sess.length,
      sessionIds: sess.map(x => x.sessionId)
    }));

    plan.push({
      originalBatchId: batch._id.toString(),
      batchNumber: batch.batchNumber,
      originalProvider: batch.insuranceProvider,
      split
    });
  }

  console.log('\nPlano de separacao:');
  for (const p of plan) {
    console.log(`\nBatch ${p.batchNumber} (${p.originalBatchId}):`);
    for (const s of p.split) {
      console.log(`  -> ${s.provider}: ${s.count} sessoes`);
    }
  }

  if (DRY_RUN) {
    console.log('\nDry-run finalizado. Nenhuma alteracao realizada.');
    await mongoose.disconnect();
    return;
  }

  // Execucao
  for (const p of plan) {
    const original = await InsuranceBatch.findById(p.originalBatchId);
    if (!original) { console.log(`Batch ${p.originalBatchId} nao encontrado, pulando`); continue; }

    for (const s of p.split) {
      const sessionsToMove = original.sessions.filter(sess => s.sessionIds.includes(sess.session?.toString?.()));
      if (sessionsToMove.length === 0) continue;

      const newBatch = await InsuranceBatch.create({
        ...original.toObject(),
        _id: undefined,
        insuranceProvider: s.provider,
        batchNumber: `LOT-${s.provider}-${Date.now()}-${Math.floor(Math.random()*1000)}`,
        sessions: sessionsToMove,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      await Session.updateMany(
        { _id: { $in: s.sessionIds.map(id => new mongoose.Types.ObjectId(id)) } },
        { $set: { billingBatchId: newBatch._id } }
      );

      console.log(`Criado batch ${newBatch.batchNumber} (${newBatch._id}) provider=${s.provider} com ${sessionsToMove.length} sessoes`);
    }

    await InsuranceBatch.findByIdAndDelete(p.originalBatchId);
    console.log(`Removido batch original ${p.originalBatchId}`);
  }

  if (payment) {
    const guide = await InsuranceGuide.findById(payment.insurance?.guide || payment.insuranceGuide).select('insurance').lean();
    const realProvider = guide?.insurance || 'unimed-anapolis';
    await Payment.findByIdAndUpdate(payment._id, {
      $set: {
        'insurance.provider': realProvider,
        'insurance.providerLabel': realProvider,
        updatedAt: new Date()
      }
    });
    console.log(`Payment ${payment._id} atualizado para provider ${realProvider}`);
  }

  console.log('\nCorrecao finalizada.');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
