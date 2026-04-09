// =====================================================================
// 🚀 POSTAR AGORA - Cria e publica um post imediatamente
// 
// Uso: node -r dotenv/config scripts/postar-agora.js [especialidade]
// Exemplo: node -r dotenv/config scripts/postar-agora.js fonoaudiologia
// =====================================================================

import mongoose from 'mongoose';
import * as gmbService from '../services/gmbService.js';
import * as makeService from '../services/makeService.js';
import GmbPost from '../models/GmbPost.js';

const ESPECIALIDADE = process.argv[2] || 'fonoaudiologia';

async function main() {
  console.log('🚀 [POSTAR AGORA] Iniciando...\n');
  
  // Conecta ao banco
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI não configurado');
    process.exit(1);
  }
  
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB conectado\n');
  
  // Verifica Make
  if (!makeService.isMakeConfigured()) {
    console.error('❌ MAKE_WEBHOOK_URL não configurado');
    process.exit(1);
  }
  
  // Encontra especialidade
  const especialidade = gmbService.ESPECIALIDADES.find(e => e.id === ESPECIALIDADE);
  if (!especialidade) {
    console.error(`❌ Especialidade "${ESPECIALIDADE}" não encontrada`);
    console.log('Opções disponíveis:');
    gmbService.ESPECIALIDADES.forEach(e => console.log(`  - ${e.id}`));
    process.exit(1);
  }
  
  console.log(`📌 Especialidade: ${especialidade.nome}`);
  console.log(`⏰ Horário: AGORA (${new Date().toLocaleTimeString('pt-BR')})\n`);
  
  try {
    // 1. Cria post agendado para agora
    console.log('📝 Criando post...');
    const scheduledAt = new Date(); // Agora
    
    const result = await gmbService.createDailyPost({
      especialidade,
      generateImage: true,
      scheduledAt,
      funnelStage: 'top',
      publishedBy: 'manual'
    });
    
    if (!result.success) {
      throw new Error('Falha ao criar post');
    }
    
    console.log('✅ Post criado:');
    console.log(`   📝 Título: ${result.post.title.substring(0, 60)}...`);
    console.log(`   🖼️  Imagem: ${result.post.mediaUrl ? '✅' : '❌'}`);
    
    // 2. Publica imediatamente
    console.log('\n🔗 Enviando ao Make...');
    
    // 🚨 Verifica se o post tem imagem antes de enviar
    if (!result.post.mediaUrl) {
      console.error('❌ Post não tem imagem. Abortando.');
      process.exit(1);
    }
    
    await makeService.sendPostToMake(result.post);
    
    // 3. Atualiza status
    result.post.status = 'published';
    result.post.publishedAt = new Date();
    await result.post.save();
    
    console.log('\n🎉 POST PUBLICADO COM SUCESSO!');
    console.log(`   📍 Verifique: https://business.google.com/posts`);
    console.log(`   🆔 ID: ${result.post._id}`);
    
  } catch (error) {
    console.error('\n❌ Erro:', error.message);
  }
  
  await mongoose.disconnect();
  console.log('\n👋 Fim.');
  process.exit(0);
}

main();
