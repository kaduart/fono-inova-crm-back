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
import { ESPECIALIDADES, generateCaptionSEO, generateHooksViral, generateContentVariations, scorePostQuality } from '../services/gmbService.js';
import InstagramPost from '../models/InstagramPost.js';
import { postGenerationQueue } from '../config/bullConfig.js';
import { publishToInstagram } from '../services/meta/metaPublisher.js';
import { uploadToCloudinary } from '../services/media/mediaUploadService.js';

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
    const { especialidadeId, customTheme, funnelStage, provider = 'auto', mode = 'full', tone = 'emotional', scheduledAt } = req.body;

    const especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];

    const modeLabel = mode === 'caption' ? '📝 Gerando legenda SEO...' : mode === 'hooks' ? '🎣 Gerando ganchos virais...' : '📸 Gerando post...';

    // Criar post imediatamente com status 'processing'
    const post = new InstagramPost({
      title: modeLabel,
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
      userId: req.user?._id,
      mode,       // 'full' | 'caption' | 'hooks'
      tone,       // 'emotional' | 'educativo' | 'inspiracional' | 'bastidores'
      scheduledAt // ISO string ou undefined
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

export async function approvePost(req, res) {
  try {
    const post = await InstagramPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });
    if (!['draft', 'failed'].includes(post.status)) {
      return res.status(400).json({ success: false, error: `Post com status '${post.status}' não pode ser aprovado` });
    }

    post.status = 'approved';
    await post.save();

    res.json({ success: true, data: post, message: '✅ Post aprovado — pronto para publicar' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function publishPost(req, res) {
  try {
    // target: 'organic' | 'paid' | 'both' (default: 'organic')
    const { target = 'organic', campaign } = req.body;

    const post = await InstagramPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });
    if (!['approved', 'draft'].includes(post.status)) {
      return res.status(400).json({ success: false, error: `Post com status '${post.status}' não pode ser publicado` });
    }
    if (!post.mediaUrl) {
      return res.status(400).json({ success: false, error: 'Post sem imagem — gere ou faça upload de uma imagem antes de publicar' });
    }

    const caption = post.caption || `${post.headline}\n\n${post.content}`;
    const result = { success: true, data: post };

    // 1️⃣ Orgânico — publica no feed do Instagram
    if (target === 'organic' || target === 'both') {
      const igPostId = await publishToInstagram({ imageUrl: post.mediaUrl, caption });
      await post.markPublished(igPostId);
      result.igPostId = igPostId;
      result.message = '📸 Post publicado no Instagram!';
    }

    // 2️⃣ Pago — cria campanha na Meta Ads
    if (target === 'paid' || target === 'both') {
      try {
        const { publicarVideo } = await import('../services/meta/videoPublisher.js');
        const adResult = await publicarVideo({
          videoPath: post.mediaUrl, // URL pública (Cloudinary)
          copy: {
            texto_primario: caption,
            headline: post.headline || 'Agende sua consulta',
            descricao: post.subheadline || ''
          },
          nomeCampanha: campaign?.name || `CRM - ${post.theme} - ${new Date().toLocaleDateString('pt-BR')}`,
          targeting: campaign?.targeting || {}
        });
        result.campaign = adResult;
        result.message = target === 'both'
          ? '📸 Publicado + campanha criada!'
          : '📢 Campanha criada na Meta Ads!';
      } catch (adErr) {
        // Campanha falhou mas não bloqueia o orgânico
        result.campaignError = adErr.message;
      }
    }

    res.json(result);
  } catch (error) {
    await InstagramPost.findByIdAndUpdate(req.params.id, { status: 'failed', errorMessage: error.message });
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

// Upload de mídia externa (imagem/vídeo criado fora do CRM)
export async function uploadMedia(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });

    const post = await InstagramPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });

    const { url, resourceType } = await uploadToCloudinary(
      req.file.buffer,
      req.file.mimetype,
      'instagram'
    );

    post.mediaUrl = url;
    post.mediaType = resourceType === 'video' ? 'video' : 'image';
    post.imageProvider = 'upload-externo';
    await post.save();

    res.json({ success: true, data: { mediaUrl: url, mediaType: post.mediaType }, message: '✅ Arquivo enviado com sucesso' });
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

// 📝 GERAR LEGENDA SEO (modo "Só Legenda SEO")
export async function generateCaption(req, res) {
  try {
    const { especialidadeId, customTheme, funnelStage } = req.body;
    let especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
    const result = await generateCaptionSEO(especialidade, customTheme, funnelStage || 'top');
    res.json({ success: true, data: result, message: '📝 Legenda SEO gerada!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// 🎣 GERAR GANCHOS VIRAIS (modo "10 Ganchos Virais")
export async function generateHooks(req, res) {
  try {
    const { especialidadeId, customTheme, funnelStage, count } = req.body;
    let especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
    const result = await generateHooksViral(especialidade, customTheme, funnelStage || 'top', count || 10);
    res.json({ success: true, data: result, message: `🎣 ${count || 10} Ganchos gerados!` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// 🎯 GERAR VARIAÇÕES A/B (3 aberturas diferentes)
export async function generateVariations(req, res) {
  try {
    const { especialidadeId, funnelStage, tone, customTheme } = req.body;
    const esp = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
    const result = await generateContentVariations(esp, customTheme, funnelStage || 'top', tone || 'emotional', 3);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// 📊 SCORE DE QUALIDADE DE UM POST
export async function scoreContent(req, res) {
  try {
    const { content, funnelStage } = req.body;
    if (!content) return res.status(400).json({ success: false, error: 'content obrigatório' });
    const score = await scorePostQuality(content, funnelStage || 'top');
    res.json({ success: true, score });
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
