/**
 * 🎬 Video Routes — Pipeline de vídeo 100% automático
 * 
 * Rotas:
 * - GET  /          → Lista vídeos
 * - POST /gerar     → Inicia pipeline (async, retorna jobId)
 * - GET  /status/:id → Status do job BullMQ
 * - POST /lote      → Gera múltiplos vídeos
 * - POST /:id/publish → Publica vídeo
 * - DELETE /:id     → Remove vídeo
 */

import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { videoGenerationQueue } from '../config/bullConfig.js';
import Video from '../models/Video.js';
import logger from '../utils/logger.js';
import { aplicarPosProducao } from '../services/video/posProducaoVeoService.js';
import fs from 'fs';

const router = Router();
router.use(auth);

// Listar vídeos (com detecção de vídeos travados)
router.get('/', async (req, res) => {
  try {
    const videos = await Video.find().sort({ createdAt: -1 }).lean();
    
    // Detectar vídeos "stale" (processando há mais de 30 minutos sem atualização)
    const THIRTY_MINUTES = 30 * 60 * 1000;
    const now = new Date();
    
    const processedVideos = videos.map(video => {
      // Se está processando há mais de 30 min, marca como possivelmente travado
      if (video.status === 'processing') {
        const lastUpdate = video.progresso?.atualizadoEm 
          ? new Date(video.progresso.atualizadoEm) 
          : new Date(video.createdAt);
        const timeSinceUpdate = now.getTime() - lastUpdate.getTime();
        
        if (timeSinceUpdate > THIRTY_MINUTES) {
          return {
            ...video,
            _staleWarning: true,
            _minutesProcessing: Math.floor(timeSinceUpdate / 60000)
          };
        }
      }
      return video;
    });
    
    res.json({ success: true, data: processedVideos });
  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao listar:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🆕 Função handler para iniciar pipeline
async function handleGenerateVideo(req, res) {
  try {
    const {
      tema,
      roteiro,
      especialidadeId,
      funil = 'TOPO',
      duracao,              // PT: enviado por clientes antigos
      duration,             // EN: enviado pelo frontend atual
      publicar = false,
      targeting = {},
      modo = 'avatar',      // 'avatar', 'ilustrativo', 'veo', 'economico'
      tone = 'educativo',   // 'emotional', 'educativo', 'inspiracional', 'bastidores'
      // 🧠 Campos de inteligência de conteúdo
      platform = 'instagram',   // 'instagram' | 'meta_ads'
      contentType = 'instagram', // 'instagram' | 'ads' | 'educativo' | 'viral'
      subTema,                  // 'atraso_fala' | 'autismo' | 'comportamento' | ...
      hookStyle = 'dor',        // 'dor' | 'alerta' | 'curiosidade' | 'erro_comum' | 'autoridade'
      objetivo = 'salvar',      // 'salvar' | 'compartilhar' | 'comentar' | 'agendar'
      variacao,                 // 0..1 — anti-repetição (gerado automaticamente se omitido)
      intensidade = 'viral',    // 'leve' | 'moderado' | 'forte' | 'viral'
      roteiroEditado = null     // roteiro pré-gerado (do modal de preview), pula ZEUS
    } = req.body;

    logger.info(`[VIDEO ROUTE] body recebido: modo=${modo} | especialidade=${especialidadeId} | duration=${duration}`);
    // Usar roteiro como tema se tema não foi enviado (aceita string vazia)
    const temaFinal = tema !== undefined ? tema : roteiro;
    // Prioridade: duration (frontend) → duracao (legado) → default 60
    const duracaoFinal = duration ?? duracao ?? 60;

    // Validação: temaFinal pode ser string vazia (geração automática)
    // mas não pode ser undefined/null; especialidadeId é obrigatório
    if (temaFinal === undefined || temaFinal === null || !especialidadeId) {
      return res.status(400).json({ 
        success: false, 
        error: 'tema (ou roteiro) e especialidadeId são obrigatórios' 
      });
    }

    // Nota: modo profissional tem fallback automático para HeyGen se Pexels não configurado

    // ✅ FIX 1: jobId gerado UMA vez só
    const jobId = `vid_${Date.now()}`;

    const variacaoFinal = variacao !== undefined ? Number(variacao) : Math.random();

    // Criar documento Video no Mongo (tracking)
    const videoDoc = await Video.create({
      title: `Vídeo ${especialidadeId} — ${temaFinal.substring(0, 30)}...`,
      roteiro: temaFinal,
      especialidadeId,
      status: 'processing',
      jobId,
      pipelineStatus: 'ROTEIRO',
      platform,
      contentType,
      subTema: subTema || null,
      hookStyle,
      objetivo,
      intensidade
    });

    // Enfileirar no BullMQ (sobrevive a restart)
    await videoGenerationQueue.add('generate-video', {
      jobId,
      videoDocId: videoDoc._id.toString(),
      tema: temaFinal,
      especialidadeId,
      funil,
      duracao: duracaoFinal,
      publicar,
      targeting,
      userId: req.user?._id,
      modo,
      tone,
      platform,
      contentType,
      subTema: subTema || null,
      hookStyle,
      objetivo,
      variacao: variacaoFinal,
      intensidade,
      roteiroEditado: roteiroEditado || null
    }, {
      jobId,
      priority: 1
    });

    // Retornar imediatamente (não espera o pipeline)
    const modoLabels = {
      avatar: '🎭 Avatar (HeyGen)',
      ilustrativo: '🖼️ Ilustrativo (Imagens + TTS)',
      veo: '🎬 Cinematográfico (Google Veo 3.1)'
    };

    const tempoEstimado = { avatar: '5-10 minutos', ilustrativo: '2-4 minutos', veo: '3-5 minutos' };

    res.status(202).json({
      success: true,
      message: `Pipeline de vídeo iniciado (${modoLabels[modo] || modo})`,
      jobId,
      videoId: videoDoc._id,
      status: 'ROTEIRO',
      modo,
      tempo_estimado: tempoEstimado[modo] || '5-10 minutos',
      status_url: `/api/videos/status/${jobId}`
    });

  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao iniciar pipeline:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

// 🆕 POST / (raiz) e /gerar — ambos iniciam pipeline
router.post('/', handleGenerateVideo);
router.post('/gerar', handleGenerateVideo);

// 🆕 POST /preview-roteiro — Gera apenas o roteiro (ZEUS), sem iniciar o pipeline de vídeo
// Usado pelo frontend para mostrar/editar o roteiro antes de gerar
router.post('/preview-roteiro', async (req, res) => {
  try {
    const {
      tema = '',
      especialidadeId,
      funil = 'TOPO',
      duracao = 60,
      tone = 'educativo',
      platform = 'instagram',
      subTema,
      hookStyle = 'dor',
      objetivo = 'salvar',
      intensidade = 'viral'
    } = req.body;

    if (!especialidadeId) {
      return res.status(400).json({ success: false, error: 'especialidadeId obrigatório' });
    }

    const { gerarRoteiro } = await import('../agents/zeus-video.js');
    const { roteiro } = await gerarRoteiro({
      tema,
      especialidade: especialidadeId,
      funil,
      duracao,
      tone,
      platform,
      subTema,
      hookStyle,
      objetivo,
      variacao: Math.random(),
      intensidade
    });

    res.json({
      success: true,
      roteiro: {
        titulo: roteiro.titulo,
        texto_completo: roteiro.texto_completo,
        hook_texto_overlay: roteiro.hook_texto_overlay,
        cta_texto_overlay: roteiro.cta_texto_overlay,
        hashtags: roteiro.hashtags,
        legenda_instagram: roteiro.legenda_instagram,
        profissional: roteiro.profissional,
        duracao_estimada: roteiro.duracao_estimada
      }
    });
  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao gerar preview roteiro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🆕 GET /voices — Lista vozes disponíveis do HeyGen
router.get('/voices', async (req, res) => {
  try {
    const axios = (await import('axios')).default;
    const API_KEY = process.env.HEYGEN_API_KEY;
    
    if (!API_KEY) {
      return res.status(503).json({ success: false, error: 'HEYGEN_API_KEY não configurado' });
    }

    const { data } = await axios.get('https://api.heygen.com/v2/voices', {
      headers: { 'X-Api-Key': API_KEY }
    });

    // Filtrar apenas vozes em português
    const voices = data.data.voices || [];
    const ptVoices = voices.filter((v) => 
      v.language?.toLowerCase().includes('portuguese') || 
      v.language_code?.toLowerCase().startsWith('pt')
    );

    res.json({
      success: true,
      data: {
        total: voices.length,
        portuguese: ptVoices.map(v => ({
          voice_id: v.voice_id,
          name: v.name,
          language: v.language,
          language_code: v.language_code,
          gender: v.gender,
          preview: v.preview_audio
        })),
        all: voices.slice(0, 20).map(v => ({  // Limitar a 20 para não poluir
          voice_id: v.voice_id,
          name: v.name,
          language: v.language_code || v.language
        }))
      }
    });
  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao listar vozes:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🆕 GET /status/:jobId — Status do job BullMQ
router.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    // Buscar no BullMQ
    const job = await videoGenerationQueue.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ 
        success: false, 
        error: 'Job não encontrado' 
      });
    }

    const state = await job.getState();
    const progress = job.progress || 0;
    
    // Buscar no MongoDB também (mais detalhes)
    const videoDoc = await Video.findOne({ jobId }).lean();

    res.json({
      success: true,
      data: {
        jobId,
        bullState: state,  // 'waiting', 'active', 'completed', 'failed'
        progress,
        pipelineStatus: videoDoc?.pipelineStatus || 'ROTEIRO',
        videoStatus: videoDoc?.status,
        videoUrl: videoDoc?.videoFinalUrl || videoDoc?.videoUrl,
        resultado: job.returnvalue || null,
        failedReason: job.failedReason || null,
        attemptsMade: job.attemptsMade || 0,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao consultar status:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🆕 POST /lote — Gera múltiplos vídeos
router.post('/lote', async (req, res) => {
  try {
    const { videos } = req.body;  // Array de { tema, especialidadeId, funil }
    
    if (!Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Array de vídeos obrigatório' 
      });
    }

    if (videos.length > 10) {
      return res.status(400).json({ 
        success: false, 
        error: 'Máximo 10 vídeos por lote' 
      });
    }

    const jobs = [];
    
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      const jobId = `vid_${Date.now()}_${i}`;
      
      const loteVariacao = Math.random();

      // Criar doc
      const videoDoc = await Video.create({
        title: `Vídeo ${video.especialidadeId} — ${video.tema?.substring(0, 30) || 'Sem título'}...`,
        roteiro: 'Gerando...',
        especialidadeId: video.especialidadeId,
        status: 'processing',
        jobId,
        pipelineStatus: 'ROTEIRO',
        platform: video.platform || 'instagram',
        contentType: video.contentType || 'instagram',
        subTema: video.subTema || null,
        hookStyle: video.hookStyle || 'dor',
        objetivo: video.objetivo || 'salvar',
        intensidade: video.intensidade || 'viral'
      });

      // Enfileirar
      const job = await videoGenerationQueue.add('generate-video', {
        jobId,
        videoDocId: videoDoc._id.toString(),
        tema: video.tema,
        especialidadeId: video.especialidadeId,
        funil: video.funil || 'TOPO',
        duracao: video.duracao || 60,
        publicar: video.publicar || false,
        targeting: video.targeting || {},
        userId: req.user?._id,
        platform: video.platform || 'instagram',
        contentType: video.contentType || 'instagram',
        subTema: video.subTema || null,
        hookStyle: video.hookStyle || 'dor',
        objetivo: video.objetivo || 'salvar',
        variacao: loteVariacao,
        intensidade: video.intensidade || 'viral'
      }, { jobId });

      jobs.push({ jobId, videoId: videoDoc._id, bullJobId: job.id });
    }
    
    res.json({
      success: true,
      message: `${videos.length} vídeos na fila`,
      jobs,
      tempo_estimado: `${Math.ceil(videos.length * 8)} minutos`
    });

  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao criar lote:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rotas legadas (mantidas para compatibilidade)
router.post('/:id/publish', async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Vídeo não encontrado' });
    }
    
    video.publishedChannels = req.body.channels || [];
    video.publishedAt = new Date();
    await video.save();
    
    res.json({ success: true, data: video });
  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao publicar:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await Video.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao deletar:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🆕 POST /:id/pos-producao — Aplica legendas, música e CTA ao vídeo pronto
router.post('/:id/pos-producao', async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Vídeo não encontrado' });
    }
    if (video.status !== 'ready') {
      return res.status(400).json({ success: false, error: 'Vídeo ainda não está pronto' });
    }

    const { legendas = true, musica = null, cta = null } = req.body;
    const videoUrl = video.videoUrl || video.videoFinalUrl;

    if (!videoUrl) {
      return res.status(400).json({ success: false, error: 'URL do vídeo não encontrada' });
    }

    // Salvar configuração e marcar como processando edição
    video.posProducaoConfig = { legendas, musica, cta };
    video.posProducaoStatus = 'processing';
    await video.save();

    // Responde imediatamente (202) e processa em background
    res.status(202).json({
      success: true,
      message: 'Pós-produção iniciada — vídeo editado disponível em alguns minutos',
      videoId: video._id
    });

    // Processo assíncrono em background
    (async () => {
      try {
        logger.info(`[POS-PRODUCAO] 🎬 Iniciando edição vídeo ${video._id}`);
        logger.info(`[POS-PRODUCAO] Config: legendas=${legendas}, musica=${musica}, cta=${JSON.stringify(cta)}`);
        
        const editadoUrl = await aplicarPosProducao({
          videoId: video._id.toString(),
          videoUrl,
          roteiro: video.roteiro || '',
          legendas,
          musica,
          cta
        });

        await Video.findByIdAndUpdate(video._id, {
          videoEditadoUrl: editadoUrl,
          posProducaoStatus: 'ready',
          'posProducaoConfig.aplicadoEm': new Date()
        });

        logger.info(`[POS-PRODUCAO] ✅ Vídeo ${video._id} editado: ${editadoUrl}`);
      } catch (err) {
        logger.error(`[POS-PRODUCAO] ❌ Erro vídeo ${video._id}: ${err.message}`);
        logger.error(`[POS-PRODUCAO] Stack: ${err.stack}`);
        await Video.findByIdAndUpdate(video._id, {
          posProducaoStatus: 'failed',
          posProducaoError: err.message
        }).catch(() => {});
      }
    })();

  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao iniciar pós-produção:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /:id — Busca vídeo por ID (para polling pós-produção)
router.get('/:id', async (req, res) => {
  try {
    const video = await Video.findById(req.params.id).lean();
    if (!video) return res.status(404).json({ success: false, error: 'Vídeo não encontrado' });
    res.json({ success: true, data: video });
  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao buscar vídeo:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /:id/force-fail — Força a marcação de um vídeo como falho (para vídeos travados)
router.post('/:id/force-fail', async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Vídeo não encontrado' });
    }
    
    if (video.status !== 'processing') {
      return res.status(400).json({ success: false, error: 'Vídeo não está em processamento' });
    }
    
    await Video.findByIdAndUpdate(req.params.id, {
      status: 'failed',
      pipelineStatus: 'ERRO',
      errorMessage: 'Marcado como falho manualmente (vídeo travado em processamento)',
      'progresso.etapa': 'ERRO',
      'progresso.percentual': 0,
      'progresso.atualizadoEm': new Date()
    });
    
    logger.info(`[VIDEO ROUTES] Vídeo ${req.params.id} marcado como falho manualmente`);
    res.json({ success: true, message: 'Vídeo marcado como falho' });
  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao forçar falha:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /cleanup-stalled — Limpa todos os vídeos travados há mais de 30 min
router.post('/admin/cleanup-stalled', async (req, res) => {
  try {
    const THIRTY_MINUTES = 30 * 60 * 1000;
    const cutoff = new Date(Date.now() - THIRTY_MINUTES);
    
    const stalledVideos = await Video.find({
      status: 'processing',
      createdAt: { $lt: cutoff }
    });
    
    let updated = 0;
    for (const video of stalledVideos) {
      await Video.findByIdAndUpdate(video._id, {
        status: 'failed',
        pipelineStatus: 'ERRO',
        errorMessage: 'Job stalled - processamento excedeu 30 minutos',
        'progresso.etapa': 'ERRO',
        'progresso.percentual': 0,
        'progresso.atualizadoEm': new Date()
      });
      updated++;
    }
    
    logger.info(`[VIDEO ROUTES] Cleanup concluído: ${updated} vídeos travados marcados como falhos`);
    res.json({ success: true, message: `${updated} vídeos atualizados` });
  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro no cleanup:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /:id/publish-meta — Publica vídeo no Meta Ads (Tráfego Pago)
router.post('/:id/publish-meta', async (req, res) => {
  try {
    const { copy, nomeCampanha, targeting } = req.body;
    
    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Vídeo não encontrado' });
    }
    
    if (video.status !== 'ready') {
      return res.status(400).json({ success: false, error: 'Vídeo ainda não está pronto' });
    }
    
    // Verificar se tem URL do vídeo
    const videoUrl = video.videoUrl || video.videoFinalUrl || video.videoEditadoUrl;
    if (!videoUrl) {
      return res.status(400).json({ success: false, error: 'URL do vídeo não disponível' });
    }
    
    // Importar serviço de publicação Meta
    const { publicarVideo } = await import('../services/meta/videoPublisher.js');
    
    // Baixar vídeo temporariamente
    const response = await fetch(videoUrl);
    if (!response.ok) {
      throw new Error('Falha ao baixar vídeo');
    }
    
    const videoBuffer = Buffer.from(await response.arrayBuffer());
    const tempPath = `/tmp/video_${video._id}.mp4`;
    await fs.promises.writeFile(tempPath, videoBuffer);
    
    // Publicar no Meta
    const resultado = await publicarVideo({
      videoPath: tempPath,
      copy: copy || {
        texto_primario: video.roteiro?.substring(0, 500) || 'Assista agora!',
        headline: nomeCampanha || `Campanha ${video.especialidadeId || 'Video'}`,
        descricao: 'Clique para saber mais no WhatsApp'
      },
      nomeCampanha: nomeCampanha || `[VIDEO] ${video.especialidadeId || 'Campanha'}_${Date.now()}`,
      targeting: targeting || {}
    });
    
    // Limpar arquivo temporário
    await fs.promises.unlink(tempPath).catch(() => {});
    
    // Atualizar vídeo com info da campanha
    video.publishedChannels = [...(video.publishedChannels || []), 'meta_ads'];
    video.metaCampaignId = resultado.campaign_id;
    video.metaAdId = resultado.ad_id;
    await video.save();
    
    logger.info(`[VIDEO ROUTES] ✅ Vídeo publicado no Meta Ads: ${resultado.campaign_id}`);
    
    res.json({
      success: true,
      message: 'Vídeo publicado no Meta Ads!',
      data: resultado
    });
    
  } catch (error) {
    logger.error('[VIDEO ROUTES] Erro ao publicar no Meta:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
