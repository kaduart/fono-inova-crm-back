#!/usr/bin/env node
/**
 * 🚨 Força processamento de posts pendentes
 * Útil quando o Make está com fila cheia
 */

import { Queue } from 'bullmq';
import { bullMqConnection } from '../config/redisConnection.js';
import GmbPost from '../models/GmbPost.js';

async function forceProcessPosts() {
  console.log('🚨 Forçando processamento de posts...\n');
  
  try {
    // 1. Ver posts stuck em 'processing'
    const stuckPosts = await GmbPost.find({ 
      processingStatus: 'processing',
      updatedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } // 10+ minutos
    });
    
    console.log(`⏳ Posts travados em 'processing': ${stuckPosts.length}`);
    
    for (const post of stuckPosts) {
      console.log(`   Resetando: ${post._id} - ${post.title?.substring(0, 40)}`);
      post.processingStatus = 'pending';
      await post.save();
    }
    
    // 2. Ver jobs na fila
    const queue = new Queue('post-generation', { connection: bullMqConnection });
    const waiting = await queue.getWaiting();
    
    console.log(`\n📋 Jobs na fila: ${waiting.length}`);
    
    if (waiting.length > 0) {
      console.log('\nJobs pendentes:');
      for (const job of waiting.slice(0, 5)) {
        console.log(`   #${job.id}: ${job.data.channel}/${job.data.postId}`);
      }
      if (waiting.length > 5) {
        console.log(`   ... e mais ${waiting.length - 5}`);
      }
    }
    
    // 3. Ver posts scheduled que deveriam ser publicados
    const scheduledPosts = await GmbPost.find({
      status: 'scheduled',
      scheduledAt: { $lte: new Date() }
    });
    
    console.log(`\n📅 Posts agendados para agora: ${scheduledPosts.length}`);
    
    for (const post of scheduledPosts) {
      console.log(`   ${post._id} - ${post.title?.substring(0, 40)}`);
    }
    
    await queue.close();
    
    console.log('\n✅ Diagnóstico completo!');
    console.log('\n💡 Sugestões:');
    console.log('   1. Se posts estão travados, reinicie o servidor');
    console.log('   2. Verifique se o Make está online: https://status.make.com');
    console.log('   3. Considere limpar jobs antigos da fila');
    
  } catch (err) {
    console.error('❌ Erro:', err);
  }
  
  process.exit(0);
}

forceProcessPosts();
