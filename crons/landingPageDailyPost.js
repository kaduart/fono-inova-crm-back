/**
 * 🔄 Landing Page Daily Post Cron
 * Cria posts automáticos no GMB linkando para landing pages
 * Com SEO otimizado e geração de imagens via ImageBank
 * Roda diariamente às 8h da manhã
 */

import cron from 'node-cron';
import GmbPost from '../models/GmbPost.js';
import * as landingPageService from '../services/landingPageService.js';
import { generateImageForEspecialidade } from '../services/gmbService.js';
import { findExistingImage } from '../services/imageBankService.js';

// Mapeamento de categorias para especialidades do GMB
const CATEGORY_TO_ESPECIALIDADE = {
  'fonoaudiologia': { id: 'fonoaudiologia', nome: 'Fonoaudiologia', foco: 'desenvolvimento da fala e linguagem' },
  'psicologia': { id: 'psicologia', nome: 'Psicologia', foco: 'saúde mental infantil' },
  'autismo': { id: 'autismo', nome: 'Avaliação Autismo', foco: 'avaliação e acompanhamento TEA' },
  'terapia_ocupacional': { id: 'terapia_ocupacional', nome: 'Terapia Ocupacional', foco: 'coordenação motora e independência' },
  'aprendizagem': { id: 'psicopedagogia', nome: 'Psicopedagogia', foco: 'dificuldades de aprendizagem' },
  'neuropsicologia': { id: 'tdah', nome: 'TDAH', foco: 'avaliação neuropsicológica e TDAH' },
  'desenvolvimento': { id: 'fonoaudiologia', nome: 'Fonoaudiologia', foco: 'desenvolvimento infantil' },
  'geografica': { id: 'fonoaudiologia', nome: 'Fonoaudiologia', foco: 'atendimento em Anápolis' },
  'fisioterapia': { id: 'fisioterapia', nome: 'Fisioterapia', foco: 'desenvolvimento motor' },
  'freio_lingual': { id: 'freio_lingual', nome: 'Freio Lingual', foco: 'avaliação de frenulo' },
  'default': { id: 'fonoaudiologia', nome: 'Fonoaudiologia', foco: 'desenvolvimento infantil' }
};

// Horários estratégicos para postagem
const POSTING_SCHEDULE = [
  { hour: 8, minute: 0, label: '🌅 Início do dia' },
  { hour: 12, minute: 30, label: '🌞 Almoço' },
  { hour: 15, minute: 0, label: '☕ Tarde' },
  { hour: 19, minute: 0, label: '🌆 Final do dia' }
];

/**
 * 🎨 Busca ou gera imagem para a landing page
 */
async function getImageForLandingPage(landingPage, suggestion) {
  const category = landingPage.category || 'default';
  const especialidade = CATEGORY_TO_ESPECIALIDADE[category] || CATEGORY_TO_ESPECIALIDADE['default'];
  
  try {
    // TENTATIVA 1: ImageBank (reutilizar imagens existentes)
    console.log(`🔍 [LP ${landingPage.slug}] Buscando no ImageBank...`);
    const existingImage = await findExistingImage(especialidade.id, landingPage.title);
    
    if (existingImage) {
      console.log(`✅ [LP ${landingPage.slug}] Imagem do ImageBank encontrada!`);
      return {
        url: existingImage.url,
        provider: 'imagebank-reused'
      };
    }
    
    // TENTATIVA 2: Gerar nova imagem
    console.log(`🎨 [LP ${landingPage.slug}] Gerando nova imagem...`);
    const imgResult = await generateImageForEspecialidade(
      especialidade,
      suggestion.content,
      false, // sem branding
      'auto' // usa melhor provider disponível
    );
    
    if (imgResult?.url) {
      console.log(`✅ [LP ${landingPage.slug}] Imagem gerada: ${imgResult.provider}`);
      return imgResult;
    }
  } catch (error) {
    console.warn(`⚠️ [LP ${landingPage.slug}] Erro na imagem:`, error.message);
  }
  
  return null;
}

/**
 * 🎯 Cria post no GMB para uma landing page
 */
async function createGmbPostForLandingPage(landingPage, scheduledTime = null) {
  try {
    // Gera conteúdo baseado na LP (com SEO otimizado)
    const suggestion = await landingPageService.generatePostContent(landingPage.slug);
    
    // 🎨 Busca ou gera imagem
    console.log(`🖼️ [LP ${landingPage.slug}] Processando imagem...`);
    const imageResult = await getImageForLandingPage(landingPage, suggestion);
    
    if (imageResult) {
      console.log(`✅ [LP ${landingPage.slug}] Imagem OK: ${imageResult.provider}`);
    } else {
      console.warn(`⚠️ [LP ${landingPage.slug}] Sem imagem - post será criado sem mídia`);
    }
    
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
      tags: ['auto', 'landing-page', 'daily', 'seo-optimized'],
      // Dados da imagem
      mediaUrl: imageResult?.url || null,
      mediaType: imageResult?.url ? 'image' : null,
      imageProvider: imageResult?.provider || null,
      autoPublish: false // Sempre precisa de aprovação humana
    });
    
    await post.save();
    
    // Marca a LP como usada
    await landingPageService.markAsUsed(landingPage.slug);
    
    console.log(`✅ Post criado para LP: ${landingPage.slug} (imagem: ${imageResult?.provider || 'sem imagem'})`);
    
    return {
      success: true,
      postId: post._id,
      landingPage: landingPage.slug,
      scheduledAt: scheduledTime,
      hasImage: !!imageResult?.url,
      imageProvider: imageResult?.provider
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
