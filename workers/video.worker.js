/**
 * 🎬 Video Worker — Processa jobs de geração de vídeo
 * 
 * Pipeline completo:
 * 1. ZEUS → Gerar roteiro estruturado
 * 2. HeyGen → Gerar vídeo talking head
 * 3. FFmpeg → Pós-produção (legendas, logo, CTA, música)
 * 4. Meta → Publicar campanha (opcional)
 */

import { Worker } from 'bullmq';
import { redisConnection } from '../config/redisConnection.js';
import { getIo } from '../config/socket.js';
import logger from '../utils/logger.js';

// Serviços do pipeline
import { gerarRoteiro } from '../agents/zeus-video.js';
import { gerarVideo } from '../services/video/heygenService.js';
import { gerarVideoIlustrativo } from '../services/video/slideshowService.js';
import { posProducao } from '../services/video/postProduction.js';
import { publicarVideo } from '../services/meta/videoPublisher.js';
import { nomearCampanha, FUNIS } from '../agents/heracles.js';
import Video from '../models/Video.js';

// ─────────────────────────────────────────────────────────────────────────────
// WORKER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

const videoWorker = new Worker('video-generation', async (job) => {
  const { 
    jobId, 
    videoDocId,
    tema, 
    especialidadeId, 
    funil = 'TOPO', 
    duracao = 60, 
    publicar = false, 
    targeting = {},
    userId,
    modo = 'avatar'  // 'avatar' (HeyGen) ou 'profissional' (Stock + TTS)
  } = job.data;

  logger.info(`[VIDEO WORKER] ▶ ${jobId} — "${tema}"`);
  
  // Helper: atualizar progresso no Mongo + Socket.IO
  const atualizarProgresso = async (etapa, percentual, extra = {}) => {
    try {
      await Video.findByIdAndUpdate(videoDocId, {
        pipelineStatus: etapa,
        'progresso.etapa': etapa,
        'progresso.percentual': percentual,
        'progresso.atualizadoEm': new Date(),
        [`tempos.${etapa.toLowerCase().replace('_', '')}Em`]: new Date(),
        ...extra
      });

      // Emitir via Socket.IO
      const io = getIo();
      io.emit(`video-progress-${jobId}`, {
        jobId,
        etapa,
        percentual,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      logger.warn(`[VIDEO WORKER] Erro ao atualizar progresso: ${e.message}`);
    }
  };

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // ETAPA 1: Gerar Roteiro (ZEUS)
    // ═══════════════════════════════════════════════════════════════════════
    await atualizarProgresso('ROTEIRO', 10);
    
    const { roteiro } = await gerarRoteiro({ 
      tema, 
      especialidade: especialidadeId, 
      funil, 
      duracao 
    });

    await atualizarProgresso('ROTEIRO', 25, {
      roteiro: roteiro.texto_completo,
      roteiroEstruturado: {
        titulo: roteiro.titulo,
        profissional: roteiro.profissional,
        duracaoEstimada: roteiro.duracao_estimada,
        textoCompleto: roteiro.texto_completo,
        hookTextoOverlay: roteiro.hook_texto_overlay,
        ctaTextoOverlay: roteiro.cta_texto_overlay,
        hashtags: roteiro.hashtags,
        copyAnuncio: roteiro.copy_anuncio
      },
      especialidadeId: roteiro.profissional
    });

    logger.info(`[VIDEO WORKER] Roteiro gerado: ${roteiro.profissional} | ${roteiro.titulo}`);

    // ═══════════════════════════════════════════════════════════════════════
    // ETAPA 2: Gerar Vídeo (Avatar ou Ilustrativo)
    // ═══════════════════════════════════════════════════════════════════════
    await atualizarProgresso('HEYGEN', 30);

    let videoCru;
    
    if (modo === 'ilustrativo') {
      logger.info(`[VIDEO WORKER] Modo ILUSTRATIVO - Slideshow de imagens + TTS`);
      videoCru = await gerarVideoIlustrativo({
        especialidadeId,
        roteiro: roteiro.texto_completo,
        titulo: roteiro.titulo,
        duracao
      });
    } else {
      logger.info(`[VIDEO WORKER] Modo AVATAR - Usando HeyGen`);
      videoCru = await gerarVideo({
        profissional: roteiro.profissional,
        textoFala: roteiro.texto_completo,
        titulo: roteiro.titulo
      });
    }

    await atualizarProgresso('HEYGEN', 60, {
      videoCruUrl: videoCru,
      status: 'processing'
    });

    logger.info(`[VIDEO WORKER] Vídeo cru gerado: ${videoCru}`);

    // ═══════════════════════════════════════════════════════════════════════
    // ETAPA 3: Pós-Produção (FFmpeg) - Só para avatar
    // ═══════════════════════════════════════════════════════════════════════
    let videoFinal;
    
    if (modo === 'ilustrativo') {
      // Modo ilustrativo: vídeo já está finalizado (slideshow + narração)
      logger.info(`[VIDEO WORKER] Modo ilustrativo - pulando pós-produção`);
      videoFinal = videoCru;
      await atualizarProgresso('POS_PRODUCAO', 90, {
        videoFinalUrl: videoFinal,
        videoUrl: videoFinal
      });
    } else {
      // Modo avatar: aplicar pós-produção (legendas, logo, etc)
      await atualizarProgresso('POS_PRODUCAO', 65);
      
      videoFinal = await posProducao({
        videoInput: videoCru,
        hookTexto: roteiro.hook_texto_overlay,
        ctaTexto: roteiro.cta_texto_overlay,
        musica: funil === 'TOPO' ? 'calma' : 'esperancosa',
        titulo: roteiro.titulo
      });

      await atualizarProgresso('POS_PRODUCAO', 90, {
        videoFinalUrl: videoFinal,
        videoUrl: videoFinal  // compatibilidade
      });

      logger.info(`[VIDEO WORKER] Pós-produção concluída: ${videoFinal}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ETAPA 4: Upload Meta (Opcional)
    // ═══════════════════════════════════════════════════════════════════════
    let metaResult = null;

    if (publicar) {
      await atualizarProgresso('UPLOAD', 92);

      const nomeCampanha = nomearCampanha({
        funil: FUNIS[funil] || funil,
        especialidade: especialidadeId,
        formato: 'REELS'
      });

      try {
        metaResult = await publicarVideo({
          videoPath: videoFinal,
          copy: roteiro.copy_anuncio,
          nomeCampanha,
          targeting
        });

        await atualizarProgresso('UPLOAD', 95, {
          metaCampaignId: metaResult.campaign_id,
          metaCreativeId: metaResult.creative_id,
          metaAdsetId: metaResult.adset_id,
          metaAdId: metaResult.ad_id
        });

        logger.info(`[VIDEO WORKER] Campanha Meta criada: ${metaResult.campaign_id}`);
      } catch (metaErr) {
        logger.error(`[VIDEO WORKER] Erro Meta (não crítico): ${metaErr.message}`);
        // Não falha o job se Meta der erro — vídeo ainda está pronto
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONCLUÍDO
    // ═══════════════════════════════════════════════════════════════════════
    await atualizarProgresso('CONCLUIDO', 100, {
      status: 'ready',
      tempos: { concluidoEm: new Date() }
    });

    // Notificar conclusão
    const io = getIo();
    io.emit(`video-complete-${jobId}`, {
      jobId,
      status: 'CONCLUIDO',
      videoUrl: videoFinal,
      roteiro: roteiro.titulo,
      meta: metaResult
    });

    logger.info(`[VIDEO WORKER] ✅ ${jobId} concluído em ${(Date.now() - job.timestamp) / 1000}s`);

    return {
      jobId,
      status: 'CONCLUIDO',
      roteiro: {
        titulo: roteiro.titulo,
        profissional: roteiro.profissional,
        duracao: roteiro.duracao_estimada
      },
      videoFinal,
      meta: metaResult
    };

  } catch (error) {
    const errorMsg = error?.message || error?.toString() || 'Erro desconhecido';
    const errorStack = error?.stack || '';
    logger.error(`[VIDEO WORKER] ❌ ${jobId} falhou: ${errorMsg}`);
    if (errorStack) logger.error(`[VIDEO WORKER] Stack: ${errorStack}`);
    
    // Atualizar como erro
    try {
      await Video.findByIdAndUpdate(videoDocId, {
        status: 'failed',
        pipelineStatus: 'ERRO',
        errorMessage: errorMsg.substring(0, 500),
        'progresso.etapa': 'ERRO',
        'progresso.percentual': 0
      });

      const io = getIo();
      io.emit(`video-progress-${jobId}`, {
        jobId,
        etapa: 'ERRO',
        percentual: 0,
        erro: error.message
      });
    } catch (e) {
      // Ignora erro de atualização
    }

    throw error;
  }
}, {
  connection: redisConnection,
  concurrency: 2,  // Máx 2 HeyGens simultâneos (rate limit)
  limiter: {
    max: 10,
    duration: 60000  // 10 jobs por minuto
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────

videoWorker.on('completed', (job, result) => {
  logger.info(`[VIDEO WORKER] ✅ Job ${job.id} finalizado: ${result?.jobId}`);
});

videoWorker.on('failed', (job, err) => {
  logger.error(`[VIDEO WORKER] ❌ Job ${job?.id} falhou: ${err.message}`);
});

videoWorker.on('error', (err) => {
  logger.error('[VIDEO WORKER] Erro no worker:', err.message);
});

logger.info('[VIDEO WORKER] 🎬 Worker inicializado (concurrency: 2)');

export default videoWorker;
