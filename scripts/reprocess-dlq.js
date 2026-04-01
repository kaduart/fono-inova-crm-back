#!/usr/bin/env node
// scripts/reprocess-dlq.js
/**
 * Script para reprocessar eventos da DLQ
 * 
 * Uso:
 *   node scripts/reprocess-dlq.js --all
 *   node scripts/reprocess-dlq.js --event APPOINTMENT_CANCEL_REQUESTED_123
 *   node scripts/reprocess-dlq.js --queue complete-orchestrator
 */

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../.env') });

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const args = process.argv.slice(2);
const reprocessAll = args.includes('--all');
const eventId = args.find(arg => arg.startsWith('--event='))?.split('=')[1];
const queueName = args.find(arg => arg.startsWith('--queue='))?.split('=')[1];

async function getDLQJobs() {
  // Busca jobs da fila dlq
  const dlqKey = 'bull:dlq:failed';
  const jobs = await redis.lrange(dlqKey, 0, -1);
  
  return jobs.map(job => {
    try {
      return JSON.parse(job);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function reprocessJob(jobData) {
  console.log(`\n🔄 Reprocessando: ${jobData.eventId || jobData.id}`);
  console.log(`   Queue: ${jobData.originalQueue || jobData.queue}`);
  console.log(`   Erro anterior: ${jobData.error?.message || 'N/A'}`);
  
  const targetQueue = jobData.originalQueue || jobData.queue;
  if (!targetQueue) {
    console.log('   ❌ Queue não encontrada');
    return false;
  }
  
  const queue = new Queue(targetQueue, { connection: redis });
  
  try {
    await queue.add(jobData.name || jobData.eventType, jobData.data, {
      jobId: `reprocess-${jobData.id || Date.now()}`,
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    });
    
    console.log('   ✅ Reenviado com sucesso');
    return true;
  } catch (err) {
    console.log(`   ❌ Erro: ${err.message}`);
    return false;
  } finally {
    await queue.close();
  }
}

async function main() {
  console.log('🔍 Buscando jobs na DLQ...\n');
  
  const jobs = await getDLQJobs();
  
  if (jobs.length === 0) {
    console.log('✅ DLQ vazia');
    process.exit(0);
  }
  
  console.log(`📦 ${jobs.length} jobs encontrados\n`);
  
  let toProcess = jobs;
  
  // Filtra por eventId
  if (eventId) {
    toProcess = toProcess.filter(j => j.eventId === eventId || j.id === eventId);
    console.log(`🔍 Filtrado por eventId: ${toProcess.length} jobs`);
  }
  
  // Filtra por queue
  if (queueName) {
    toProcess = toProcess.filter(j => 
      (j.originalQueue || j.queue) === queueName
    );
    console.log(`🔍 Filtrado por queue: ${toProcess.length} jobs`);
  }
  
  if (toProcess.length === 0) {
    console.log('⚠️ Nenhum job corresponde aos filtros');
    process.exit(0);
  }
  
  // Modo dry-run (só lista)
  if (!reprocessAll && !eventId) {
    console.log('\n📋 Jobs na DLQ:');
    toProcess.forEach((job, i) => {
      console.log(`\n  ${i + 1}. ${job.eventId || job.id}`);
      console.log(`     Queue: ${job.originalQueue || job.queue}`);
      console.log(`     Erro: ${job.error?.message || 'N/A'}`);
    });
    console.log('\n👉 Use --all para reprocessar tudo');
    console.log('👉 Use --event=ID para reprocessar específico');
    process.exit(0);
  }
  
  // Reprocessa
  console.log(`\n🚀 Reprocessando ${toProcess.length} jobs...\n`);
  
  let success = 0;
  let failed = 0;
  
  for (const job of toProcess) {
    const ok = await reprocessJob(job);
    if (ok) success++;
    else failed++;
  }
  
  console.log(`\n✅ Concluído: ${success} sucesso, ${failed} falha`);
  
  await redis.quit();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('💥 Erro:', err);
  process.exit(1);
});
