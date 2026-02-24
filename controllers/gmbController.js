import GmbPost from '../models/GmbPost.js';
import * as gmbService from '../services/gmbService.js';

export async function listPosts(req, res) {
  try {
    const posts = await GmbPost.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: posts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function createPost(req, res) {
  try {
    const post = new GmbPost({ ...req.body, status: 'draft' });
    await post.save();
    res.status(201).json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getPost(req, res) {
  try {
    const post = await GmbPost.findById(req.params.id);
    res.json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function updatePost(req, res) {
  try {
    const post = await GmbPost.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function deletePost(req, res) {
  try {
    await GmbPost.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function publishPost(req, res) {
  try {
    const post = await GmbPost.findById(req.params.id);
    post.status = 'published';
    post.publishedAt = new Date();
    await post.save();
    res.json({ success: true, data: post });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function retryPost(req, res) {
  try {
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function generatePreview(req, res) {
  try {
    res.json({ success: true, data: { content: 'Preview' } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function generateImagePreview(req, res) {
  try {
    const { content, especialidadeId } = req.body;
    const imageData = await gmbService.generatePostImage(content, especialidadeId);
    res.json({ success: true, data: imageData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getStats(req, res) {
  try {
    const stats = await GmbPost.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function checkConnection(req, res) {
  try {
    res.json({ success: true, data: { connected: true } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getCronStatus(req, res) {
  try {
    res.json({ success: true, data: {} });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function triggerManualPublish(req, res) {
  try {
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function triggerManualGeneration(req, res) {
  try {
    const { especialidadeId, customTheme, generateImage, scheduledAt } = req.body;
    
    // Busca especialidade
    let especialidade = gmbService.ESPECIALIDADES.find(e => e.id === especialidadeId);
    if (!especialidade) {
      especialidade = gmbService.ESPECIALIDADES[0];
    }
    
    // Gera conteúdo
    const postData = await gmbService.generatePostForEspecialidade(especialidade, customTheme);
    
    // Gera imagem se solicitado
    let mediaUrl = null;
    if (generateImage) {
      try {
        console.log('🎨 Gerando imagem para GMB...');
        mediaUrl = await gmbService.generateImageForEspecialidade(especialidade, postData.content);
        console.log('✅ Imagem GMB:', mediaUrl);
      } catch (imgError) {
        console.warn('⚠️ Erro ao gerar imagem GMB:', imgError.message);
      }
    }
    
    // Determina o horário de agendamento
    let scheduledDate = null;
    if (scheduledAt) {
      scheduledDate = new Date(scheduledAt);
    } else {
      // Usa horário estratégico automático
      scheduledDate = getNextHorarioEstrategico();
    }
    
    // Cria post
    const post = new GmbPost({
      title: postData.title,
      content: postData.content,
      theme: especialidade.id,
      status: scheduledDate > new Date() ? 'scheduled' : 'draft',
      scheduledAt: scheduledDate,
      mediaUrl,
      mediaType: mediaUrl ? 'image' : null,
      aiGenerated: true,
      createdBy: req.user?._id
    });
    
    await post.save();
    
    res.json({ 
      success: true, 
      data: post,
      message: mediaUrl 
        ? `Post + imagem gerados! ${scheduledDate > new Date() ? `Agendado para ${scheduledDate.toLocaleString('pt-BR')}` : ''}`
        : `Post gerado (sem imagem) ${scheduledDate > new Date() ? `Agendado para ${scheduledDate.toLocaleString('pt-BR')}` : ''}`
    });
  } catch (error) {
    console.error('❌ Erro ao gerar post GMB:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * 🕐 Obtém próximo horário estratégico automático
 */
function getNextHorarioEstrategico() {
  const now = new Date();
  const currentHour = now.getHours();

  const horarios = gmbService.HORARIOS_PUBLICACAO.map(h => parseInt(h.split(':')[0]));

  for (const hora of horarios) {
    if (currentHour < hora) {
      now.setHours(hora, 0, 0, 0);
      return now;
    }
  }

  now.setDate(now.getDate() + 1);
  now.setHours(parseInt(gmbService.HORARIOS_PUBLICACAO[0]), 0, 0, 0);
  return now;
}

export async function triggerWeeklyGeneration(req, res) {
  try {
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function listEspecialidades(req, res) {
  try {
    res.json({ success: true, data: gmbService.ESPECIALIDADES });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
