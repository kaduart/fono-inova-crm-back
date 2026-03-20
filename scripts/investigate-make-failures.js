#!/usr/bin/env node
/**
 * 🔍 Investigação de falhas no Make
 * Verifica logs, jobs e padrões de erro
 */

import { Queue } from 'bullmq';
import { redisConnection } from '../config/redisConnection.js';
import fs from 'fs';
import path from 'path';

async function investigate() {
  console.log('🔍 INVESTIGAÇÃO: Por que o Make está falhando?\n');
  console.log('=' .repeat(60));
  
  // 1. Verifica fila de geração de posts
  console.log('\n1️⃣ Fila de GERAÇÃO de posts (post-generation):');
  const postGenQueue = new Queue('post-generation', { connection: redisConnection });
  const postGenJobs = await postGenQueue.getJobs(['waiting', 'active', 'completed', 'failed']);
  
  console.log(`   Total de jobs: ${postGenJobs.length}`);
  console.log(`   - Aguardando: ${postGenJobs.filter(j => j.queue.name === 'post-generation' && j.id).length}`);
  
  // Verifica jobs completados recentemente
  const recentCompleted = postGenJobs
    .filter(j => j.returnvalue && j.finishedOn)
    .slice(-10);
  
  console.log(`\n   Últimos 10 posts gerados:`);
  for (const job of recentCompleted) {
    console.log(`   - ${job.data.channel}/${job.data.postId}: ${job.returnvalue?.status || 'unknown'}`);
  }
  
  await postGenQueue.close();
  
  // 2. Verifica se posts "scheduled" estão tentando publicar
  console.log('\n2️⃣ Verificando posts com status problematico:');
  
  try {
    const mongoose = await import('mongoose');
    await mongoose.connect(process.env.MONGO_URI);
    
    const GmbPost = (await import('../models/GmbPost.js')).default;
    
    const scheduledPosts = await GmbPost.find({ 
      status: 'scheduled',
      scheduledAt: { $lte: new Date() }
    });
    
    console.log(`   Posts 'scheduled' para agora: ${scheduledPosts.length}`);
    for (const post of scheduledPosts) {
      console.log(`   - ${post._id}: ${post.title?.substring(0, 40)} (scheduledAt: ${post.scheduledAt})`);
    }
    
    const publishingRetry = await GmbPost.find({ status: 'publishing_retry' });
    console.log(`\n   Posts em 'publishing_retry': ${publishingRetry.length}`);
    
    const processingStuck = await GmbPost.find({ 
      processingStatus: 'processing',
      updatedAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) }
    });
    console.log(`\n   Posts travados em 'processing' (>30min): ${processingStuck.length}`);
    
    await mongoose.disconnect();
  } catch (err) {
    console.log(`   Erro MongoDB: ${err.message}`);
  }
  
  // 3. Verifica logs do servidor
  console.log('\n3️⃣ Verificando logs recentes:');
  const logPath = path.join(process.cwd(), 'logs', 'error.log');
  
  if (fs.existsSync(logPath)) {
    const logs = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    const makeErrors = logs.filter(line => 
      line.toLowerCase().includes('make') && 
      (line.toLowerCase().includes('queue') || line.toLowerCase().includes('error'))
    ).slice(-10);
    
    console.log(`   Últimos erros do Make:`);
    for (const err of makeErrors) {
      console.log(`   ${err.substring(0, 100)}`);
    }
  } else {
    console.log('   Arquivo de log não encontrado');
  }
  
  // 4. Verifica configuração do Make
  console.log('\n4️⃣ Configuração do Make:');
  console.log(`   MAKE_WEBHOOK_URL configurado: ${Boolean(process.env.MAKE_WEBHOOK_URL)}`);
  console.log(`   URL: ${process.env.MAKE_WEBHOOK_URL?.substring(0, 50)}...`);
  
  // Análise da URL do webhook
  const webhookUrl = process.env.MAKE_WEBHOOK_URL || '';
  if (webhookUrl.includes('hook.us2.make.com')) {
    console.log('   Região: US2 (pode ter limites diferentes)');
  } else if (webhookUrl.includes('hook.eu2.make.com')) {
    console.log('   Região: EU2');
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('\n💡 DIAGNÓSTICO:');
  console.log('   Se você está enviando MUITOS posts de uma vez,');
  console.log('   ou se tem posts agendados que venceram,');
  console.log('   o Make pode estar bloqueando por limite de requisições.');
  console.log('\n🛠️  SOLUÇÕES POSSÍVEIS:');
  console.log('   1. Verificar plano do Make (gratuito = 1000 ops/mês)');
  console.log('   2. Aumentar delay entre publicações');
  console.log('   3. Implementar rate limiting mais agressivo');
  
  process.exit(0);
}

investigate().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
