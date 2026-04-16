#!/usr/bin/env node
/**
 * =============================================================================
 * ZERO-DOWNTIME DEPLOY ENGINE v1.0
 * =============================================================================
 *
 * Garante deploy sem perda de jobs nem corrupção de ledger.
 *
 * Fluxo:
 *   1. LOCK  → Pausa entrada de novos eventos (Redis flag)
 *   2. DRAIN → Aguarda filas esvaziarem (waiting=0, active=0)
 *   3. SNAPSHOT → Salva estado das filas em MongoDB (safety)
 *   4. DEPLOY  → Você executa seu deploy aqui (hook externo)
 *   5. VERIFY  → Valida se workers subiram e filas estão consumindo
 *   6. UNLOCK  → Reabilita eventos
 *
 * Uso:
 *   node scripts/zeroDowntimeDeploy.js --pre-deploy
 *   # ... execute seu deploy manualmente ou via CI ...
 *   node scripts/zeroDowntimeDeploy.js --post-deploy
 *
 * Uso automático:
 *   node scripts/zeroDowntimeDeploy.js --full
 *
 * =============================================================================
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';
import { redisConnection, bullMqConnection } from '../config/redisConnection.js';
import '../models/index.js';

// Modelo para snapshots de fila (criado on-the-fly se não existir)
const QueueSnapshotSchema = new mongoose.Schema({
  deployId: { type: String, required: true, index: true },
  phase: { type: String, enum: ['pre', 'post'], required: true },
  timestamp: { type: Date, default: Date.now },
  queues: [{
    name: String,
    waiting: Number,
    active: Number,
    failed: Number,
    delayed: Number,
    completed: Number,
    jobs: [{
      id: String,
      name: String,
      data: mongoose.Schema.Types.Mixed,
      opts: mongoose.Schema.Types.Mixed,
      timestamp: Number
    }]
  }],
  verified: { type: Boolean, default: false }
}, { collection: 'queue_snapshots' });

const QueueSnapshot = mongoose.models.QueueSnapshot || mongoose.model('QueueSnapshot', QueueSnapshotSchema);

dotenv.config();

const LOCK_KEY = 'system:deploy:lock';
const LOCK_TTL_SECONDS = 600; // 10 minutos máximo de lock automático
const DRAIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos
const DRAIN_CHECK_INTERVAL_MS = 3000;

const DEPLOY_ID = `deploy_${Date.now()}`;

// Todas as filas conhecidas do sistema
const ALL_QUEUES = [
  // scheduling
  'appointment-processing',
  'preagendamento-processing',
  'appointment-integration',
  'appointment-update',
  'cancel-orchestrator',
  'complete-orchestrator',
  'create-appointment',
  // billing
  'payment-processing',
  'package-validation',
  'package-projection',
  'package-processing',
  'billing-orchestrator',
  'totals-calculation',
  'invoice-generation',
  // clinical
  'patient-processing',
  'patient-projection',
  'clinical-orchestrator',
  'session-processing',
  'event-sync',
  // whatsapp
  'whatsapp-inbound',
  'message-persistence',
  'conversation-state',
  'context-builder',
  'message-response',
  'lead-orchestrator',
  'whatsapp-autoreply',
  'lead-interaction',
  'whatsapp-realtime',
  'chat-projection',
  'intent-classifier',
  'fsm-router',
  // reconciliation
  'reconciliation-processing',
  'lead-recovery',
  'outbox',
  'integration-orchestrator',
  'daily-closing',
  'followup-processing',
  'notification',
  // legacy/config
  'followupQueue',
  'warmLeadFollowupQueue',
  'videoGenerationQueue',
  'posProducaoQueue',
  'postGenerationQueue',
  'doctorQueue',
  'gmbPublishRetryQueue'
];

// ─────────────────────────────────────────────────────────────────────────────
// CLI ARGS
// ─────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const MODE = {
  preDeploy: args.includes('--pre-deploy'),
  postDeploy: args.includes('--post-deploy'),
  full: args.includes('--full'),
  status: args.includes('--status'),
  unlock: args.includes('--unlock'),
  snapshotOnly: args.includes('--snapshot')
};

if (!Object.values(MODE).some(Boolean)) {
  console.log(`
🚀 Zero-Downtime Deploy Engine

Uso:
  node scripts/zeroDowntimeDeploy.js --pre-deploy    # Prepara para deploy
  node scripts/zeroDowntimeDeploy.js --post-deploy   # Finaliza após deploy
  node scripts/zeroDowntimeDeploy.js --full          # Executa end-to-end
  node scripts/zeroDowntimeDeploy.js --status        # Verifica lock e filas
  node scripts/zeroDowntimeDeploy.js --unlock        # Remove lock manualmente
  node scripts/zeroDowntimeDeploy.js --snapshot      # Apenas snapshot das filas
`);
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function acquireLock() {
  const result = await redisConnection.set(LOCK_KEY, DEPLOY_ID, 'EX', LOCK_TTL_SECONDS, 'NX');
  if (result !== 'OK') {
    const existing = await redisConnection.get(LOCK_KEY);
    throw new Error(`🔒 Lock já existe: ${existing}. Use --unlock para remover ou aguarde expiração (${LOCK_TTL_SECONDS}s).`);
  }
  console.log(`🔒 Lock adquirido: ${DEPLOY_ID} (TTL: ${LOCK_TTL_SECONDS}s)`);
}

async function releaseLock() {
  await redisConnection.del(LOCK_KEY);
  console.log('🔓 Lock removido');
}

async function isLocked() {
  const val = await redisConnection.get(LOCK_KEY);
  return !!val;
}

async function getQueueStats() {
  const stats = [];
  for (const name of ALL_QUEUES) {
    try {
      const queue = new Queue(name, { connection: bullMqConnection });
      const [waiting, active, failed, delayed, completed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
        queue.getCompletedCount()
      ]);
      await queue.close();
      stats.push({ name, waiting, active, failed, delayed, completed });
    } catch (err) {
      stats.push({ name, waiting: 0, active: 0, failed: 0, delayed: 0, completed: 0, error: err.message });
    }
  }
  return stats;
}

async function getWaitingJobsSnapshot(limit = 50) {
  const snapshot = [];
  for (const name of ALL_QUEUES) {
    try {
      const queue = new Queue(name, { connection: bullMqConnection });
      const jobs = await queue.getWaiting(0, limit);
      await queue.close();
      if (jobs.length > 0) {
        snapshot.push({
          name,
          jobs: jobs.map(j => ({
            id: j.id,
            name: j.name,
            data: j.data,
            opts: j.opts,
            timestamp: j.timestamp
          }))
        });
      }
    } catch (err) {
      // ignore
    }
  }
  return snapshot;
}

async function snapshotQueues(phase = 'pre') {
  console.log(`📸 Snapshot [${phase}] em andamento...`);
  const stats = await getQueueStats();
  const waiting = phase === 'pre' ? await getWaitingJobsSnapshot() : [];

  const doc = new QueueSnapshot({
    deployId: DEPLOY_ID,
    phase,
    queues: stats.map(s => ({
      ...s,
      jobs: waiting.find(w => w.name === s.name)?.jobs || []
    }))
  });

  await doc.save();
  console.log(`✅ Snapshot [${phase}] salvo: ${DEPLOY_ID}`);
  return stats;
}

async function drainQueues() {
  const start = Date.now();
  console.log('⏳ Iniciando drain de filas...');

  while (true) {
    const stats = await getQueueStats();
    const totalActive = stats.reduce((sum, s) => sum + (s.active || 0), 0);
    const totalWaiting = stats.reduce((sum, s) => sum + (s.waiting || 0), 0);

    console.log(`   active=${totalActive} waiting=${totalWaiting} elapsed=${Math.round((Date.now() - start) / 1000)}s`);

    if (totalActive === 0 && totalWaiting === 0) {
      console.log('✅ Todas as filas drenaram');
      return stats;
    }

    if (Date.now() - start > DRAIN_TIMEOUT_MS) {
      throw new Error(`⏰ Timeout no drain. Ainda há active=${totalActive} waiting=${totalWaiting}. Verifique workers travados.`);
    }

    await new Promise(r => setTimeout(r, DRAIN_CHECK_INTERVAL_MS));
  }
}

async function verifyPostDeploy() {
  console.log('🔍 Verificando saúde pós-deploy...');

  // 1. Lock ainda existe? (alguém pode ter removido)
  const locked = await isLocked();
  if (!locked) {
    console.warn('⚠️ Lock não encontrado no pós-deploy. Alguém pode ter desbloqueado manualmente.');
  }

  // 2. Workers estão consumindo?
  await new Promise(r => setTimeout(r, 5000)); // dá tempo dos workers reconectarem
  const preStats = await getQueueStats();

  // Publica um job de ping em uma fila crítica e vê se ela some rapidamente
  const testQueueName = 'appointment-processing';
  const testQueue = new Queue(testQueueName, { connection: bullMqConnection });
  await testQueue.add('deploy-ping', { ping: true, deployId: DEPLOY_ID }, { removeOnComplete: true });

  let pingOk = false;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const waiting = await testQueue.getWaitingCount();
    if (waiting === 0) {
      pingOk = true;
      break;
    }
  }
  await testQueue.close();

  const postStats = await getQueueStats();
  const totalWaiting = postStats.reduce((sum, s) => sum + (s.waiting || 0), 0);
  const totalFailed = postStats.reduce((sum, s) => sum + (s.failed || 0), 0);

  const healthy = pingOk && totalFailed < 10;

  console.log(`   ping=${pingOk ? 'OK' : 'FAIL'} waiting=${totalWaiting} failed=${totalFailed}`);

  if (!healthy) {
    throw new Error('❌ Pós-deploy não saudável. Workers podem não estar consumindo.');
  }

  console.log('✅ Pós-deploy verificado');
  return { pingOk, totalWaiting, totalFailed };
}

async function printStatus() {
  const locked = await isLocked();
  const stats = await getQueueStats();
  const totalActive = stats.reduce((sum, s) => sum + (s.active || 0), 0);
  const totalWaiting = stats.reduce((sum, s) => sum + (s.waiting || 0), 0);
  const totalFailed = stats.reduce((sum, s) => sum + (s.failed || 0), 0);

  console.log('\n========================================');
  console.log('STATUS DO SISTEMA');
  console.log('========================================');
  console.log(`Deploy lock: ${locked ? 'ATIVO (' + (await redisConnection.get(LOCK_KEY)) + ')' : 'LIVRE'}`);
  console.log(`Total waiting: ${totalWaiting}`);
  console.log(`Total active:  ${totalActive}`);
  console.log(`Total failed:  ${totalFailed}`);
  console.log('----------------------------------------');
  stats.filter(s => s.waiting > 0 || s.active > 0 || s.failed > 0)
       .forEach(s => console.log(`  ${s.name}: w=${s.waiting} a=${s.active} f=${s.failed}`));
  console.log('========================================\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!MONGO_URI) {
    console.error('❌ MONGODB_URI não configurada');
    process.exit(1);
  }

  console.log(`🚀 Deploy ID: ${DEPLOY_ID}\n`);

  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB conectado');

  try {
    if (MODE.status) {
      await printStatus();
    }

    else if (MODE.unlock) {
      await releaseLock();
      console.log('🔓 Sistema desbloqueado');
    }

    else if (MODE.snapshotOnly) {
      await snapshotQueues('snapshot');
    }

    else if (MODE.preDeploy) {
      await acquireLock();
      const stats = await snapshotQueues('pre');
      await drainQueues();
      console.log('\n🟢 SISTEMA PRONTO PARA DEPLOY');
      console.log('   Execute seu deploy agora.');
      console.log('   Depois, rode: node scripts/zeroDowntimeDeploy.js --post-deploy');
    }

    else if (MODE.postDeploy) {
      if (!(await isLocked())) {
        console.warn('⚠️ Nenhum lock ativo. O sistema pode não ter passado por pre-deploy.');
      }
      const stats = await snapshotQueues('post');
      await verifyPostDeploy();
      await releaseLock();
      await printStatus();
      console.log('\n🎉 DEPLOY FINALIZADO COM SUCESSO');
    }

    else if (MODE.full) {
      await acquireLock();
      await snapshotQueues('pre');
      await drainQueues();
      console.log('\n🟢 Ponto de deploy alcançado.');
      console.log('   (Em modo full, assumimos que o deploy externo já foi feito)');
      await snapshotQueues('post');
      await verifyPostDeploy();
      await releaseLock();
      await printStatus();
      console.log('\n🎉 DEPLOY COMPLETO');
    }

  } catch (err) {
    console.error('\n❌ ERRO:', err.message);
    console.error('   Dica: verifique se workers estão rodando e se há jobs travados.');
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    await redisConnection.quit();
    if (bullMqConnection && bullMqConnection !== redisConnection) {
      await bullMqConnection.quit();
    }
  }
}

main();
