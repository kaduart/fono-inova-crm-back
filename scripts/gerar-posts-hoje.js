// =====================================================================
// 🚀 GERAR POSTS PARA HOJE - Cria posts automáticos para todas as áreas
// 
// Uso: node -r dotenv/config scripts/gerar-posts-hoje.js
// =====================================================================

import mongoose from 'mongoose';
import * as gmbService from '../services/gmbService.js';

async function main() {
  console.log('🚀 [GERAR POSTS HOJE] Iniciando...\n');
  
  // Conecta ao banco
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI não configurado');
    process.exit(1);
  }
  
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB conectado\n');
  
  try {
    // Executa a mesma função do cron das 06:00
    console.log('📅 Verificando especialidades sem post hoje...\n');
    const resultados = await gmbService.createPostsForAllEspecialidades();
    
    console.log('\n📊 RESUMO:');
    console.log(`   Total de especialidades processadas: ${resultados.length}`);
    
    const sucessos = resultados.filter(r => r.success);
    const falhas = resultados.filter(r => !r.success);
    
    console.log(`   ✅ Sucessos: ${sucessos.length}`);
    console.log(`   ❌ Falhas: ${falhas.length}`);
    
    if (sucessos.length > 0) {
      console.log('\n📝 Posts criados:');
      sucessos.forEach(r => {
        console.log(`   • ${r.especialidade} → ${r.horario} (${r.funil})`);
      });
    }
    
    if (falhas.length > 0) {
      console.log('\n❌ Falhas:');
      falhas.forEach(r => {
        console.log(`   • ${r.especialidade}: ${r.error}`);
      });
    }
    
    console.log('\n⏰ Os posts serão publicados automaticamente pelo cron a cada 30 minutos (8h-22h)');
    console.log('   ou você pode publicar manualmente pelo dashboard.\n');
    
  } catch (error) {
    console.error('\n❌ Erro:', error.message);
    console.error(error.stack);
  }
  
  await mongoose.disconnect();
  console.log('👋 Fim.');
  process.exit(0);
}

main();
