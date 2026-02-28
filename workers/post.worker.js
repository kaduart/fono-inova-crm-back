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
import { redisConnection } from '../config/redisConnection.js';
import { getIo } from '../config/socket.js';
import logger from '../utils/logger.js';

// Models
import GmbPost from '../models/GmbPost.js';
import InstagramPost from '../models/InstagramPost.js';
import FacebookPost from '../models/FacebookPost.js';

// Services
import * as gmbService from '../services/gmbService.js';
import { generateInstagramPost, regenerateImageForPost, gerarHeadline, generateImage as gerarImagemBase, IMAGE_TYPES } from '../services/instagramPostService.js';
import { generateCaptionSEO, generateHooksViral } from '../services/gmbService.js';
import { gerarImagemBranded } from '../services/brandImageService.js';

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
    userId
  } = job.data;

  logger.info(`[POST WORKER] ▶ ${channel}/${postId} — ${especialidadeId}`);

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
      postData = await gmbService.generatePostForEspecialidade(especialidade, customTheme, funnelStage);
      
      if (generateImage) {
        try {
          const imgResult = await gmbService.generateImageForEspecialidade(especialidade, postData.content, false, provider);
          mediaUrl = imgResult?.url || null;
          imageProvider = imgResult?.provider || null;
        } catch (imgError) {
          logger.warn(`[POST WORKER] Erro imagem GMB: ${imgError.message}`);
        }
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
        ctaUrl: especialidade.url || null
      });

    } else if (channel === 'instagram') {
      // Instagram: gerar conteúdo baseado no modo selecionado pelo usuário
      const mode = job.data.mode || 'full'; // 'full' | 'caption' | 'hooks'
      logger.info(`[POST WORKER] Instagram modo: ${mode}`);

      // Headline curta para a imagem (sempre necessária)
      const headline = await gerarHeadline({ especialidade, funnelStage, customTheme });

      let legenda;
      if (mode === 'hooks') {
        // 🎣 GANCHOS VIRAIS: Gera 10 ganchos para usar nos Reels
        const hooksResult = await generateHooksViral(especialidade, customTheme, funnelStage, 10);
        legenda = hooksResult.content;
      } else {
        // ✨ FULL ou 📝 CAPTION SEO: legenda com keyword density + CTA por funil
        const captionResult = await generateCaptionSEO(especialidade, customTheme || headline, funnelStage);
        legenda = captionResult.content;
      }

      // Gerar imagem base
      const imageResult = await gerarImagemBase({
        especialidade,
        headline,
        tipoImagem: IMAGE_TYPES.FOTO_REAL
      }).catch(e => { logger.warn(`[POST WORKER] Erro imagem IG: ${e.message}`); return null; });

      let mediaUrl = imageResult?.url || null;
      let imageProvider = imageResult?.provider || null;

      // Aplicar branding visual
      if (mediaUrl) {
        try {
          const branded = await gerarImagemBranded({
            fotoUrl: mediaUrl,
            titulo: headline,
            postContent: `${headline}\n\n${legenda}`,
            especialidadeId: especialidade.id
          });
          mediaUrl = branded.url;
        } catch (e) {
          logger.warn(`[POST WORKER] Branding IG falhou: ${e.message}`);
        }
      }

      // Atualizar o post EXISTENTE (sem criar novo)
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
        imageProvider,
        scheduledAt: isScheduled ? new Date(scheduledAt) : null,
        aiGenerated: true,
        processingStatus: 'completed',
        funnelStage
      });

    } else if (channel === 'facebook') {
      // Facebook: Similar ao GMB
      postData = await gmbService.generatePostForEspecialidade(especialidade, customTheme, funnelStage);
      
      if (generateImage) {
        try {
          const imgResult = await gmbService.generateImageForEspecialidade(especialidade, postData.content);
          mediaUrl = imgResult?.url || null;
          imageProvider = imgResult?.provider || null;
        } catch (imgError) {
          logger.warn(`[POST WORKER] Erro imagem Facebook: ${imgError.message}`);
        }
      }

      await Model.findByIdAndUpdate(postId, {
        title: postData.title,
        content: postData.content,
        theme: especialidade.id,
        status: 'draft',
        mediaUrl,
        mediaType: mediaUrl ? 'image' : null,
        imageProvider,
        aiGenerated: true,
        processingStatus: 'completed',
        funnelStage
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
