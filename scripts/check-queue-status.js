#!/usr/bin/env node
/**
 * 🔍 Diagnóstico de filas BullMQ
 * Verifica estado das filas no Redis
 */

import { Queue } from 'bullmq';
import { redisConnection } from '../config/redisConnection.js';

const queues = [
  { name: 'post-generation', label: '📝 Post Generation' },
  { name: 'followupQueue', label: '🔄 Followup' },
  { name: 'warm-lead-followup', label: '🔥 Warm Lead' },
  { name: 'video-generation', label: '🎬 Video Generation' }
];

async function checkQueueStatus() {
  console.log('🔍 Verificando status das filas...\n');
  
  for (const q of queues) {
    try {
      const queue = new Queue(q.name, { connection: redisConnection });
      
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount()
      ]);
      
      const total = waiting + active + delayed;
      
      console.log(`${q.label} (${q.name}):`);
      console.log(`   ⏳ Aguardando: ${waiting}`);
      console.log(`   ▶️  Ativos: ${active}`);
      console.log(`   ⏰ Delayed: ${delayed}`);
      console.log(`   ✅ Completados: ${completed}`);
      console.log(`   ❌ Falhos: ${failed}`);
      console.log(`   📊 Total pendente: ${total}`);
      console.log();
      
      await queue.close();
    } catch (err) {
      console.log(`${q.label}: ❌ Erro - ${err.message}\n`);
    }
  }
  
  process.exit(0);
}

checkQueueStatus().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
