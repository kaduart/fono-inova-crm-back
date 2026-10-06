/**
 * 🎨 Post Generator Controller (Simplificado - sem geração de imagem)
 * Apenas texto/legenda - imagem vem de IA externa (Midjourney, etc)
 */

import { generateInstagramPostV2, regenerateImageForPostV2 } from '../services/instagramPostService.js';
import InstagramPost from '../models/InstagramPost.js';
import { ESPECIALIDADES } from '../services/gmbService.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

// ============================================================================
// 🚀 GERAÇÃO PRINCIPAL
// ============================================================================

/**
 * POST /api/instagram/generate-v2
 * Gera post apenas com texto/legenda (imagem manual)
 */
export async function generatePostV2(req, res) {
  try {
    const {
      especialidadeId,
      funnelStage = 'top',
      customTheme = null
    } = req.body;
    
    if (!especialidadeId) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'especialidadeId é obrigatório', { status: 400 }), req);
    }
    
    console.log('📸 [v2] Gerando post texto:', { especialidadeId, funnelStage });
    
    // Gerar post apenas com texto
    const resultado = await generateInstagramPostV2({
      especialidadeId,
      funnelStage,
      customTheme,
      userId: req.user?._id
    });
    
    res.status(201).json({
      success: true,
      message: '📸 Post gerado com sucesso! Adicione a imagem manualmente do Midjourney/etc.',
      data: {
        postId: resultado.post._id,
        headline: resultado.data.headline,
        legenda: resultado.data.legenda,
        mediaUrl: null,
        nota: 'Adicione a imagem gerada em IA externa manualmente'
      }
    });
    
  } catch (error) {
    console.error('❌ Erro na geração v2:', error);
    sendApiError(res, error, req);
  }
}

/**
 * POST /api/instagram/posts/:id/regenerate
 * Limpa imagem para usuário adicionar nova manualmente
 */
export async function regeneratePostImage(req, res) {
  try {
    const post = await InstagramPost.findById(req.params.id);
    
    if (!post) {
      return sendApiError(res, new AppError('NOT_FOUND', 'Post não encontrado', { status: 404 }), req);
    }
    
    await regenerateImageForPostV2(post);
    
    res.json({
      success: true,
      message: '🎨 Imagem removida. Adicione nova imagem manualmente do Midjourney/etc.',
      data: {
        mediaUrl: null
      }
    });
    
  } catch (error) {
    console.error('❌ Erro na regeneração:', error);
    sendApiError(res, error, req);
  }
}

// ============================================================================
// 👁️ PREVIEWS (simplificados)
// ============================================================================

export async function previewLayoutById(req, res) {
  sendApiError(
    res,
    new AppError('BAD_REQUEST', 'Previews de layout desabilitados. Use IA externa (Midjourney) para imagens.', {
      status: 400,
    }),
    req
  );
}

export async function previewAutoLayout(req, res) {
  sendApiError(
    res,
    new AppError('BAD_REQUEST', 'Previews automáticos desabilitados. Use IA externa (Midjourney) para imagens.', {
      status: 400,
    }),
    req
  );
}

// ============================================================================
// 📊 LISTAGENS SIMPLES
// ============================================================================

export async function listLayouts(req, res) {
  res.json({
    success: true,
    data: {
      message: 'Layouts automáticos desabilitados. Use Midjourney/etc para criativos.',
      total: 0,
      layouts: []
    }
  });
}

export async function getLayoutStatistics(req, res) {
  res.json({
    success: true,
    data: {
      message: 'Estatísticas de layout desabilitadas',
      porLayout: [],
      resumo: {}
    }
  });
}

export async function listEspecialidadesComLayouts(req, res) {
  const mapeamento = ESPECIALIDADES.map(esp => ({
    id: esp.id,
    nome: esp.nome,
    nota: 'Use IA externa (Midjourney) para criativos profissionais'
  }));
    
  res.json({
    success: true,
    data: mapeamento
  });
}

// ============================================================================
// 🔧 ADMIN
// ============================================================================

export async function reprocessHistory(req, res) {
  res.json({
    success: true,
    message: 'Histórico de layouts limpo (funcionalidade desabilitada)'
  });
}

export default {
  generatePostV2,
  regeneratePostImage,
  previewLayoutById,
  previewAutoLayout,
  listLayouts,
  getLayoutStatistics,
  listEspecialidadesComLayouts,
  reprocessHistory
};
