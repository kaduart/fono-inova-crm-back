/**
 * 📸 Instagram Controller - Fono Inova
 * Headline curta (imagem) + Legenda estratégica
 */

import { 
  generateInstagramPost, 
  regenerateImageForPost,
  gerarHeadline,
  gerarLegenda
} from '../services/instagramPostService.js';
import { ESPECIALIDADES } from '../services/gmbService.js';
import InstagramPost from '../models/InstagramPost.js';
import { postGenerationQueue } from '../config/bullConfig.js';

export async function listPosts(req, res) {
  try {
    const { status, limit = 50 } = req.query;
    const query = {};
    if (status && status !== 'all') query.status = status;
    
    const posts = await InstagramPost.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    
    res.json({ success: true, data: posts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getStats(req, res) {
  try {
    const stats = await InstagramPost.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function generatePost(req, res) {
  try {
    const { especialidadeId, customTheme, funnelStage, provider = 'auto' } = req.body;
    
    const especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
    
    // Criar post imediatamente com status 'processing'
    const post = new InstagramPost({
      title: 'Gerando conteúdo...',
      headline: 'Aguarde...',
      content: 'Nossa IA está criando seu post do Instagram.',
      caption: 'Gerando legenda...',
      theme: especialidade.id,
      status: 'processing',
      processingStatus: 'processing',
      mediaUrl: null,
      funnelStage: funnelStage || 'top',
      aiGenerated: true,
      createdBy: req.user?._id
    });
    
    await post.save();
    
    // Enfileirar job para processar em background
    const jobId = `post_ig_${Date.now()}`;
    await postGenerationQueue.add('generate-post', {
      postId: post._id.toString(),
      channel: 'instagram',
      especialidadeId: especialidade.id,
      customTheme,
      funnelStage: funnelStage || 'top',
      provider: provider || 'auto',
      generateImage: true,
      userId: req.user?._id
    }, { jobId });
    
    // Retornar imediatamente
    res.status(202).json({
      success: true,
      message: '📸 Post Instagram em processamento!',
      postId: post._id,
      jobId,
      status: 'processing',
      status_url: `/api/instagram/posts/${post._id}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function publishPost(req, res) {
  try {
    const post = await InstagramPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });
    
    post.status = 'published';
    post.publishedAt = new Date();
    await post.save();
    
    res.json({ 
      success: true, 
      data: post,
      copyText: `${post.headline}\n\n${post.caption}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function updatePost(req, res) {
  try {
    const post = await InstagramPost.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });
    res.json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function deletePost(req, res) {
  try {
    await InstagramPost.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Post deletado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function generateImageForPost(req, res) {
  try {
    const post = await InstagramPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });
    
    const mediaUrl = await regenerateImageForPost(post);
    if (!mediaUrl) return res.status(500).json({ success: false, error: 'Falha' });
    
    res.json({ success: true, data: { imageUrl: mediaUrl } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Preview headline
export async function generateHeadlinePreview(req, res) {
  try {
    const { especialidadeId, funnelStage } = req.body;
    const esp = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
    const headline = await gerarHeadline({ especialidade: esp, funnelStage: funnelStage || 'top' });
    res.json({ success: true, data: headline });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Preview legenda
export async function generateCaptionPreview(req, res) {
  try {
    const { especialidadeId, funnelStage, headline } = req.body;
    const esp = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
    const legenda = await gerarLegenda({ 
      especialidade: esp, 
      headline: headline || 'Headline exemplo',
      funnelStage: funnelStage || 'top'
    });
    res.json({ success: true, data: legenda });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Preview completo
export async function previewContent(req, res) {
  try {
    const { especialidadeId, funnelStage } = req.body;
    const esp = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
    
    const [headline, legenda] = await Promise.all([
      gerarHeadline({ especialidade: esp, funnelStage: funnelStage || 'top' }),
      gerarLegenda({ especialidade: esp, headline: 'Preview', funnelStage: funnelStage || 'top' })
    ]);
    
    res.json({
      success: true,
      data: { headline, legenda, especialidade: esp.nome }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
