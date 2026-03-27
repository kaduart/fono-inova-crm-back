/**
 * 📝 Post Worker — Processa jobs de geração de posts (GMB, Instagram, Facebook)
 * 
 * Fluxo:
 * 1. Recebe job com postId, channel, especialidadeId, customTheme, funnelStage
 * 2. Gera conteúdo com IA
 * 3. Gera imagem (se solicitado)
 * 4. Atualiza post no MongoDB com status 'draft' ou 'scheduled'
 */

import { Worker } from 'bullmq';
import { bullMqConnection } from '../config/redisConnection.js';
import { getIo } from '../config/socket.js';
import logger from '../utils/logger.js';

// Models
import GmbPost from '../models/GmbPost.js';
import InstagramPost from '../models/InstagramPost.js';
import FacebookPost from '../models/FacebookPost.js';

// Services
import * as gmbService from '../services/gmbService.js';
import { gerarHeadline, generateImage as generateInstagramImage } from '../services/instagramPostService.js';
import { generateCaptionSEO, generateHooksViral } from '../services/gmbService.js';
import { scorePostQuality } from '../services/gmbService.js';


// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL_MODELS = {
  gmb: GmbPost,
  instagram: InstagramPost,
  facebook: FacebookPost
};

const CHANNEL_NAMES = {
  gmb: 'Google Meu Negócio',
  instagram: 'Instagram',
  facebook: 'Facebook'
};

// Atualizar progresso no Mongo + Socket.IO
const atualizarProgresso = async (postId, channel, status, extra = {}) => {
  try {
    const Model = CHANNEL_MODELS[channel];
    if (!Model) return;

    await Model.findByIdAndUpdate(postId, {
      processingStatus: status,
      ...extra
    });

    // Emitir via Socket.IO
    const io = getIo();
    io.emit(`post-progress-${channel}-${postId}`, {
      postId,
      channel,
      status,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    logger.warn(`[POST WORKER] Erro ao atualizar progresso: ${e.message}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// WORKER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

const postWorker = new Worker('post-generation', async (job) => {
  const {
    postId,
    channel,  // 'gmb', 'instagram', 'facebook'
    especialidadeId,
    customTheme,
    funnelStage = 'top',
    scheduledAt,
    generateImage = true,
    provider = 'auto',
    tone = 'emotional',
    userId
  } = job.data;

  logger.info(`[POST WORKER] ▶ ${channel}/${postId} — ${especialidadeId}`);
  logger.info(`[POST WORKER] Config: generateImage=${generateImage}, provider=${provider}, mode=${channel === 'gmb' ? (generateImage ? 'full' : 'caption') : 'N/A'}`);

  try {
    // Atualizar status para processing
    await atualizarProgresso(postId, channel, 'processing');

    const Model = CHANNEL_MODELS[channel];
    const especialidade = gmbService.ESPECIALIDADES.find(e => e.id === especialidadeId) || gmbService.ESPECIALIDADES[0];

    let postData = null;
    let mediaUrl = null;
    let imageProvider = null;

    // ═══════════════════════════════════════════════════════════════════════
    // GERAR CONTEÚDO POR CANAL
    // ═══════════════════════════════════════════════════════════════════════
    
    if (channel === 'gmb') {
      // GMB: Gera post com conteúdo completo
      logger.info(`[POST WORKER] Gerando conteúdo GMB para ${especialidade.nome} (tom: ${tone})...`);
      postData = await gmbService.generatePostForEspecialidade(especialidade, customTheme, funnelStage, tone);
      logger.info(`[POST WORKER] Conteúdo gerado: "${postData.title?.substring(0, 50)}..."`);
      
      if (generateImage) {
        try {
          logger.info(`[POST WORKER] Gerando imagem GMB (provider: ${provider || 'auto'})...`);
          logger.info(`[POST WORKER] Ordem de tentativa: fal.ai → Freepik → HuggingFace → Pollinations`);
          const imgResult = await gmbService.generateImageForEspecialidade(especialidade, postData.content, false, provider);
          mediaUrl = imgResult?.url || null;
          imageProvider = imgResult?.provider || null;
          if (mediaUrl) {
            logger.info(`[POST WORKER] ✅ IMAGEM GERADA com SUCESSO!`);
            logger.info(`[POST WORKER]    → Provider: ${imageProvider}`);
            logger.info(`[POST WORKER]    → URL: ${mediaUrl.substring(0, 70)}...`);
          } else {
            logger.error(`[POST WORKER] ❌ IMAGEM FALHOU: Nenhuma URL retornada!`);
            logger.error(`[POST WORKER]    → Todos os providers falharam (Freepik → fal.ai → HF → Pollinations)`);
          }
        } catch (imgError) {
          logger.error(`[POST WORKER] Erro imagem GMB: ${imgError.message}`);
        }
      } else {
        logger.info(`[POST WORKER] Geração de imagem desabilitada para este post`);
      }

      const isScheduled = Boolean(scheduledAt);
      
      await Model.findByIdAndUpdate(postId, {
        title: postData.title,
        content: postData.content,
        theme: especialidade.id,
        status: isScheduled ? 'scheduled' : 'draft',
        mediaUrl,
        mediaType: mediaUrl ? 'image' : null,
        imageProvider,
        scheduledAt: isScheduled ? new Date(scheduledAt) : null,
        aiGenerated: true,
        processingStatus: 'completed',
        ctaUrl: especialidade.url || null,
        tone
      });
      
      // Score de qualidade automático
      if (postData?.content) {
        try {
          const score = await scorePostQuality(postData.content, funnelStage);
          if (score) await Model.findByIdAndUpdate(postId, { qualityScore: score });
        } catch { /* score é opcional */ }
      }

      logger.info(`[POST WORKER] 💾 Post salvo: mediaUrl=${mediaUrl ? '✅ COM IMAGEM' : '❌ SEM IMAGEM'}, provider=${imageProvider || 'N/A'}`);

    } else if (channel === 'instagram') {
      // Instagram: texto + imagem automática
      const mode = job.data.mode || 'full'; // 'full' | 'caption' | 'hooks'
      logger.info(`[POST WORKER] Instagram modo: ${mode} (com imagem automática)`);

      // Se vier legenda pré-gerada pelo ZEUS, usar diretamente (não re-gerar)
      let headline, legenda;
      if (job.data.legenda) {
        legenda = job.data.legenda;
        headline = customTheme || especialidade.nome;
        logger.info(`[POST WORKER] Usando legenda pré-gerada pelo ZEUS (${legenda.length} chars)`);
      } else {
        // Headline curta
        headline = await gerarHeadline({ especialidade, funnelStage, customTheme });

        if (mode === 'hooks') {
          // 🎣 GANCHOS VIRAIS: Gera 10 ganchos para usar nos Reels
          const hooksResult = await generateHooksViral(especialidade, customTheme, funnelStage, 10);
          legenda = hooksResult.content;
        } else {
          // ✨ FULL ou 📝 CAPTION SEO: legenda com keyword density + CTA por funil
          const captionResult = await generateCaptionSEO(especialidade, customTheme || headline, funnelStage);
          legenda = captionResult.content;
        }
      }

      // Score de qualidade automático
      let igScore = null;
      try {
        igScore = await scorePostQuality(legenda, funnelStage);
      } catch { /* score é opcional */ }

      // 🎨 GERAR IMAGEM AUTOMATICAMENTE (se modo full)
      let mediaUrl = null;
      let imageProvider = null;
      
      if (mode === 'full' && generateImage) {
        try {
          logger.info(`[POST WORKER] Gerando imagem Instagram (provider: ${provider || 'auto'})...`);
          
          const promptData = {
            especialidade,
            headline,
            tipoImagem: 'foto_real'
          };
          
          const imgResult = await generateInstagramImage(promptData);
          
          if (imgResult?.url) {
            mediaUrl = imgResult.url;
            imageProvider = imgResult.provider;
            logger.info(`[POST WORKER] ✅ IMAGEM GERADA: ${imageProvider}`);
          } else if (imgResult?.buffer) {
            // Upload para Cloudinary se veio buffer
            const { v2: cloudinary } = await import('cloudinary');
            const base64 = `data:image/jpeg;base64,${imgResult.buffer.toString('base64')}`;
            const uploadResult = await cloudinary.uploader.upload(base64, {
              folder: 'fono-inova/instagram/worker',
              public_id: `ig_${postId}_${Date.now()}`,
            });
            mediaUrl = uploadResult.secure_url;
            imageProvider = imgResult.provider;
            logger.info(`[POST WORKER] ✅ IMAGEM UPLOADED: ${imageProvider}`);
          } else {
            logger.warn(`[POST WORKER] ⚠️ Nenhuma imagem retornada`);
          }
        } catch (imgError) {
          logger.error(`[POST WORKER] ❌ Erro ao gerar imagem Instagram: ${imgError.message}`);
        }
      }

      // Atualizar o post
      const isScheduled = Boolean(scheduledAt);
      await InstagramPost.findByIdAndUpdate(postId, {
        title: headline,
        headline,
        content: legenda,
        caption: legenda,
        theme: especialidade.id,
        status: isScheduled ? 'scheduled' : 'draft',
        mediaUrl,
        mediaType: mediaUrl ? 'image' : null,
        imageProvider: imageProvider || (generateImage && mode === 'full' ? 'failed' : 'manual'),
        scheduledAt: isScheduled ? new Date(scheduledAt) : null,
        aiGenerated: true,
        processingStatus: 'completed',
        funnelStage,
        tone,
        ...(igScore ? { qualityScore: igScore } : {})
      });

    } else if (channel === 'facebook') {
      // Facebook: Similar ao GMB, suporta tone e scheduledAt
      const fbMode = job.data.mode || 'full';
      logger.info(`[POST WORKER] Facebook modo: ${fbMode}, tom: ${tone}`);

      if (fbMode === 'hooks') {
        const hooksResult = await generateHooksViral(especialidade, customTheme, funnelStage, 10);
        postData = { title: `10 Ganchos - ${especialidade.nome}`, content: hooksResult.content };
      } else if (fbMode === 'caption') {
        const captionResult = await generateCaptionSEO(especialidade, customTheme, funnelStage);
        postData = { title: `Legenda SEO - ${especialidade.nome}`, content: captionResult.content };
      } else {
        postData = await gmbService.generatePostForEspecialidade(especialidade, customTheme, funnelStage, tone);
      }

      if (generateImage && fbMode === 'full') {
        try {
          const imgResult = await gmbService.generateImageForEspecialidade(especialidade, postData.content, false, provider);
          mediaUrl = imgResult?.url || null;
          imageProvider = imgResult?.provider || null;
        } catch (imgError) {
          logger.warn(`[POST WORKER] Erro imagem Facebook: ${imgError.message}`);
        }
      }

      // Score de qualidade automático
      let fbScore = null;
      try {
        fbScore = await scorePostQuality(postData.content, funnelStage);
      } catch { /* score é opcional */ }

      const isFbScheduled = Boolean(scheduledAt);
      await Model.findByIdAndUpdate(postId, {
        title: postData.title,
        content: postData.content,
        theme: especialidade.id,
        status: isFbScheduled ? 'scheduled' : 'draft',
        mediaUrl,
        mediaType: mediaUrl ? 'image' : null,
        imageProvider,
        scheduledAt: isFbScheduled ? new Date(scheduledAt) : null,
        aiGenerated: true,
        processingStatus: 'completed',
        funnelStage,
        tone,
        ...(fbScore ? { qualityScore: fbScore } : {})
      });
    }

    // Notificar conclusão
    const io = getIo();
    io.emit(`post-complete-${channel}-${postId}`, {
      postId,
      channel,
      status: 'completed',
      mediaUrl
    });

    logger.info(`[POST WORKER] ✅ ${channel}/${postId} concluído`);

    return {
      postId,
      channel,
      status: 'completed',
      mediaUrl
    };

  } catch (error) {
    logger.error(`[POST WORKER] ❌ ${channel}/${postId} falhou: ${error.message}`);
    
    // Atualizar como erro
    try {
      const Model = CHANNEL_MODELS[channel];
      if (Model) {
        await Model.findByIdAndUpdate(postId, {
          status: 'failed',
          processingStatus: 'failed',
          errorMessage: error.message
        });
      }

      const io = getIo();
      io.emit(`post-error-${channel}-${postId}`, {
        postId,
        channel,
        error: error.message
      });
    } catch (e) {
      // Ignora erro de atualização
    }

    throw error;
  }
}, {
  connection: redisConnection,
  concurrency: 3,  // Máx 3 posts simultâneos
  limiter: {
    max: 20,
    duration: 60000  // 20 jobs por minuto
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────

postWorker.on('completed', (job, result) => {
  logger.info(`[POST WORKER] ✅ Job ${job.id} finalizado: ${result?.channel}/${result?.postId}`);
});

postWorker.on('failed', (job, err) => {
  logger.error(`[POST WORKER] ❌ Job ${job?.id} falhou: ${err.message}`);
});

postWorker.on('error', (err) => {
  logger.error('[POST WORKER] Erro no worker:', err.message);
});

logger.info('[POST WORKER] 📝 Worker inicializado (concurrency: 3)');

export default postWorker;
