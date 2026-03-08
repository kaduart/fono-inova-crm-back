import { generatePostForEspecialidade, ESPECIALIDADES, generateImageForEspecialidade, generateCaptionSEO, generateHooksViral, generateContentVariations, scorePostQuality } from '../services/gmbService.js';
import FacebookPost from '../models/FacebookPost.js';
import { postGenerationQueue } from '../config/bullConfig.js';

/**
 * Lista posts do Facebook
 */
export async function listPosts(req, res) {
  try {
    const { status, limit = 50 } = req.query;
    
    const query = {};
    if (status && status !== 'all') query.status = status;
    
    const posts = await FacebookPost.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    
    res.json({ success: true, data: posts });
  } catch (error) {
    console.error('❌ Erro ao listar posts Facebook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Gera estatísticas dos posts
 */
export async function getStats(req, res) {
  try {
    const stats = await FacebookPost.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('❌ Erro ao buscar stats Facebook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Gera novo post com IA + IMAGEM — AGORA ASYNC
 */
export async function generatePost(req, res) {
  try {
    const { especialidadeId, customTheme, funnelStage, provider = 'auto', mode = 'full', tone = 'emotional', scheduledAt } = req.body;

    // Busca especialidade ou usa fonoaudiologia como padrão
    let especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId);
    if (!especialidade) {
      especialidade = ESPECIALIDADES[0];
    }

    const modeLabel = mode === 'caption' ? '📝 Gerando legenda SEO...' : mode === 'hooks' ? '🎣 Gerando ganchos virais...' : '📘 Gerando post...';

    // Criar post imediatamente com status 'processing'
    const post = new FacebookPost({
      title: modeLabel,
      content: 'Nossa IA está criando seu post do Facebook.',
      theme: especialidade.id,
      funnelStage: funnelStage || 'top',
      status: 'processing',
      processingStatus: 'processing',
      mediaUrl: null,
      mediaType: null,
      aiGenerated: true,
      createdBy: req.user?._id
    });

    await post.save();

    // Enfileirar job para processar em background
    const jobId = `post_fb_${Date.now()}`;
    await postGenerationQueue.add('generate-post', {
      postId: post._id.toString(),
      channel: 'facebook',
      especialidadeId: especialidade.id,
      customTheme,
      funnelStage: funnelStage || 'top',
      provider: provider || 'auto',
      generateImage: true,
      userId: req.user?._id,
      mode,
      tone,
      scheduledAt
    }, { jobId });
    
    // Retornar imediatamente
    res.status(202).json({
      success: true,
      message: '📘 Post Facebook em processamento!',
      postId: post._id,
      jobId,
      status: 'processing',
      status_url: `/api/facebook/posts/${post._id}`
    });
  } catch (error) {
    console.error('❌ Erro ao iniciar geração de post Facebook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Publica post no Facebook
 */
export async function publishPost(req, res) {
  try {
    const { id } = req.params;
    
    const post = await FacebookPost.findById(id);
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post não encontrado' });
    }
    
    // Aqui você integraria com a API do Facebook
    // Por enquanto, apenas marca como publicado
    post.status = 'published';
    post.publishedAt = new Date();
    await post.save();
    
    res.json({ success: true, data: post, message: 'Post publicado com sucesso' });
  } catch (error) {
    console.error('❌ Erro ao publicar post Facebook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Atualiza post
 */
export async function updatePost(req, res) {
  try {
    const { id } = req.params;
    const { content, mediaUrl, funnelStage } = req.body;
    
    const post = await FacebookPost.findByIdAndUpdate(
      id,
      { content, mediaUrl, funnelStage },
      { new: true }
    );
    
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post não encontrado' });
    }
    
    res.json({ success: true, data: post });
  } catch (error) {
    console.error('❌ Erro ao atualizar post Facebook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Deleta post
 */
export async function deletePost(req, res) {
  try {
    const { id } = req.params;
    
    const post = await FacebookPost.findByIdAndDelete(id);
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post não encontrado' });
    }
    
    res.json({ success: true, message: 'Post deletado com sucesso' });
  } catch (error) {
    console.error('❌ Erro ao deletar post Facebook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Gera nova imagem para post existente
 */
export async function generateImageForPost(req, res) {
  try {
    const { id } = req.params;
    
    const post = await FacebookPost.findById(id);
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post não encontrado' });
    }
    
    // Busca especialidade
    const especialidade = ESPECIALIDADES.find(e => e.id === post.theme) || ESPECIALIDADES[0];
    
    const imgResult = await generateImageForEspecialidade(especialidade, post.content);
    
    if (!imgResult?.url) {
      return res.status(500).json({ success: false, error: 'Falha ao gerar imagem' });
    }
    
    post.mediaUrl = imgResult.url;
    post.imageProvider = imgResult.provider;
    post.mediaType = 'image';
    await post.save();
    
    res.json({ success: true, data: { imageUrl: imgResult.url, provider: imgResult.provider } });
  } catch (error) {
    console.error('❌ Erro ao gerar imagem:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// 🟢 GERAR LEGENDA SEO
export async function generateCaption(req, res) {
  try {
    const { especialidadeId, customTheme, funnelStage } = req.body;
    
    let especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId);
    if (!especialidade) especialidade = ESPECIALIDADES[0];

    const result = await generateCaptionSEO(especialidade, customTheme, funnelStage || 'top');
    
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

    let especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId);
    if (!especialidade) especialidade = ESPECIALIDADES[0];

    const result = await generateHooksViral(especialidade, customTheme, funnelStage || 'top', count || 10);

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
    const esp = ESPECIALIDADES.find(e => e.id === especialidadeId) || ESPECIALIDADES[0];
    const result = await generateContentVariations(esp, customTheme, funnelStage || 'top', tone || 'emotional', 3);
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
    const score = await scorePostQuality(content, funnelStage || 'top');
    res.json({ success: true, score });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
