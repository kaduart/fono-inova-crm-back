/**
 * 🎯 Landing Page Routes
 * API para gerenciar landing pages de alta conversão
 */

import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import LandingPage from '../models/LandingPage.js';
import * as landingPageService from '../services/landingPageService.js';

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// 📊 TRACKING PÚBLICO (Site → CRM)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/landing-pages/track
 * Recebe tracking de views e leads do site (público - sem auth)
 */
router.post('/track', async (req, res) => {
  try {
    const { type, slug, category, url, referrer, timestamp, device, utm } = req.body;
    
    if (!type || !slug) {
      return res.status(400).json({
        success: false,
        error: 'Tipo e slug são obrigatórios'
      });
    }
    
    // Atualiza métricas da landing page
    if (type === 'lp_view') {
      await landingPageService.incrementMetrics(slug, 'view');
      console.log(`[LP Track] View: ${slug} | Device: ${device?.type} | Ref: ${referrer}`);
    } else if (type === 'lp_lead') {
      await landingPageService.incrementMetrics(slug, 'lead');
      console.log(`[LP Track] Lead: ${slug} | Source: ${req.body.leadData?.source}`);
    }
    
    res.json({
      success: true,
      message: 'Tracking registrado'
    });
  } catch (error) {
    console.error('Erro no tracking:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Todas as rotas abaixo requerem autenticação
router.use(auth);

// ═══════════════════════════════════════════════════════════════════════════════
// 📋 LISTAGEM E CONSULTA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/landing-pages
 * Lista todas as landing pages (com filtros opcionais)
 */
router.get('/', async (req, res) => {
  try {
    const { 
      category, 
      status = 'active', 
      search,
      page = 1, 
      limit = 20 
    } = req.query;
    
    const query = {};
    
    if (status !== 'all') {
      query.status = status;
    }
    
    if (category && category !== 'all') {
      query.category = category;
    }
    
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { headline: { $regex: search, $options: 'i' } },
        { keywords: { $in: [new RegExp(search, 'i')] } }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [pages, total] = await Promise.all([
      LandingPage.find(query)
        .sort({ priority: -1, postCount: 1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      LandingPage.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      data: pages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
        hasMore: skip + pages.length < total
      }
    });
  } catch (error) {
    console.error('Erro ao listar landing pages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/landing-pages/:slug
 * Detalhes de uma landing page específica
 */
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const page = await LandingPage.findOne({ slug }).lean();
    
    if (!page) {
      return res.status(404).json({ 
        success: false, 
        error: 'Landing page não encontrada' 
      });
    }
    
    res.json({ success: true, data: page });
  } catch (error) {
    console.error('Erro ao buscar landing page:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🎯 ROTAÇÃO E SUGESTÕES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/landing-pages/daily
 * Landing pages do dia (uma de cada categoria)
 */
router.get('/daily', async (req, res) => {
  try {
    const dailyPages = await landingPageService.getLandingPageOfTheDay();
    
    res.json({
      success: true,
      data: dailyPages,
      date: new Date().toISOString().split('T')[0]
    });
  } catch (error) {
    console.error('Erro ao buscar LP do dia:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/landing-pages/rotation
 * Rotação semanal de landing pages
 */
router.get('/rotation', async (req, res) => {
  try {
    const weekPlan = await landingPageService.getRotationForWeek();
    
    res.json({
      success: true,
      data: weekPlan
    });
  } catch (error) {
    console.error('Erro ao buscar rotação:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/landing-pages/suggest
 * Sugere landing pages para posts
 */
router.get('/suggest', async (req, res) => {
  try {
    const { category = null, limit = 5 } = req.query;
    
    const suggestions = await landingPageService.suggestForPost(
      category,
      parseInt(limit)
    );
    
    res.json({
      success: true,
      data: suggestions,
      category
    });
  } catch (error) {
    console.error('Erro ao sugerir LPs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/landing-pages/:slug/post-suggestion
 * Gera sugestão de post para uma LP específica
 */
router.get('/:slug/post-suggestion', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const suggestion = await landingPageService.generatePostContent(slug);
    
    res.json({
      success: true,
      data: suggestion
    });
  } catch (error) {
    console.error('Erro ao gerar sugestão:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/landing-pages/:slug/create-post
 * 🎯 Cria post completo no GMB a partir de uma landing page
 * Busca imagem no ImageBank ou gera nova
 */
router.post('/:slug/create-post', async (req, res) => {
  try {
    const { slug } = req.params;
    const { scheduledAt } = req.body;
    
    // Busca a landing page
    const lp = await LandingPage.findOne({ slug });
    if (!lp) {
      return res.status(404).json({
        success: false,
        error: 'Landing page não encontrada'
      });
    }
    
    // Gera conteúdo do post
    const suggestion = await landingPageService.generatePostContent(slug);
    
    // Importa serviços necessários
    const { generateImageForEspecialidade } = await import('../services/gmbService.js');
    const { findExistingImage } = await import('../services/imageBankService.js');
    
    // Mapeamento de categorias
    const CATEGORY_MAP = {
      'fonoaudiologia': { id: 'fonoaudiologia', nome: 'Fonoaudiologia', foco: 'desenvolvimento da fala' },
      'psicologia': { id: 'psicologia', nome: 'Psicologia', foco: 'saúde mental infantil' },
      'autismo': { id: 'autismo', nome: 'Autismo', foco: 'avaliação TEA' },
      'terapia_ocupacional': { id: 'terapia_ocupacional', nome: 'Terapia Ocupacional', foco: 'coordenação motora' },
      'aprendizagem': { id: 'psicopedagogia', nome: 'Psicopedagogia', foco: 'dificuldades de aprendizagem' },
      'geografica': { id: 'fonoaudiologia', nome: 'Fonoaudiologia', foco: 'atendimento em Anápolis' },
      'fisioterapia': { id: 'fisioterapia', nome: 'Fisioterapia', foco: 'desenvolvimento motor' }
    };
    
    const especialidade = CATEGORY_MAP[lp.category] || CATEGORY_MAP['fonoaudiologia'];
    
    // 🎨 Busca ou gera imagem
    let imageResult = null;
    try {
      // Tenta ImageBank primeiro
      const existingImage = await findExistingImage(especialidade.id, lp.title);
      if (existingImage) {
        imageResult = {
          url: existingImage.url,
          provider: 'imagebank-reused'
        };
      } else {
        // Gera nova imagem
        imageResult = await generateImageForEspecialidade(
          especialidade,
          suggestion.content,
          false,
          'auto'
        );
      }
    } catch (imgError) {
      console.warn('⚠️ Erro ao obter imagem:', imgError.message);
    }
    
    // Cria o post no banco (GMB)
    const GmbPost = (await import('../models/GmbPost.js')).default;
    const post = new GmbPost({
      platform: 'gmb',
      content: suggestion.content,
      title: suggestion.title,
      funnelStage: 'top',
      theme: lp.category,
      status: scheduledAt ? 'scheduled' : 'draft',
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      landingPageRef: lp.slug,
      landingPageUrl: suggestion.landingPageUrl,
      tags: ['landing-page', 'auto-generated', 'seo-optimized'],
      mediaUrl: imageResult?.url || null,
      mediaType: imageResult?.url ? 'image' : null,
      imageProvider: imageResult?.provider || null,
      autoPublish: false
    });
    
    await post.save();
    
    // Marca LP como usada
    await landingPageService.markAsUsed(slug);
    
    res.json({
      success: true,
      message: 'Post criado com sucesso!',
      data: {
        postId: post._id,
        title: post.title,
        hasImage: !!imageResult?.url,
        imageProvider: imageResult?.provider,
        status: post.status,
        scheduledAt: post.scheduledAt
      }
    });
    
  } catch (error) {
    console.error('❌ Erro ao criar post:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ✍️ AÇÕES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/landing-pages/:slug/use
 * Marca uma LP como usada em post
 */
router.post('/:slug/use', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const lp = await landingPageService.markAsUsed(slug);
    
    res.json({
      success: true,
      message: 'Landing page marcada como usada',
      data: {
        slug: lp.slug,
        postCount: lp.postCount,
        lastUsedInPost: lp.lastUsedInPost
      }
    });
  } catch (error) {
    console.error('Erro ao marcar LP:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/landing-pages/:slug/metrics
 * Incrementa métricas de view ou lead
 */
router.post('/:slug/metrics', async (req, res) => {
  try {
    const { slug } = req.params;
    const { type } = req.body; // 'view' ou 'lead'
    
    if (!['view', 'lead'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Tipo deve ser "view" ou "lead"'
      });
    }
    
    const lp = await landingPageService.incrementMetrics(slug, type);
    
    if (!lp) {
      return res.status(404).json({
        success: false,
        error: 'Landing page não encontrada'
      });
    }
    
    res.json({
      success: true,
      data: {
        slug: lp.slug,
        metrics: lp.metrics
      }
    });
  } catch (error) {
    console.error('Erro ao atualizar métricas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🔧 ADMIN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/landing-pages/seed
 * Popula o banco com as 20 LPs padrão (apenas admin)
 */
router.post('/seed', async (req, res) => {
  try {
    // TODO: Verificar se é admin
    // if (!req.user.isAdmin) {
    //   return res.status(403).json({ success: false, error: 'Acesso negado' });
    // }
    
    const result = await landingPageService.seedLandingPages();
    
    res.json({
      success: true,
      message: 'Seed executado com sucesso',
      data: result
    });
  } catch (error) {
    console.error('Erro no seed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/landing-pages/stats
 * Estatísticas gerais das landing pages
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await landingPageService.getStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/landing-pages/:slug
 * Atualiza uma landing page (admin)
 */
router.put('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const updates = req.body;
    
    // Remove campos que não devem ser atualizados
    delete updates._id;
    delete updates.createdAt;
    delete updates.slug; // não permite mudar slug
    
    const lp = await LandingPage.findOneAndUpdate(
      { slug },
      { $set: updates },
      { new: true }
    );
    
    if (!lp) {
      return res.status(404).json({
        success: false,
        error: 'Landing page não encontrada'
      });
    }
    
    res.json({
      success: true,
      message: 'Landing page atualizada',
      data: lp
    });
  } catch (error) {
    console.error('Erro ao atualizar LP:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/landing-pages/cron/run-now
 * Executa o cron manualmente (admin)
 */
router.post('/cron/run-now', async (req, res) => {
  try {
    const { runLandingPageDailyPostsNow } = await import('../crons/landingPageDailyPost.js');
    
    console.log('🚀 Executando cron manualmente...');
    const result = await runLandingPageDailyPostsNow();
    
    res.json({
      success: true,
      message: 'Cron executado com sucesso',
      data: result
    });
  } catch (error) {
    console.error('Erro ao executar cron:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/landing-pages/cron/status
 * Status do cron de landing pages
 */
router.get('/cron/status', async (req, res) => {
  try {
    const { getLandingPageCronStatus } = await import('../crons/landingPageDailyPost.js');
    
    const status = getLandingPageCronStatus();
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('Erro ao buscar status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 📊 MÉTRICAS (Site → CRM)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/landing-pages/metrics
 * Busca métricas agregadas das landing pages
 */
router.get('/metrics', async (req, res) => {
  try {
    const stats = await landingPageService.getStats();
    
    // Busca top LPs por views
    const topByViews = await LandingPage.find({ status: 'active' })
      .sort({ 'metrics.views': -1 })
      .limit(10)
      .select('slug title headline category metrics views leads conversionRate');
    
    // Busca top LPs por leads
    const topByLeads = await LandingPage.find({ status: 'active' })
      .sort({ 'metrics.leads': -1 })
      .limit(10)
      .select('slug title headline category metrics views leads conversionRate');
    
    res.json({
      success: true,
      data: {
        ...stats,
        topByViews,
        topByLeads
      }
    });
  } catch (error) {
    console.error('Erro ao buscar métricas:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
