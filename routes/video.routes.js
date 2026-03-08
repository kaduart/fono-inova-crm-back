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

const router = Router();
router.use(auth);

// Listar vídeos
router.get('/', async (req, res) => {
  try {
    const videos = await Video.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: videos });
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
      duracao = 60, 
      duration,
      publicar = false,
      targeting = {},
      modo = 'avatar'  // 'avatar' ou 'ilustrativo'
    } = req.body;

    // Usar roteiro como tema se tema não foi enviado (aceita string vazia)
    const temaFinal = tema !== undefined ? tema : roteiro;
    const duracaoFinal = duracao || duration || 60;

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

    // Criar documento Video no Mongo (tracking)
    const videoDoc = await Video.create({
      title: `Vídeo ${especialidadeId} — ${temaFinal.substring(0, 30)}...`,
      roteiro: temaFinal,
      especialidadeId,
      status: 'processing',
      jobId,
      pipelineStatus: 'ROTEIRO'
    });

    // ✅ FIX 5 & 7: Enfileirar no BullMQ (sobrevive a restart)
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
      modo
    }, { 
      jobId,  // Usa mesmo ID pro job BullMQ
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
      
      // Criar doc
      const videoDoc = await Video.create({
        title: `Vídeo ${video.especialidadeId} — ${video.tema?.substring(0, 30) || 'Sem título'}...`,
        roteiro: 'Gerando...',
        especialidadeId: video.especialidadeId,
        status: 'processing',
        jobId,
        pipelineStatus: 'ROTEIRO'
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
        userId: req.user?._id
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

export default router;
