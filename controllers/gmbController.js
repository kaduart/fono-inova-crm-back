import GmbPost from '../models/GmbPost.js';
import * as gmbService from '../services/gmbService.js';
import * as makeService from '../services/makeService.js';
import { postGenerationQueue } from '../config/bullConfig.js';

// Listar posts com paginação
export async function listPosts(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    
    const [posts, total] = await Promise.all([
      GmbPost.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      GmbPost.countDocuments()
    ]);
    
    res.json({ 
      success: true, 
      data: posts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Criar post
export async function createPost(req, res) {
  try {
    const post = new GmbPost({ ...req.body, status: 'draft' });
    await post.save();
    res.status(201).json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Buscar post
export async function getPost(req, res) {
  try {
    const post = await GmbPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });
    res.json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Atualizar post
export async function updatePost(req, res) {
  try {
    const post = await GmbPost.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });
    res.json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Deletar post
export async function deletePost(req, res) {
  try {
    await GmbPost.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Publicar post via Make (para posts com status 'scheduled')
export async function publishPost(req, res) {
  try {
    const post = await GmbPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });

    if (!makeService.isMakeConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Make não configurado. Adicione MAKE_WEBHOOK_URL no .env'
      });
    }

    await makeService.sendPostToMake(post);

    post.status = 'published';
    post.publishedAt = new Date();
    post.publishedBy = 'api';
    await post.save();

    res.json({ success: true, message: 'Post enviado ao Make para publicação!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Republicar post via Make (para posts já publicados ou com falha)
export async function republishPost(req, res) {
  try {
    const post = await GmbPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });

    if (!makeService.isMakeConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Make não configurado. Adicione MAKE_WEBHOOK_URL no .env'
      });
    }

    await makeService.sendPostToMake(post);

    post.status = 'published';
    post.publishedAt = new Date();
    post.publishedBy = 'api';
    post.retryCount = (post.retryCount || 0) + 1;
    await post.save();

    res.json({ success: true, message: 'Post reenviado ao Make para republicação!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Stats
export async function getStats(req, res) {
  try {
    const stats = await GmbPost.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Status da conexão (agora informa sobre Make)
export async function checkConnection(req, res) {
  try {
    const makeOk = makeService.isMakeConfigured();
    res.json({
      success: true,
      data: {
        connected: makeOk,
        mode: 'make',
        message: makeOk ? 'Make configurado ✅' : 'MAKE_WEBHOOK_URL não configurado'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Preview de imagem
export async function generateImagePreview(req, res) {
  try {
    const { content, especialidadeId } = req.body;
    const imageData = await gmbService.generatePostImage(content, especialidadeId);
    res.json({ success: true, data: imageData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Preview
export async function generatePreview(req, res) {
  try {
    res.json({ success: true, data: { content: 'Preview' } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Listar especialidades
export async function listEspecialidades(req, res) {
  try {
    res.json({ success: true, data: gmbService.ESPECIALIDADES });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Cron status
export async function getCronStatus(req, res) {
  try {
    res.json({
      success: true,
      data: {
        makeConfigured: makeService.isMakeConfigured(),
        schedules: ['Geração: diariamente 8h', 'Envio ao Make: diariamente 8h05']
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Gerar post manualmente (trigger admin) — AGORA ASYNC
export async function triggerManualGeneration(req, res) {
  try {
    const { especialidadeId, customTheme, generateImage, scheduledAt, provider, tone = 'emotional' } = req.body;
    const funnelStage = req.body.funnelStage || 'top';

    let especialidade = gmbService.ESPECIALIDADES.find(e => e.id === especialidadeId);
    if (!especialidade) especialidade = gmbService.ESPECIALIDADES[0];

    // Criar post imediatamente com status 'processing'
    const isScheduled = Boolean(scheduledAt);
    const post = new GmbPost({
      title: 'Gerando conteúdo...',
      content: 'Aguarde, nossa IA está criando seu post personalizado.',
      theme: especialidade.id,
      status: 'processing',  // Status temporário durante geração
      processingStatus: 'processing',
      scheduledAt: isScheduled ? new Date(scheduledAt) : null,
      mediaUrl: null,
      mediaType: null,
      ctaUrl: especialidade.url || null,
      ctaType: 'LEARN_MORE',
      aiGenerated: true,
      createdBy: req.user?._id
    });

    await post.save();

    // Enfileirar job para processar em background
    const jobId = `post_${Date.now()}`;
    await postGenerationQueue.add('generate-post', {
      postId: post._id.toString(),
      channel: 'gmb',
      especialidadeId: especialidade.id,
      customTheme,
      funnelStage,
      tone,
      scheduledAt,
      generateImage: generateImage !== false,
      provider: provider || 'auto',
      userId: req.user?._id
    }, { jobId });

    // Retornar imediatamente (não espera o processamento)
    res.status(202).json({
      success: true,
      message: isScheduled ? '📅 Post em processamento para agendamento!' : '📝 Post em processamento!',
      postId: post._id,
      jobId,
      status: 'processing',
      status_url: `/api/gmb/posts/${post._id}`
    });
  } catch (error) {
    console.error('Erro ao iniciar geração de post:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// Gerar semana de posts
export async function triggerWeeklyGeneration(req, res) {
  try {
    const results = await gmbService.generateWeekPosts();
    const count = results.filter(r => r.success).length;
    res.json({
      success: true,
      data: results,
      message: `${count}/7 posts gerados para a semana`
    });
  } catch (error) {
    console.error('Erro ao gerar semana:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// Trigger manual de publicação (envia ao Make)
export async function triggerManualPublish(req, res) {
  try {
    if (!makeService.isMakeConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Make não configurado. Adicione MAKE_WEBHOOK_URL no .env'
      });
    }

    const posts = await GmbPost.findScheduledForPublish(1);
    if (posts.length === 0) {
      return res.json({ success: true, message: 'Nenhum post agendado pendente' });
    }

    const post = posts[0];
    await makeService.sendPostToMake(post);
    post.status = 'published';
    post.publishedAt = new Date();
    post.publishedBy = 'api';
    await post.save();

    res.json({ success: true, message: 'Post enviado ao Make!', postId: post._id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Retry post
export async function retryPost(req, res) {
  try {
    const post = await GmbPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });

    if (!makeService.isMakeConfigured()) {
      return res.status(503).json({ success: false, error: 'Make não configurado' });
    }

    await makeService.sendPostToMake(post);
    post.status = 'published';
    post.publishedAt = new Date();
    await post.save();

    res.json({ success: true, message: 'Post reenviado ao Make!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// 🤖 CRIAR POST ASSISTIDO
export async function createAssistedPost(req, res) {
  try {
    const { especialidadeId, customTheme } = req.body;

    const result = await gmbService.createAssistedPost({
      especialidadeId,
      customTheme,
      userId: req.user?._id
    });

    res.json({
      success: true,
      data: result,
      message: 'Post criado! Copie o texto e imagem para publicar no Google.'
    });
  } catch (error) {
    console.error('Erro ao criar post assistido:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// Copiar texto do post assistido
export async function copyPostText(req, res) {
  try {
    const post = await GmbPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });

    post.assistData = post.assistData || {};
    post.assistData.copiedAt = new Date();
    await post.save();

    res.json({
      success: true,
      copyText: post.assistData?.copyText || post.content,
      mediaUrl: post.mediaUrl
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Marcar post assistido como publicado manualmente
export async function markAsPublished(req, res) {
  try {
    const post = await GmbPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });

    post.status = 'published';
    post.publishedAt = new Date();
    post.publishedBy = 'manual';
    await post.save();

    res.json({ success: true, message: 'Post marcado como publicado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// 🔗 CALLBACK DO MAKE — Make avisa quando publicou no Google
export async function makeCallback(req, res) {
  try {
    const { postId, status, gmbPostId, error: makeError } = req.body;

    if (!postId) return res.status(400).json({ success: false, error: 'postId obrigatório' });

    const post = await GmbPost.findById(postId);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });

    if (status === 'published') {
      post.status = 'published';
      post.publishedAt = new Date();
      if (gmbPostId) post.gmbPostId = gmbPostId;
    } else if (status === 'failed') {
      await post.markFailed(makeError || 'Falha reportada pelo Make');
    }

    await post.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Regenerar imagem de um post existente
export async function regenerateImage(req, res) {
  try {
    const post = await GmbPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, error: 'Post não encontrado' });

    const especialidade =
      gmbService.ESPECIALIDADES.find(e => e.id === post.theme) ||
      gmbService.ESPECIALIDADES[0];

    const imgResult = await gmbService.generateImageForEspecialidade(especialidade, post.content, false);

    if (!imgResult?.url) {
      return res.status(500).json({ success: false, error: 'Falha ao gerar imagem' });
    }

    post.mediaUrl = imgResult.url;
    post.imageProvider = imgResult.provider;
    post.mediaType = 'image';
    await post.save();

    res.json({ success: true, data: { mediaUrl: imgResult.url }, message: 'Imagem regenerada!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// Placeholders — inteligência em desenvolvimento
export async function getIntelligentSuggestion(req, res) {
  res.json({ success: true, data: null, message: 'Em desenvolvimento' });
}

export async function getIntelligenceData(req, res) {
  res.json({
    success: true,
    data: { vagas: { count: 0 }, vendas: { count: 0 }, reviews: { count: 0 }, jaPostouHoje: false },
    message: 'Em desenvolvimento'
  });
}

export async function acceptSuggestion(req, res) {
  res.json({ success: false, error: 'Em desenvolvimento' });
}

export async function generateWeekAssisted(req, res) {
  res.json({ success: false, error: 'Em desenvolvimento' });
}

export async function createSmartPost(req, res) {
  res.json({ success: false, error: 'Em desenvolvimento' });
}

// 🟢 GERAR LEGENDA SEO
export async function generateCaption(req, res) {
  try {
    const { especialidadeId, customTheme, funnelStage } = req.body;
    
    let especialidade = gmbService.ESPECIALIDADES.find(e => e.id === especialidadeId);
    if (!especialidade) especialidade = gmbService.ESPECIALIDADES[0];

    const result = await gmbService.generateCaptionSEO(especialidade, customTheme, funnelStage || 'top');
    
    res.json({
      success: true,
      data: result,
      message: '📝 Legenda SEO gerada com sucesso!'
    });
  } catch (error) {
    console.error('Erro ao gerar legenda:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// 🟡 GERAR GANCHOS VIRAIS
export async function generateHooks(req, res) {
  try {
    const { especialidadeId, customTheme, funnelStage, count } = req.body;
    
    let especialidade = gmbService.ESPECIALIDADES.find(e => e.id === especialidadeId);
    if (!especialidade) especialidade = gmbService.ESPECIALIDADES[0];

    const result = await gmbService.generateHooksViral(especialidade, customTheme, funnelStage || 'top', count || 10);
    
    res.json({
      success: true,
      data: result,
      message: `🎣 ${count || 10} Ganchos virais gerados!`
    });
  } catch (error) {
    console.error('Erro ao gerar ganchos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// 🎯 VARIAÇÕES A/B
export async function generateVariations(req, res) {
  try {
    const { especialidadeId, funnelStage, tone, customTheme } = req.body;
    const esp = gmbService.ESPECIALIDADES.find(e => e.id === especialidadeId) || gmbService.ESPECIALIDADES[0];
    const result = await gmbService.generateContentVariations(esp, customTheme, funnelStage || 'top', tone || 'emotional', 3);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// 📊 SCORE DE QUALIDADE
export async function scoreContent(req, res) {
  try {
    const { content, funnelStage } = req.body;
    if (!content) return res.status(400).json({ success: false, error: 'content obrigatório' });
    const score = await gmbService.scorePostQuality(content, funnelStage || 'top');
    res.json({ success: true, score });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
