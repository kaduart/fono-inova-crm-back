#!/usr/bin/env node
/**
 * 🔧 CORREÇÃO DO CHAT - Garante processamento das mensagens
 * 
 * Este script:
 * 1. Limpa chaves de debounce presas no Redis
 * 2. Reprocessa mensagens pendentes
 * 3. Verifica e corrige o fluxo de mensagens
 * 
 * Uso: node scripts/corrigir-chat.js
 */

import mongoose from 'mongoose';
import { redisConnection } from '../config/redisConnection.js';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

console.log('🔧 INICIANDO CORREÇÃO DO CHAT...\n');

async function limparDebouncePreso() {
  console.log('🧹 1. Limpando debounce preso no Redis...');
  try {
    const debounceKeys = await redisConnection.keys('webhook:buffer:*');
    console.log(`   Encontradas ${debounceKeys.length} chaves de debounce`);
    
    let limpas = 0;
    let reprocessadas = 0;
    
    for (const key of debounceKeys) {
      try {
        const data = await redisConnection.get(key);
        if (data) {
          const parsed = JSON.parse(data);
          const age = Date.now() - (parsed.startTime || 0);
          
          // Se a chave tem mais de 10 segundos, está presa
          if (age > 10000) {
            console.log(`   ⏳ Chave presa encontrada: ${key} (${Math.round(age/1000)}s)`);
            
            // Tenta reprocessar a mensagem
            if (parsed.msgData) {
              try {
                await publishEvent(EventTypes.WHATSAPP_MESSAGE_RECEIVED, {
                  msg: parsed.msgData,
                  value: { messages: [parsed.msgData] }
                });
                console.log(`   ✅ Mensagem reprocessada: ${parsed.msgData.id || 'N/A'}`);
                reprocessadas++;
              } catch (err) {
                console.error(`   ❌ Falha ao reprocessar:`, err.message);
              }
            }
            
            // Deleta a chave
            await redisConnection.del(key);
            limpas++;
          }
        }
      } catch (err) {
        console.error(`   ❌ Erro ao processar ${key}:`, err.message);
      }
    }
    
    console.log(`   ✅ ${limpas} chaves limpas, ${reprocessadas} mensagens reprocessadas`);
    return { limpas, reprocessadas };
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
    return { limpas: 0, reprocessadas: 0, error: err.message };
  }
}

async function limparIdempotenciaAntiga() {
  console.log('\n🗑️ 2. Limpando idempotência antiga (>24h)...');
  try {
    const idemKeys = await redisConnection.keys('msg:processed:*');
    console.log(`   Total de chaves de idempotência: ${idemKeys.length}`);
    
    // O TTL já cuida disso, mas vamos verificar
    const ttlPromises = idemKeys.slice(0, 100).map(async (key) => {
      const ttl = await redisConnection.ttl(key);
      return { key, ttl };
    });
    
    const ttls = await Promise.all(ttlPromises);
    const semTtl = ttls.filter(t => t.ttl < 0);
    
    console.log(`   Chaves sem TTL (vazamento): ${semTtl.length}`);
    
    // Limpa chaves sem TTL (vazamento de memória)
    for (const { key } of semTtl.slice(0, 50)) {
      await redisConnection.del(key);
    }
    
    console.log(`   ✅ ${semTtl.length} chaves sem TTL removidas`);
    return { removidas: semTtl.length };
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
    return { removidas: 0, error: err.message };
  }
}

async function verificarFilaWhatsApp() {
  console.log('\n📬 3. Verificando fila whatsapp-inbound...');
  try {
    const queue = new Queue('whatsapp-inbound', { connection: redisConnection });
    
    const waiting = await queue.getWaiting();
    const active = await queue.getActive();
    const failed = await queue.getFailed();
    
    console.log(`   Aguardando: ${waiting.length}`);
    console.log(`   Ativos: ${active.length}`);
    console.log(`   Falhados: ${failed.length}`);
    
    // Tenta reprocessar jobs falhados
    if (failed.length > 0) {
      console.log('   🔄 Reprocessando jobs falhados...');
      for (const job of failed.slice(0, 10)) {
        try {
          await job.retry();
          console.log(`      ✅ Job ${job.id} reprocessado`);
        } catch (err) {
          console.error(`      ❌ Job ${job.id} falhou:`, err.message);
        }
      }
    }
    
    // Verifica jobs aguardando há muito tempo
    const agora = Date.now();
    const jobsAtrasados = waiting.filter(job => {
      const delay = agora - (job.timestamp || 0);
      return delay > 60000; // Mais de 1 minuto
    });
    
    if (jobsAtrasados.length > 0) {
      console.log(`   ⚠️  ${jobsAtrasados.length} jobs aguardando há mais de 1 minuto!`);
      console.log('   💡 O worker pode estar parado. Reinicie o servidor.');
    }
    
    return { waiting: waiting.length, active: active.length, failed: failed.length };
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
    return { error: err.message };
  }
}

async function verificarUltimasMensagens() {
  console.log('\n📨 4. Verificando últimas mensagens no banco...');
  try {
    const Message = mongoose.model('Message', new mongoose.Schema({
      from: String, to: String, direction: String, content: String,
      status: String, timestamp: Date, waMessageId: String
    }, { timestamps: true }));
    
    const ultimas = await Message.find()
      .sort({ timestamp: -1 })
      .limit(10)
      .lean();
    
    console.log(`   Últimas ${ultimas.length} mensagens:`);
    ultimas.forEach((m, i) => {
      const data = m.timestamp ? new Date(m.timestamp).toLocaleString('pt-BR') : 'N/A';
      const dir = m.direction === 'inbound' ? '📥' : '📤';
      console.log(`      ${i+1}. ${dir} ${data} - ${m.from}: "${m.content?.substring(0, 40)}..."`);
    });
    
    // Verifica se há mensagens recentes (últimos 5 minutos)
    const cincoMinAtras = new Date(Date.now() - 5 * 60 * 1000);
    const recentes = await Message.countDocuments({ timestamp: { $gte: cincoMinAtras } });
    
    console.log(`   \n   Mensagens nos últimos 5 minutos: ${recentes}`);
    
    if (recentes === 0) {
      console.log('   ⚠️  NENHUMA MENSAGEM NOS ÚLTIMOS 5 MINUTOS!');
      console.log('   💡 Possíveis causas:');
      console.log('      - Webhook do Meta não está configurado corretamente');
      console.log('      - Servidor está fora do ar');
      console.log('      - Fila de processamento parada');
    }
    
    return { recentes, ultimaMsg: ultimas[0]?.timestamp };
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
    return { error: err.message };
  }
}

async function sugerirCorrecoes(resultados) {
  console.log('\n' + '='.repeat(60));
  console.log('💡 SUGESTÕES DE CORREÇÃO');
  console.log('='.repeat(60));
  
  const sugestoes = [];
  
  if (resultados.debounce.limpas > 0) {
    sugestoes.push('✅ Mensagens presas no debounce foram reprocessadas');
  }
  
  if (resultados.fila.failed > 0) {
    sugestoes.push('⚠️  Há jobs falhados na fila. Verifique os logs com: pm2 logs');
  }
  
  if (resultados.mensagens.recentes === 0) {
    sugestoes.push('🔴 Nenhuma mensagem recente detectada. Verifique:');
    sugestoes.push('   1. Se o webhook do WhatsApp está configurado no Meta Developers');
    sugestoes.push('   2. Se a URL do webhook está acessível: POST /api/whatsapp/webhook');
    sugestoes.push('   3. Se o servidor está rodando e acessível');
  }
  
  if (sugestoes.length === 0) {
    console.log('✅ Nenhum problema crítico detectado. O sistema parece estar funcionando.');
  } else {
    sugestoes.forEach(s => console.log(s));
  }
  
  console.log('\n🔧 COMANDOS ÚTEIS:');
  console.log('   Ver logs em tempo real:');
  console.log('   pm2 logs | grep -i "webhook\|inbound\|message:new"');
  console.log('');
  console.log('   Reiniciar servidor:');
  console.log('   pm2 restart all');
  console.log('');
  console.log('   Testar webhook manualmente:');
  console.log('   curl -X POST https://fono-inova-crm-back.onrender.com/api/whatsapp/webhook \\');
  console.log('     -H "Content-Type: application/json" \\');
  console.log('     -d \'{"entry":[{"changes":[{"value":{"messages":[{"from":"5511999999999","text":{"body":"Teste"},"id":"test-123","timestamp":"' + Math.floor(Date.now()/1000) + '"}]}}]}]}\'');
}

async function main() {
  console.log('Conectando ao banco de dados...');
  await mongoose.connect(process.env.MONGO_URI);
  await redisConnection.ping();
  
  const resultados = {
    debounce: await limparDebouncePreso(),
    idempotencia: await limparIdempotenciaAntiga(),
    fila: await verificarFilaWhatsApp(),
    mensagens: await verificarUltimasMensagens()
  };
  
  await sugerirCorrecoes(resultados);
  
  console.log('\n✅ Correção finalizada!');
  
  await mongoose.disconnect();
  await redisConnection.quit();
  process.exit(0);
}

main().catch(err => {
  console.error('💥 Erro fatal:', err);
  process.exit(1);
});
