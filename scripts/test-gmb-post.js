// =====================================================================
// 🧪 TESTE RÁPIDO DE POST GMB
// Cria um post de teste agendado para 14:30 (ou horário atual + 5min)
// 
// Uso: node -r dotenv/config scripts/test-gmb-post.js
// =====================================================================

import mongoose from 'mongoose';
import * as gmbService from '../services/gmbService.js';
import * as makeService from '../services/makeService.js';
import GmbPost from '../models/GmbPost.js';

async function main() {
  console.log('🧪 [TESTE] Iniciando criação de post de teste...\n');
  
  // Conecta ao banco
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI não configurado');
    process.exit(1);
  }
  
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB conectado\n');
  
  // Define horário do post (14:30 ou próximo horário válido)
  const agora = new Date();
  const scheduledAt = new Date();
  scheduledAt.setHours(14, 30, 0, 0);
  
  // Se 14:30 já passou hoje, agenda para amanhã
  if (scheduledAt < agora) {
    scheduledAt.setDate(scheduledAt.getDate() + 1);
    console.log(`⏰ Horário 14:30 já passou. Agendando para amanhã às 14:30\n`);
  } else {
    console.log(`⏰ Agendando post para hoje às 14:30\n`);
  }
  
  try {
    // Cria o post
    console.log('📝 Criando post...');
    const result = await gmbService.createDailyPost({
      especialidade: gmbService.ESPECIALIDADES[0], // Fonoaudiologia
      generateImage: true,
      scheduledAt,
      funnelStage: 'top',
      customTheme: 'TESTE - Post de validação do sistema GMB'
    });
    
    if (result.success) {
      console.log('✅ Post criado com sucesso!');
      console.log(`   📌 ID: ${result.post._id}`);
      console.log(`   🏥 Especialidade: ${result.especialidade.nome}`);
      console.log(`   📝 Título: ${result.post.title.substring(0, 60)}...`);
      console.log(`   🖼️  Imagem: ${result.post.mediaUrl ? '✅ Gerada' : '❌ Sem imagem'}`);
      console.log(`   ⏰ Agendado para: ${scheduledAt.toLocaleString('pt-BR')}`);
      console.log(`   📊 Status: ${result.post.status}\n`);
      
      // Pergunta se quer publicar imediatamente via Make
      console.log('🔗 Verificando Make...');
      
      if (makeService.isMakeConfigured()) {
        console.log('✅ Make configurado');
        console.log('   Enviando post para o Make agora...\n');
        
        try {
          await makeService.sendPostToMake(result.post);
          
          result.post.status = 'published';
          result.post.publishedAt = new Date();
          await result.post.save();
          
          console.log('🎉 POST PUBLICADO COM SUCESSO!');
          console.log('   📢 Verifique o Google Meu Negócio em alguns minutos');
          
        } catch (makeError) {
          console.error('❌ Erro ao enviar ao Make:', makeError.message);
          console.log('   ℹ️  O post ficou agendado no banco. O cron enviará mais tarde.');
        }
        
      } else {
        console.log('⚠️  Make NÃO configurado (MAKE_WEBHOOK_URL ausente)');
        console.log('   ℹ️  O post foi criado e agendado. Configure o Make para publicar automaticamente.');
      }
      
    } else {
      console.error('❌ Falha ao criar post');
    }
    
  } catch (error) {
    console.error('❌ Erro:', error.message);
    console.error(error.stack);
  }
  
  await mongoose.disconnect();
  console.log('\n👋 Disconectado. Fim do teste.');
  process.exit(0);
}

main();
