import { generatePostForEspecialidade, ESPECIALIDADES, generateImageForEspecialidade, generateCaptionSEO, generateHooksViral } from '../services/gmbService.js';
import InstagramPost from '../models/InstagramPost.js';

/**
 * Lista posts do Instagram
 */
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
    console.error('❌ Erro ao listar posts Instagram:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Gera estatísticas dos posts
 */
export async function getStats(req, res) {
  try {
    const stats = await InstagramPost.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('❌ Erro ao buscar stats Instagram:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Gera novo post com IA + IMAGEM
 */
export async function generatePost(req, res) {
  try {
    const { especialidadeId, customTheme, funnelStage } = req.body;
    
    // Busca especialidade ou usa fonoaudiologia como padrão
    let especialidade = ESPECIALIDADES.find(e => e.id === especialidadeId);
    if (!especialidade) {
      especialidade = ESPECIALIDADES[0];
    }
    
    // Gera conteúdo do post com estratégia por funil
    const postData = await generatePostForEspecialidade(especialidade, customTheme, funnelStage || 'top');
    
    // Gera imagem em paralelo (usa mesma função do GMB - DALL-E 3 > HuggingFace > Pollinations)
    let mediaUrl = null;
    try {
      console.log('📸 Iniciando geração de imagem para Instagram...');
      mediaUrl = await generateImageForEspecialidade(especialidade, postData.content);
      console.log('📸 Resultado geração imagem:', mediaUrl);
      if (mediaUrl) {
        console.log('✅ Imagem gerada com sucesso:', mediaUrl);
      } else {
        console.warn('⚠️ Nenhuma URL de imagem retornada');
      }
    } catch (imgError) {
      console.warn('⚠️ Erro ao gerar imagem:', imgError.message);
      // Continua sem imagem se falhar
    }
    
    const post = new InstagramPost({
      title: postData.title,
      content: postData.content,
      theme: especialidade.id,
      funnelStage: funnelStage || 'top',
      status: 'draft',
      mediaUrl,
      mediaType: mediaUrl ? 'image' : null,
      aiGenerated: true,
      aiModel: 'gpt-4o-mini',
      createdBy: req.user?._id
    });
    
    await post.save();
    
    res.status(201).json({
      success: true,
      data: post,
      message: mediaUrl 
        ? '✅ Post Instagram + Imagem gerados com sucesso!' 
        : '✅ Post Instagram gerado (sem imagem)'
    });
  } catch (error) {
    console.error('❌ Erro ao gerar post Instagram:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Publica post no Instagram
 */
export async function publishPost(req, res) {
  try {
    const { id } = req.params;
    
    const post = await InstagramPost.findById(id);
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post não encontrado' });
    }
    
    // Aqui você integraria com a API do Instagram
    // Por enquanto, apenas marca como publicado
    post.status = 'published';
    post.publishedAt = new Date();
    await post.save();
    
    res.json({ success: true, data: post, message: 'Post publicado com sucesso' });
  } catch (error) {
    console.error('❌ Erro ao publicar post Instagram:', error);
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
    
    const post = await InstagramPost.findByIdAndUpdate(
      id,
      { content, mediaUrl, funnelStage },
      { new: true }
    );
    
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post não encontrado' });
    }
    
    res.json({ success: true, data: post });
  } catch (error) {
    console.error('❌ Erro ao atualizar post Instagram:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Deleta post
 */
export async function deletePost(req, res) {
  try {
    const { id } = req.params;
    
    const post = await InstagramPost.findByIdAndDelete(id);
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post não encontrado' });
    }
    
    res.json({ success: true, message: 'Post deletado com sucesso' });
  } catch (error) {
    console.error('❌ Erro ao deletar post Instagram:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Gera nova imagem para post existente
 */
export async function generateImageForPost(req, res) {
  try {
    const { id } = req.params;
    
    const post = await InstagramPost.findById(id);
    if (!post) {
      return res.status(404).json({ success: false, error: 'Post não encontrado' });
    }
    
    // Busca especialidade
    const especialidade = ESPECIALIDADES.find(e => e.id === post.theme) || ESPECIALIDADES[0];
    
    const imageUrl = await generateImageForEspecialidade(especialidade, post.content);
    
    if (!imageUrl) {
      return res.status(500).json({ success: false, error: 'Falha ao gerar imagem' });
    }
    
    post.mediaUrl = imageUrl;
    post.mediaType = 'image';
    await post.save();
    
    res.json({ success: true, data: { imageUrl } });
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
