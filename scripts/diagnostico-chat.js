#!/usr/bin/env node
/**
 * 🔍 DIAGNÓSTICO DO CHAT - Verifica onde as mensagens estão parando
 * 
 * Uso: node scripts/diagnostico-chat.js
 */

import mongoose from 'mongoose';
import { redisConnection } from '../config/redisConnection.js';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

console.log('🔍 INICIANDO DIAGNÓSTICO DO CHAT...\n');

async function checkMongo() {
  console.log('📦 1. Verificando MongoDB...');
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('   ✅ MongoDB conectado');
    
    // Verifica últimas mensagens recebidas
    const Message = mongoose.model('Message', new mongoose.Schema({
      from: String, to: String, direction: String, content: String,
      status: String, timestamp: Date, waMessageId: String
    }, { timestamps: true }));
    
    const ultimasMsgs = await Message.find({ direction: 'inbound' })
      .sort({ timestamp: -1 })
      .limit(5)
      .lean();
    
    console.log(`   📨 Últimas ${ultimasMsgs.length} mensagens inbound:`);
    ultimasMsgs.forEach((m, i) => {
      console.log(`      ${i+1}. ${m.timestamp?.toISOString()} - ${m.from}: "${m.content?.substring(0, 50)}..."`);
    });
    
    // Verifica logs brutos do webhook
    const rawLogs = await mongoose.connection.collection('raw_webhook_logs')
      .find({})
      .sort({ receivedAt: -1 })
      .limit(5)
      .toArray();
    
    console.log(`   📋 Últimos ${rawLogs.length} logs brutos do webhook:`);
    rawLogs.forEach((log, i) => {
      const msg = log.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      console.log(`      ${i+1}. ${log.receivedAt?.toISOString()} - ${msg?.from || 'N/A'}: "${msg?.text?.body?.substring(0, 50) || 'N/A'}..."`);
    });
    
    return { ok: true, ultimaMsg: ultimasMsgs[0]?.timestamp };
  } catch (err) {
    console.error('   ❌ MongoDB erro:', err.message);
    return { ok: false, error: err.message };
  }
}

async function checkRedis() {
  console.log('\n🔴 2. Verificando Redis...');
  try {
    await redisConnection.ping();
    console.log('   ✅ Redis conectado');
    
    // Verifica chaves de debounce pendentes
    const debounceKeys = await redisConnection.keys('webhook:buffer:*');
    console.log(`   ⏳ Chaves de debounce pendentes: ${debounceKeys.length}`);
    
    for (const key of debounceKeys.slice(0, 3)) {
      const data = await redisConnection.get(key);
      console.log(`      - ${key}: ${data}`);
    }
    
    // Verifica chaves de idempotência
    const idemKeys = await redisConnection.keys('msg:processed:*');
    console.log(`   🔒 Chaves de idempotência (últimas 24h): ${idemKeys.length}`);
    
    return { ok: true, debouncePendentes: debounceKeys.length };
  } catch (err) {
    console.error('   ❌ Redis erro:', err.message);
    return { ok: false, error: err.message };
  }
}

async function checkQueues() {
  console.log('\n📬 3. Verificando Filas BullMQ...');
  try {
    const whatsappInboundQueue = new Queue('whatsapp-inbound', { connection: redisConnection });
    const whatsappNotificationQueue = new Queue('whatsapp-notification', { connection: redisConnection });
    
    const inboundWaiting = await whatsappInboundQueue.getWaitingCount();
    const inboundActive = await whatsappInboundQueue.getActiveCount();
    const inboundFailed = await whatsappInboundQueue.getFailedCount();
    
    console.log('   📥 Fila whatsapp-inbound:');
    console.log(`      - Aguardando: ${inboundWaiting}`);
    console.log(`      - Ativos: ${inboundActive}`);
    console.log(`      - Falhados: ${inboundFailed}`);
    
    if (inboundFailed > 0) {
      const failedJobs = await whatsappInboundQueue.getFailed(0, 3);
      console.log('      ❌ Últimos jobs falhados:');
      failedJobs.forEach((job, i) => {
        console.log(`         ${i+1}. ${job.failedReason}`);
      });
    }
    
    const notifWaiting = await whatsappNotificationQueue.getWaitingCount();
    console.log(`   📤 Fila whatsapp-notification: ${notifWaiting} aguardando`);
    
    return { 
      ok: true, 
      inboundWaiting, 
      inboundActive, 
      inboundFailed,
      notifWaiting 
    };
  } catch (err) {
    console.error('   ❌ Filas erro:', err.message);
    return { ok: false, error: err.message };
  }
}

async function checkContacts() {
  console.log('\n👥 4. Verificando Contatos...');
  try {
    const Contacts = mongoose.model('Contacts', new mongoose.Schema({
      phone: String, name: String, lastMessageAt: Date, unreadCount: Number
    }, { timestamps: true }));
    
    const totalContacts = await Contacts.countDocuments();
    const withUnread = await Contacts.countDocuments({ unreadCount: { $gt: 0 } });
    
    console.log(`   👤 Total de contatos: ${totalContacts}`);
    console.log(`   🔴 Com mensagens não lidas: ${withUnread}`);
    
    const recentContacts = await Contacts.find()
      .sort({ lastMessageAt: -1 })
      .limit(3)
      .lean();
    
    console.log('   📱 Contatos mais recentes:');
    recentContacts.forEach((c, i) => {
      console.log(`      ${i+1}. ${c.name} - última msg: ${c.lastMessageAt?.toISOString() || 'N/A'}`);
    });
    
    return { ok: true, totalContacts, withUnread };
  } catch (err) {
    console.error('   ❌ Contatos erro:', err.message);
    return { ok: false, error: err.message };
  }
}

async function main() {
  const results = {
    mongo: await checkMongo(),
    redis: await checkRedis(),
    queues: await checkQueues(),
    contacts: await checkContacts()
  };
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 RESUMO DO DIAGNÓSTICO');
  console.log('='.repeat(60));
  
  const allOk = Object.values(results).every(r => r.ok);
  
  if (allOk) {
    console.log('✅ Todos os serviços estão operacionais');
    
    if (results.queues.inboundWaiting > 0) {
      console.log(`⚠️  ATENÇÃO: ${results.queues.inboundWaiting} mensagens aguardando na fila!`);
      console.log('   💡 Solução: Verificar se o WhatsappInboundWorker está rodando');
    }
    
    if (results.queues.inboundFailed > 0) {
      console.log(`❌ ATENÇÃO: ${results.queues.inboundFailed} mensagens falharam!`);
      console.log('   💡 Solução: Verificar logs dos workers');
    }
    
    if (results.redis.debouncePendentes > 0) {
      console.log(`⏳ ATENÇÃO: ${results.redis.debouncePendentes} mensagens presas no debounce!`);
      console.log('   💡 Solução: Limpar chaves de debounce no Redis');
    }
  } else {
    console.log('❌ Problemas detectados:');
    Object.entries(results).forEach(([name, result]) => {
      if (!result.ok) {
        console.log(`   - ${name}: ${result.error}`);
      }
    });
  }
  
  console.log('\n🔧 COMANDOS ÚTEIS:');
  console.log('   - Limpar debounce: redis-cli DEL webhook:buffer:*');
  console.log('   - Ver logs: pm2 logs | grep -i "whatsapp\|inbound\|message"');
  console.log('   - Reiniciar workers: pm2 restart <nome-do-processo>');
  
  await mongoose.disconnect();
  await redisConnection.quit();
  process.exit(0);
}

main().catch(err => {
  console.error('💥 Erro fatal:', err);
  process.exit(1);
});
