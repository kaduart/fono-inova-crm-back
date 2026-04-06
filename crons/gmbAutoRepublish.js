/**
 * 🔄 GMB Auto-Republish Cron
 * 
 * Republica posts automaticamente quando expiram (7 dias no GMB)
 * Cria novos posts baseados nos posts anteriores para manter o perfil ativo
 */

import cron from 'node-cron';
import GmbPost from '../models/GmbPost.js';
import { sendPostToMake } from '../services/makeService.js';
import { generateContentVariations } from '../services/gmbService.js';

// Dias antes da expiração para republicar
const REPUBLISH_BEFORE_DAYS = 6; // Republica no dia 6, antes de expirar no 7º

/**
 * 🔄 Republica posts que estão prestes a expirar
 */
async function republishExpiringPosts() {
  console.log('\n🔄 [GMB Auto-Republish] Verificando posts para republicar...');
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - REPUBLISH_BEFORE_DAYS);
  
  try {
    // Busca posts publicados há 6+ dias
    const expiringPosts = await GmbPost.find({
      status: 'published',
      publishedAt: { $lte: cutoffDate },
      autoRepublish: { $ne: false }, // Não republica se desabilitado
      republishedFrom: { $exists: false } // Não republica posts que já são republicações
    }).limit(10);
    
    console.log(`📊 [GMB Auto-Republish] ${expiringPosts.length} posts para republicar`);
    
    const results = [];
    
    for (const post of expiringPosts) {
      try {
        console.log(`\n📝 Republicando: ${post.title?.substring(0, 50)}...`);
        
        // Gera variação do conteúdo para não ser duplicado
        let newContent = post.content;
        let newTitle = post.title;
        
        try {
          const variations = await generateContentVariations(
            post.theme || 'fonoaudiologia',
            post.title,
            'top',
            'emotional',
            1
          );
          
          if (variations?.length > 0) {
            newContent = variations[0].content;
            newTitle = variations[0].title || post.title;
          }
        } catch (e) {
          console.warn('⚠️ Não foi possível gerar variação, usando conteúdo original');
        }
        
        // Cria novo post baseado no antigo
        const newPost = new GmbPost({
          platform: 'gmb',
          content: newContent,
          title: newTitle,
          funnelStage: post.funnelStage || 'top',
          theme: post.theme,
          status: 'pending', // Vai para aprovação
          mediaUrl: post.mediaUrl, // Reusa mesma imagem
          mediaType: post.mediaType,
          imageProvider: post.imageProvider,
          ctaUrl: post.ctaUrl,
          ctaType: post.ctaType,
          landingPageRef: post.landingPageRef,
          landingPageUrl: post.landingPageUrl,
          tags: ['auto-republish', 'republished', ...(post.tags || [])],
          republishedFrom: post._id, // Referência ao post original
          autoPublish: false // Sempre precisa de aprovação
        });
        
        await newPost.save();
        
        // Marca post antigo como republicado
        post.tags = [...(post.tags || []), 'expired-and-republished'];
        await post.save();
        
        console.log(`✅ Post republicado: ${newPost._id}`);
        
        results.push({
          success: true,
          originalId: post._id,
          newId: newPost._id,
          title: newTitle
        });
        
      } catch (error) {
        console.error(`❌ Erro ao republicar post ${post._id}:`, error.message);
        results.push({
          success: false,
          originalId: post._id,
          error: error.message
        });
      }
      
      // Delay entre posts
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Resumo
    const successCount = results.filter(r => r.success).length;
    console.log(`\n📊 [GMB Auto-Republish] Resumo:`);
    console.log(`   ✅ Republicados: ${successCount}/${results.length}`);
    
    return {
      success: true,
      republished: successCount,
      failed: results.length - successCount,
      results
    };
    
  } catch (error) {
    console.error('❌ [GMB Auto-Republish] Erro:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🗑️ Limpa posts muito antigos (mais de 30 dias) do banco
 * Opcional - mantém histórico limpo
 */
async function cleanupOldPosts() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  try {
    const result = await GmbPost.deleteMany({
      status: 'published',
      publishedAt: { $lt: thirtyDaysAgo },
      tags: { $in: ['expired-and-republished'] }
    });
    
    if (result.deletedCount > 0) {
      console.log(`🗑️ [GMB Auto-Republish] ${result.deletedCount} posts antigos removidos`);
    }
    
    return result;
  } catch (error) {
    console.error('❌ Erro ao limpar posts antigos:', error);
    return null;
  }
}

/**
 * 📅 Agenda execução diária
 * Roda todos os dias às 6h da manhã (1h antes do cron de criação de novos posts)
 */
export function scheduleGmbAutoRepublish() {
  console.log('📅 [GMB Auto-Republish] Agendando job...');
  
  // Cron: 0 6 * * * = Todo dia às 6:00
  const job = cron.schedule('0 6 * * *', async () => {
    console.log('\n⏰ [GMB Auto-Republish] Execução iniciada');
    await republishExpiringPosts();
    await cleanupOldPosts();
  }, {
    scheduled: true,
    timezone: 'America/Sao_Paulo'
  });
  
  console.log('✅ [GMB Auto-Republish] Job agendado para 6h diariamente');
  
  return job;
}

/**
 * 🚀 Executa imediatamente (para teste ou recuperação)
 */
export async function runGmbAutoRepublishNow() {
  console.log('🚀 [GMB Auto-Republish] Execução manual iniciada');
  const result = await republishExpiringPosts();
  await cleanupOldPosts();
  return result;
}

/**
 * 📊 Status do cron
 */
export function getGmbRepublishStatus() {
  return {
    scheduled: true,
    republishBeforeDays: REPUBLISH_BEFORE_DAYS,
    nextRun: '06:00 AM (America/Sao_Paulo)'
  };
}

export default {
  scheduleGmbAutoRepublish,
  runGmbAutoRepublishNow,
  getGmbRepublishStatus,
  republishExpiringPosts
};
