/**
 * 🎯 Marketing Routes - Consolidado
 * GMB + Instagram + Facebook + Vídeos + Spy em um único arquivo
 */

import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import GmbPost from '../models/GmbPost.js';
import Video from '../models/Video.js';
import AdSpy from '../models/AdSpy.js';
import * as marketingService from '../services/marketingService.js';

const router = Router();
router.use(auth);

// ═══════════════════════════════════════════════════════════════════════════════
// 📍 GMB (Google Meu Negócio)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/gmb/posts', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const query = status ? { status } : {};
    const skip = (page - 1) * limit;
    
    const [posts, total] = await Promise.all([
      GmbPost.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      GmbPost.countDocuments(query)
    ]);
    
    res.json({ success: true, data: posts, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/gmb/posts', async (req, res) => {
  try {
    const post = new GmbPost({ ...req.body, status: 'draft' });
    await post.save();
    res.status(201).json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/gmb/posts/:id', async (req, res) => {
  try {
    const post = await GmbPost.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });
    res.json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/gmb/posts/:id', async (req, res) => {
  try {
    await GmbPost.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/gmb/posts/:id/publish', async (req, res) => {
  try {
    const post = await GmbPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });
    
    post.status = 'published';
    post.publishedAt = new Date();
    await post.save();
    
    res.json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/gmb/preview/image', async (req, res) => {
  try {
    const { content, especialidadeId } = req.body;
    const imageData = await marketingService.generateImage(content, especialidadeId);
    if (!imageData) return res.status(500).json({ success: false, error: 'Falha ao gerar imagem' });
    res.json({ success: true, data: imageData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 📸 Instagram & Facebook (Mesma estrutura)
// ═══════════════════════════════════════════════════════════════════════════════

['instagram', 'facebook'].forEach(platform => {
  router.get(`/${platform}/posts`, async (req, res) => {
    try {
      const posts = await GmbPost.find({ platform }).sort({ createdAt: -1 }).lean();
      res.json({ success: true, data: posts });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post(`/${platform}/posts`, async (req, res) => {
    try {
      const post = new GmbPost({ ...req.body, platform, status: 'draft' });
      await post.save();
      res.status(201).json({ success: true, data: post });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post(`/${platform}/posts/:id/publish`, async (req, res) => {
    try {
      const post = await GmbPost.findById(req.params.id);
      if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });
      post.status = 'published';
      post.publishedAt = new Date();
      await post.save();
      res.json({ success: true, data: post });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🎬 Vídeos (HeyGen)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/videos', async (req, res) => {
  try {
    const videos = await Video.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: videos });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/videos', async (req, res) => {
  try {
    const { especialidadeId, roteiro, funnelStage = 'top' } = req.body;
    
    const video = new Video({
      title: `Vídeo ${especialidadeId}`,
      roteiro: roteiro || 'Gerando...',
      especialidadeId,
      funnelStage,
      status: 'processing'
    });
    await video.save();
    
    // Processa em background
    marketingService.generateVideo({ video, especialidadeId, roteiro, funnelStage }).catch(err => {
      console.error('Erro no vídeo:', err);
      video.status = 'failed';
      video.errorMessage = err.message;
      video.save();
    });
    
    res.status(201).json({ success: true, data: video });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/videos/:id', async (req, res) => {
  try {
    await Video.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/videos/:id/publish', async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ success: false, error: 'Vídeo não encontrado' });
    video.publishedChannels = req.body.channels || [];
    video.publishedAt = new Date();
    await video.save();
    res.json({ success: true, data: video });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🔍 Spy (Concorrentes)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/spy/ads', async (req, res) => {
  try {
    const { keyword, especialidade } = req.query;
    const ads = await marketingService.searchSpyAds({ keyword, especialidade });
    res.json({ success: true, data: ads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/spy/analyze', async (req, res) => {
  try {
    const { adText } = req.body;
    const analysis = await marketingService.analyzeAd(adText);
    res.json({ success: true, data: analysis });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/spy/saved', async (req, res) => {
  try {
    const ads = await AdSpy.find({ saved: true }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: ads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/spy/saved', async (req, res) => {
  try {
    const ad = new AdSpy({ ...req.body, saved: true });
    await ad.save();
    res.status(201).json({ success: true, data: ad });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 📊 Estatísticas Gerais
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/stats', async (req, res) => {
  try {
    const [gmbCount, videoCount, spyCount] = await Promise.all([
      GmbPost.countDocuments(),
      Video.countDocuments(),
      AdSpy.countDocuments({ saved: true })
    ]);
    
    res.json({
      success: true,
      data: {
        gmb: { total: gmbCount },
        videos: { total: videoCount },
        spy: { total: spyCount }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
