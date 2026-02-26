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
      targeting = {}
    } = req.body;

    // Usar roteiro como tema se tema não foi enviado
    const temaFinal = tema || roteiro;
    const duracaoFinal = duracao || duration || 60;

    // Validação
    if (!temaFinal || !especialidadeId) {
      return res.status(400).json({ 
        success: false, 
        error: 'tema (ou roteiro) e especialidadeId são obrigatórios' 
      });
    }

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
      userId: req.user?._id
    }, { 
      jobId,  // Usa mesmo ID pro job BullMQ
      priority: 1
    });

    // Retornar imediatamente (não espera o pipeline)
    res.status(202).json({
      success: true,
      message: 'Pipeline de vídeo iniciado',
      jobId,
      videoId: videoDoc._id,
      status: 'ROTEIRO',
      tempo_estimado: '5-10 minutos',
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
