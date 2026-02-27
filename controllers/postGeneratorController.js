/**
 * 🎨 Post Generator Controller
 * Controller para o novo sistema de geração de posts com layouts dinâmicos
 */

import {
  gerarPostComRotacao,
  regenerarImagemPost,
  previewLayout,
  getEstatisticas
} from '../services/postGeneratorService.js';
import {
  selecionarLayoutInteligente,
  getLayoutStats
} from '../services/layoutEngine.js';
import { getLayoutsForEspecialidade, LAYOUTS } from '../config/layoutsConfig.js';
import InstagramPost from '../models/InstagramPost.js';
import { ESPECIALIDADES } from '../services/gmbService.js';

// ============================================================================
// 🚀 GERAÇÃO PRINCIPAL
// ============================================================================

/**
 * POST /api/instagram/generate-v2
 * Gera post completo com rotação automática de layouts
 */
export async function generatePostV2(req, res) {
  try {
    const {
      especialidadeId,
      headline,
      caption,
      hook,
      categoriaPreferida,
      funnelStage = 'top'
    } = req.body;
    
    // Validações
    if (!especialidadeId) {
      return res.status(400).json({
        success: false,
        error: 'especialidadeId é obrigatório'
      });
    }
    
    if (!headline) {
      return res.status(400).json({
        success: false,
        error: 'headline é obrigatório'
      });
    }
    
    console.log('📸 [v2] Gerando post:', { especialidadeId, headline: headline.substring(0, 30) });
    
    // Gerar post com rotação automática
    const resultado = await gerarPostComRotacao({
      especialidadeId,
      conteudo: caption || headline,
      headline,
      hook: hook || caption?.substring(0, 50),
      categoriaPreferida,
      channel: 'instagram'
    });
    
    // Criar documento no MongoDB
    const post = new InstagramPost({
      title: headline,
      headline,
      content: caption || headline,
      caption: caption || headline,
      theme: especialidadeId,
      funnelStage,
      status: 'draft',
      mediaUrl: resultado.url,
      mediaType: 'image',
      aiGenerated: true,
      imageProvider: resultado.imageProvider,
      layoutId: resultado.layoutId, // Novo campo
      createdBy: req.user?._id,
      metadata: {
        customTheme: null,
        headlineStrategy: resultado.layoutCategoria
      }
    });
    
    await post.save();
    
    // Atualizar histórico com referência ao post
    // (opcional: pode ser feito no service)
    
    res.status(201).json({
      success: true,
      message: '📸 Post gerado com sucesso!',
      data: {
        postId: post._id,
        mediaUrl: resultado.url,
        layout: {
          id: resultado.layoutId,
          nome: resultado.layoutNome,
          categoria: resultado.layoutCategoria
        },
        provider: resultado.imageProvider,
        tempo: resultado.tempo,
        proximoLayoutSugerido: resultado.proximoLayoutSugerido
      }
    });
    
  } catch (error) {
    console.error('❌ Erro na geração v2:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

/**
 * POST /api/instagram/posts/:id/regenerate
 * Regenera imagem mantendo o mesmo conteúdo
 */
export async function regeneratePostImage(req, res) {
  try {
    const post = await InstagramPost.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({
        success: false,
        error: 'Post não encontrado'
      });
    }
    
    // Extrair hook do caption
    const hook = post.caption?.split('\n')[0]?.substring(0, 50) || '';
    
    const resultado = await regenerarImagemPost({
      especialidadeId: post.theme,
      headline: post.headline,
      hook,
      // Não passa layoutId para forçar seleção de novo layout
    });
    
    // Atualizar post
    post.mediaUrl = resultado.url;
    post.imageProvider = resultado.imageProvider;
    post.layoutId = resultado.layoutId;
    await post.save();
    
    res.json({
      success: true,
      message: '🎨 Imagem regenerada!',
      data: {
        mediaUrl: resultado.url,
        layout: {
          id: resultado.layoutId,
          nome: resultado.layoutNome
        },
        provider: resultado.imageProvider
      }
    });
    
  } catch (error) {
    console.error('❌ Erro na regeneração:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// ============================================================================
// 👁️ PREVIEWS E TESTES
// ============================================================================

/**
 * POST /api/instagram/preview/layout
 * Preview de layout específico (não salva no histórico)
 */
export async function previewLayoutById(req, res) {
  try {
    const { layoutId, especialidadeId, headline, hook } = req.body;
    
    if (!layoutId || !headline) {
      return res.status(400).json({
        success: false,
        error: 'layoutId e headline são obrigatórios'
      });
    }
    
    const resultado = await previewLayout({
      layoutId,
      especialidadeId: especialidadeId || 'fonoaudiologia',
      headline,
      hook
    });
    
    res.json({
      success: true,
      data: {
        previewUrl: resultado.url,
        layout: {
          id: resultado.layout.id,
          nome: resultado.layout.nome,
          categoria: resultado.layout.categoria,
          specs: resultado.layout.specs
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Erro no preview:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * POST /api/instagram/preview/auto
 * Preview com seleção automática de layout
 */
export async function previewAutoLayout(req, res) {
  try {
    const { especialidadeId, headline, hook, categoriaPreferida } = req.body;
    
    // Selecionar layout (mas não registrar uso)
    const layout = await selecionarLayoutInteligente(
      especialidadeId,
      categoriaPreferida,
      'instagram'
    );
    
    // Preview com esse layout
    const resultado = await previewLayout({
      layoutId: layout.id,
      especialidadeId,
      headline,
      hook
    });
    
    res.json({
      success: true,
      data: {
        previewUrl: resultado.url,
        layoutSelecionado: {
          id: layout.id,
          nome: layout.nome,
          categoria: layout.categoria
        },
        obs: 'Este layout seria usado na geração real (round-robin)'
      }
    });
    
  } catch (error) {
    console.error('❌ Erro no preview auto:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// ============================================================================
// 📊 ESTATÍSTICAS E CONFIGURAÇÕES
// ============================================================================

/**
 * GET /api/instagram/layouts
 * Lista todos os layouts disponíveis
 */
export async function listLayouts(req, res) {
  try {
    const { especialidadeId } = req.query;
    
    let layouts;
    if (especialidadeId) {
      layouts = getLayoutsForEspecialidade(especialidadeId);
    } else {
      layouts = Object.values(LAYOUTS);
    }
    
    // Simplificar para resposta
    const layoutsSimplificados = layouts.map(l => ({
      id: l.id,
      nome: l.nome,
      categoria: l.categoria,
      frequencia: l.frequencia,
      fotoRatio: l.specs.fotoRatio,
      usoEsperado: l.specs.uso || []
    }));
    
    res.json({
      success: true,
      data: {
        total: layoutsSimplificados.length,
        layouts: layoutsSimplificados
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * GET /api/instagram/layouts/stats
 * Estatísticas de uso dos layouts
 */
export async function getLayoutStatistics(req, res) {
  try {
    const { especialidadeId } = req.query;
    
    const [statsHistorico, statsService] = await Promise.all([
      getLayoutStats(especialidadeId),
      getEstatisticas(especialidadeId)
    ]);
    
    res.json({
      success: true,
      data: {
        porLayout: statsHistorico,
        resumo: statsService,
        distribuicaoPorCategoria: calcularDistribuicao(statsHistorico)
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * GET /api/instagram/especialidades
 * Lista especialidades com categorias mapeadas
 */
export async function listEspecialidadesComLayouts(req, res) {
  try {
    const { ESPECIALIDADE_CATEGORIAS } = await import('../config/layoutsConfig.js');
    
    const mapeamento = ESPECIALIDADES.map(esp => ({
      id: esp.id,
      nome: esp.nome,
      categorias: ESPECIALIDADE_CATEGORIAS[esp.id] || ['foto_terapia'],
      totalLayouts: getLayoutsForEspecialidade(esp.id).length
    }));
    
    res.json({
      success: true,
      data: mapeamento
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// ============================================================================
// 🔧 HELPERS
// ============================================================================

function calcularDistribuicao(stats) {
  const categorias = {};
  
  stats.forEach(stat => {
    const layout = LAYOUTS[stat._id];
    if (layout) {
      const cat = layout.categoria;
      categorias[cat] = (categorias[cat] || 0) + stat.count;
    }
  });
  
  return categorias;
}

// ============================================================================
// 🔄 MIGRAÇÃO E MANUTENÇÃO
// ============================================================================

/**
 * POST /api/instagram/admin/reprocess-history
 * [Admin] Reprocessar histórico (limpar ou consolidar)
 */
export async function reprocessHistory(req, res) {
  try {
    const { action, especialidadeId } = req.body;
    
    if (action === 'cleanup') {
      const { default: LayoutHistory } = await import('../models/LayoutHistory.js');
      const deletados = await LayoutHistory.cleanupOld(especialidadeId, 'instagram', 20);
      
      return res.json({
        success: true,
        message: `${deletados} registros antigos removidos`
      });
    }
    
    res.status(400).json({
      success: false,
      error: 'Ação não reconhecida'
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
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
