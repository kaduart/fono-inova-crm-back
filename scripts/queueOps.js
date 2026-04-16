#!/usr/bin/env node
/**
 * =============================================================================
 * QUEUE OPERATIONS CLI
 * =============================================================================
 *
 * Ferramenta para resolver filas travadas em produção.
 *
 * Comandos:
 *   node scripts/queueOps.js --retry-failed <queueName>
 *   node scripts/queueOps.js --retry-all-failed
 *   node scripts/queueOps.js --clean <queueName> --status completed --older-than 24h
 *   node scripts/queueOps.js --promote-delayed <queueName>
 *   node scripts/queueOps.js --reprocess-dlq
 *   node scripts/queueOps.js --list-failed
 *   node scripts/queueOps.js --list-active
 *
 * =============================================================================
 */

import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import { bullMqConnection } from '../config/redisConnection.js';

dotenv.config();

const args = process.argv.slice(2);
const CMD = {
  retryFailed: getArgValue('--retry-failed'),
  retryAllFailed: args.includes('--retry-all-failed'),
  clean: getArgValue('--clean'),
  cleanStatus: getArgValue('--status') || 'completed',
  olderThan: getArgValue('--older-than') || '24h',
  promoteDelayed: getArgValue('--promote-delayed'),
  reprocessDlq: args.includes('--reprocess-dlq'),
  listFailed: args.includes('--list-failed'),
  listActive: args.includes('--list-active'),
  purge: getArgValue('--purge')
};

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

if (!Object.values(CMD).some(Boolean)) {
  console.log(`
🛠️  Queue Operations CLI

Uso:
  --retry-failed <queue>        Reprocessa jobs failed de uma fila
  --retry-all-failed            Reprocessa TODOS os jobs failed de TODAS as filas
  --clean <queue> --status <st> --older-than <N>h
                                Limpa jobs antigos (completed/failed/waiting/delayed)
  --promote-delayed <queue>     Promove todos os jobs delayed para waiting
  --reprocess-dlq               Reprocessa jobs da DLQ de volta para filas originais
  --list-failed                 Lista todas as filas com jobs failed
  --list-active                 Lista todas as filas com jobs active
  --purge <queue>               ⚠️ Remove TODOS os jobs da fila (dangerous)
`);
  process.exit(0);
}

const ALL_QUEUES = [
  'appointment-processing',
  'preagendamento-processing',
  'appointment-integration',
  'appointment-update',
  'cancel-orchestrator',
  'complete-orchestrator',
  'create-appointment',
  'payment-processing',
  'package-validation',
  'package-projection',
  'package-processing',
  'billing-orchestrator',
  'totals-calculation',
  'invoice-generation',
  'patient-processing',
  'patient-projection',
  'clinical-orchestrator',
  'session-processing',
  'event-sync',
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
  'reconciliation-processing',
  'lead-recovery',
  'outbox',
  'integration-orchestrator',
  'daily-closing',
  'followup-processing',
  'notification',
  'followupQueue',
  'warmLeadFollowupQueue',
  'videoGenerationQueue',
  'posProducaoQueue',
  'postGenerationQueue',
  'doctorQueue',
  'gmbPublishRetryQueue',
  'dlq'
];

async function getQueue(name) {
  return new Queue(name, { connection: bullMqConnection });
}

async function retryFailed(queueName) {
  const queue = await getQueue(queueName);
  const failed = await queue.getFailed();
  console.log(`[${queueName}] Reprocessando ${failed.length} jobs failed...`);
  let retried = 0;
  for (const job of failed) {
    try {
      await job.retry();
      retried++;
    } catch (err) {
      console.error(`  ❌ Job ${job.id} não pode ser retried:`, err.message);
    }
  }
  await queue.close();
  console.log(`[${queueName}] ✅ ${retried}/${failed.length} retried`);
}

async function retryAllFailed() {
  console.log('\n🔁 Reprocessando todos os jobs failed...\n');
  for (const name of ALL_QUEUES) {
    try {
      const queue = await getQueue(name);
      const failed = await queue.getFailed(0, 1); // peek
      await queue.close();
      if (failed.length > 0) {
        await retryFailed(name);
      }
    } catch (err) {
      console.error(`[${name}] Erro:`, err.message);
    }
  }
}

async function cleanQueue(queueName, status, olderThanStr) {
  const hours = parseInt(olderThanStr);
  const queue = await getQueue(queueName);
  const grace = hours * 60 * 60 * 1000;

  console.log(`[${queueName}] Limpando jobs ${status} com mais de ${hours}h...`);
  const result = await queue.clean(grace, status === 'all' ? 0 : -1, status);
  await queue.close();
  console.log(`[${queueName}] ✅ ${result.length} jobs removidos`);
}

async function promoteDelayed(queueName) {
  const queue = await getQueue(queueName);
  const delayed = await queue.getDelayed();
  console.log(`[${queueName}] Promovendo ${delayed.length} jobs delayed...`);
  let promoted = 0;
  for (const job of delayed) {
    try {
      await job.promote();
      promoted++;
    } catch (err) {
      console.error(`  ❌ Job ${job.id}:`, err.message);
    }
  }
  await queue.close();
  console.log(`[${queueName}] ✅ ${promoted}/${delayed.length} promovidos`);
}

async function reprocessDlq() {
  const dlq = await getQueue('dlq');
  const waiting = await dlq.getWaiting();
  console.log(`[DLQ] Reprocessando ${waiting.length} jobs...`);
  let moved = 0;
  for (const job of waiting) {
    const data = job.data;
    const targetQueue = data.queueName || data.originalQueue || 'appointment-processing';
    try {
      const target = await getQueue(targetQueue);
      await target.add(data.jobName || 'reprocessed', data.payload || data, {
        jobId: `reproc_${job.id}_${Date.now()}`,
        removeOnComplete: true
      });
      await job.remove();
      await target.close();
      moved++;
    } catch (err) {
      console.error(`  ❌ Job ${job.id} -> ${targetQueue}:`, err.message);
    }
  }
  await dlq.close();
  console.log(`[DLQ] ✅ ${moved}/${waiting.length} reprocessados`);
}

async function listFailed() {
  console.log('\n📋 Filas com jobs FAILED:\n');
  for (const name of ALL_QUEUES) {
    try {
      const queue = await getQueue(name);
      const failed = await queue.getFailedCount();
      await queue.close();
      if (failed > 0) console.log(`  ${name}: ${failed}`);
    } catch {}
  }
}

async function listActive() {
  console.log('\n📋 Filas com jobs ACTIVE:\n');
  for (const name of ALL_QUEUES) {
    try {
      const queue = await getQueue(name);
      const active = await queue.getActiveCount();
      await queue.close();
      if (active > 0) console.log(`  ${name}: ${active}`);
    } catch {}
  }
}

async function purgeQueue(queueName) {
  console.log(`\n⚠️  PURGE TOTAL em ${queueName}`);
  const queue = await getQueue(queueName);
  await queue.obliterate({ force: true });
  await queue.close();
  console.log(`[${queueName}] 🔥 Todos os jobs removidos`);
}

async function main() {
  try {
    if (CMD.retryFailed) await retryFailed(CMD.retryFailed);
    if (CMD.retryAllFailed) await retryAllFailed();
    if (CMD.clean) await cleanQueue(CMD.clean, CMD.cleanStatus, CMD.olderThan);
    if (CMD.promoteDelayed) await promoteDelayed(CMD.promoteDelayed);
    if (CMD.reprocessDlq) await reprocessDlq();
    if (CMD.listFailed) await listFailed();
    if (CMD.listActive) await listActive();
    if (CMD.purge) await purgeQueue(CMD.purge);
  } catch (err) {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  } finally {
    await bullMqConnection.quit();
  }
}

main();
