/**
 * 🔄 Landing Page Daily Post Cron
 * Cria posts automáticos no GMB linkando para landing pages
 * Roda diariamente às 8h da manhã
 */

import cron from 'node-cron';
import GmbPost from '../models/GmbPost.js';
import * as landingPageService from '../services/landingPageService.js';

// Horários estratégicos para postagem
const POSTING_SCHEDULE = [
  { hour: 8, minute: 0, label: '🌅 Início do dia' },
  { hour: 12, minute: 30, label: '🌞 Almoço' },
  { hour: 15, minute: 0, label: '☕ Tarde' },
  { hour: 19, minute: 0, label: '🌆 Final do dia' }
];

/**
 * 🎯 Cria post no GMB para uma landing page
 */
async function createGmbPostForLandingPage(landingPage, scheduledTime = null) {
  try {
    // Gera conteúdo baseado na LP
    const suggestion = await landingPageService.generatePostContent(landingPage.slug);
    
    // Cria o post no banco
    const post = new GmbPost({
      platform: 'gmb',
      content: suggestion.content,
      title: suggestion.title,
      funnelStage: 'top', // Posts automáticos são topo de funil
      theme: landingPage.category,
      status: scheduledTime ? 'scheduled' : 'draft',
      scheduledAt: scheduledTime,
      landingPageRef: landingPage.slug,
      landingPageUrl: suggestion.landingPageUrl,
      tags: ['auto', 'landing-page', 'daily'],
      // Tenta gerar imagem se for post imediato
      generateImage: !scheduledTime,
      autoPublish: false // Sempre precisa de aprovação humana
    });
    
    await post.save();
    
    // Marca a LP como usada
    await landingPageService.markAsUsed(landingPage.slug);
    
    console.log(`✅ Post criado para LP: ${landingPage.slug}`);
    
    return {
      success: true,
      postId: post._id,
      landingPage: landingPage.slug,
      scheduledAt: scheduledTime
    };
  } catch (error) {
    console.error(`❌ Erro ao criar post para ${landingPage.slug}:`, error);
    return {
      success: false,
      error: error.message,
      landingPage: landingPage.slug
    };
  }
}

/**
 * 🚀 Cria posts do dia para todas as categorias
 */
async function createDailyPosts() {
  console.log('\n🔄 [LandingPage Cron] Iniciando criação de posts diários...');
  console.log(`📅 Data: ${new Date().toLocaleString('pt-BR')}`);
  
  try {
    // Busca LPs do dia
    const dailyPages = await landingPageService.getLandingPageOfTheDay();
    const results = [];
    
    // Cria posts para cada categoria em horários diferentes
    const categories = Object.keys(dailyPages);
    
    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      const page = dailyPages[category];
      
      if (!page) {
        console.log(`⚠️ Nenhuma LP encontrada para ${category}`);
        continue;
      }
      
      // Define horário de agendamento
      const schedule = POSTING_SCHEDULE[i % POSTING_SCHEDULE.length];
      const scheduledTime = new Date();
      scheduledTime.setHours(schedule.hour, schedule.minute, 0, 0);
      
      // Se já passou do horário, agenda para amanhã
      if (scheduledTime < new Date()) {
        scheduledTime.setDate(scheduledTime.getDate() + 1);
      }
      
      console.log(`\n📝 Criando post para ${category}:`);
      console.log(`   LP: ${page.slug}`);
      console.log(`   Horário: ${scheduledTime.toLocaleString('pt-BR')}`);
      
      const result = await createGmbPostForLandingPage(page, scheduledTime);
      results.push(result);
      
      // Pequeno delay entre criações
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Resumo
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    console.log('\n📊 [LandingPage Cron] Resumo:');
    console.log(`   ✅ Sucesso: ${successCount}`);
    console.log(`   ❌ Falhas: ${failCount}`);
    console.log(`   📅 Posts agendados para hoje`);
    
    return {
      success: true,
      results,
      summary: { success: successCount, failed: failCount }
    };
    
  } catch (error) {
    console.error('❌ [LandingPage Cron] Erro:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 📅 Agenda execução diária
 * Roda todos os dias às 7h da manhã (para agendar os posts do dia)
 */
export function scheduleLandingPageDailyPosts() {
  console.log('📅 [LandingPage Cron] Agendando job diário...');
  
  // Cron: 0 7 * * * = Todo dia às 7:00
  const job = cron.schedule('0 7 * * *', async () => {
    console.log('\n⏰ [LandingPage Cron] Execução agendada iniciada');
    await createDailyPosts();
  }, {
    scheduled: true,
    timezone: 'America/Sao_Paulo'
  });
  
  console.log('✅ [LandingPage Cron] Job agendado para 7h diariamente');
  
  return job;
}

/**
 * 🚀 Executa imediatamente (para teste ou primeiro run)
 */
export async function runLandingPageDailyPostsNow() {
  console.log('🚀 [LandingPage Cron] Execução manual iniciada');
  return await createDailyPosts();
}

/**
 * 📊 Status do cron
 */
export function getLandingPageCronStatus() {
  return {
    scheduled: true,
    nextRuns: POSTING_SCHEDULE.map(s => {
      const date = new Date();
      date.setHours(s.hour, s.minute, 0, 0);
      if (date < new Date()) {
        date.setDate(date.getDate() + 1);
      }
      return {
        time: date.toISOString(),
        label: s.label
      };
    })
  };
}

// Exportações
export default {
  scheduleLandingPageDailyPosts,
  runLandingPageDailyPostsNow,
  getLandingPageCronStatus
};
