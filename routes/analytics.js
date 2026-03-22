/**
 * 📊 Analytics Routes - VERSÃO CORRIGIDA
 * 
 * Correções:
 * 1. Filtros de data funcionando corretamente
 * 2. Landing Pages aparecendo no dashboard
 * 3. Relatório diário por tab
 */

import dotenv from 'dotenv';
import express from 'express';
import { getGA4Events, getGA4Metrics, getGA4Pages, getGA4Sources, getGA4AnapolisPages, getGA4PagesByPaths, getGA4Realtime, formatEventsWithPeriodDate } from '../services/analytics.js';
import { getInternalAnalytics } from '../services/analyticsInternal.js';
import { auth } from '../middleware/auth.js';
import revenueAnalytics from '../services/revenueAnalyticsService.js';

dotenv.config();

const router = express.Router();

// ============================================
// HELPERS
// ============================================

function getDefaultDates() {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 7);
    return { 
        startDate: start.toISOString().split('T')[0], 
        endDate: end.toISOString().split('T')[0] 
    };
}

function parseDateRange(req) {
    let { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
        return getDefaultDates();
    }
    
    // Garante formato correto
    return { startDate, endDate };
}

// ============================================
// 🆕 ENDPOINT CORRIGIDO: Dashboard com LPs
// ============================================

router.get('/dashboard', async (req, res) => {
    try {
        const { startDate, endDate } = parseDateRange(req);
        
        console.log('📊 Dashboard solicitado:', { startDate, endDate });

        const ANAPOLIS_PATHS = [
            '/fonoaudiologia-anapolis', '/psicologia-infantil-anapolis',
            '/terapia-ocupacional-anapolis', '/psicomotricidade-anapolis',
            '/teste-da-linguinha-anapolis', '/fisioterapia-infantil-anapolis',
            '/avaliacao-neuropsicologica-anapolis'
        ];

        // FASE 1: buscar lista de LPs do MongoDB (rápido) para ter os caminhos
        const lpData = await getLandingPagesData(startDate, endDate);
        const lpPaths = (lpData.landingPages || []).map(lp => lp.path);

        // FASE 2: todas as chamadas GA4 em paralelo, incluindo queries dedicadas por período
        const [
            ga4Metrics,
            ga4Events,
            ga4Pages,
            ga4Sources,
            ga4AnapolisPages,   // query com dimensionFilter → sem limite top-50
            ga4LpPages,         // query com dimensionFilter → sem limite top-50
            ga4Realtime,
            internalData,
            leadsData
        ] = await Promise.all([
            getGA4Metrics(startDate, endDate).catch(() => null),
            getGA4Events(startDate, endDate).catch(() => []),
            getGA4Pages(startDate, endDate).catch(() => []),
            getGA4Sources(startDate, endDate).catch(() => []),
            getGA4AnapolisPages(startDate, endDate).catch(() => []),
            lpPaths.length > 0
                ? getGA4PagesByPaths(lpPaths, startDate, endDate).catch(() => [])
                : Promise.resolve([]),
            getGA4Realtime().catch(() => null),
            getInternalAnalytics(startDate, endDate).catch(() => null),
            getLeadsByDay(startDate, endDate)
        ]);

        const finalMetrics = ga4Metrics?.totalUsers > 0
            ? ga4Metrics
            : internalData?.metrics || getEmptyMetrics();

        // ga4Events agora tem timestamp real (dimensão date do GA4) — não precisa de formatEventsWithPeriodDate
        const finalEvents = ga4Events?.length > 0
            ? ga4Events
            : internalData?.events || [];

        const dailyReport = generateDailyReport(finalEvents, leadsData, startDate, endDate);

        // Leads por página do CRM (período selecionado)
        const allPagePaths = [...ANAPOLIS_PATHS, ...lpPaths];
        const leadsPerPage = await getLeadsByPage(allPagePaths, startDate, endDate);

        // Anápolis: GA4 dedicado (período) + leads CRM
        const anapolisPages = ANAPOLIS_PATHS.map(path => {
            const ga4 = ga4AnapolisPages.find(p => p.path === path) || {};
            return {
                path,
                title: ga4.title || '',
                views: ga4.views || 0,
                users: ga4.users || 0,
                bounceRate: ga4.bounceRate || 0,
                avgEngagementTime: ga4.avgEngagementTime || 0,
                leads: leadsPerPage[path] || 0,
            };
        });

        // Construir resposta completa
        const dashboardData = {
            metrics: {
                ...finalMetrics,
                leadsPeriod: leadsData.total || 0,
                leadsToday: leadsData.today || 0,
                leadsThisWeek: leadsData.week || 0,
                leadsThisMonth: leadsData.month || 0
            },

            events: finalEvents,

            sources: ga4Sources?.length > 0 ? ga4Sources : internalData?.sources || [],

            pages: mergePagesData(ga4Pages, lpData.pages) || [],

            // LPs: views da query dedicada GA4 (período filtrado), leads do CRM
            landingPages: (lpData.landingPages || []).map(lp => {
                const ga4Page = ga4LpPages.find(p => p.path === lp.path);
                return {
                    ...lp,
                    views: ga4Page?.views ?? 0,     // 0 se sem acesso no período (não inventar)
                    users: ga4Page?.users ?? 0,
                    bounceRate: ga4Page?.bounceRate ?? 0,
                    leads: leadsPerPage[lp.path] || 0,
                };
            }),

            // Páginas Anápolis SEO com dados GA4 por período + leads CRM
            anapolisPages,

            dailyReport,

            conversions: finalEvents
                .filter(e => ['generate_lead', 'whatsapp_click', 'form_submission'].includes(e.action))
                .map(e => ({
                    eventName: e.action,
                    conversions: e.value || 1,
                    timestamp: e.timestamp
                })),

            realtime: ga4Realtime || { activeUsers: 0, pageViews: 0, events: 0 },

            lastUpdated: new Date().toISOString()
        };

        console.log('✅ Dashboard enviado:', {
            events: finalEvents.length,
            pages: dashboardData.pages.length,
            landingPages: dashboardData.landingPages.length,
            anapolisPages: anapolisPages.length,
            leadsPerPage: Object.keys(leadsPerPage).length,
            dailyReportDays: dailyReport.length
        });

        res.json(dashboardData);

    } catch (err) {
        console.error('❌ Erro no dashboard:', err);
        res.status(500).json({ 
            error: 'Erro ao carregar dashboard',
            message: err.message 
        });
    }
});

// ============================================
// 🆕 FUNÇÃO: Mesclar dados GA4 + Landing Pages
// ============================================

function mergePagesData(ga4Pages, lpPages) {
    if (!ga4Pages || ga4Pages.length === 0) {
        return lpPages || [];
    }
    
    // 🎯 INCLUIR TODAS as páginas do GA4 (são as reais!)
    // Isso inclui: Home, WhatsApp, Contato, Blog, etc.
    const allGa4Pages = ga4Pages.map(page => ({
        ...page,
        isLandingPage: page.path?.startsWith('/lp/') || false
    }));
    
    // Criar mapa para evitar duplicados
    const pageMap = new Map();
    
    // 1. Primeiro adicionar todas as páginas do GA4 (prioridade máxima - dados reais!)
    allGa4Pages.forEach(page => {
        pageMap.set(page.path, page);
    });
    
    // 2. Adicionar LPs que não estão no GA4 ainda (ou enriquecer as existentes)
    (lpPages || []).forEach(lp => {
        if (!pageMap.has(lp.path)) {
            pageMap.set(lp.path, lp);
        }
    });
    
    // Converter para array e ordenar por views (mais acessadas primeiro)
    const allPages = Array.from(pageMap.values())
        .sort((a, b) => (b.views || 0) - (a.views || 0));
    
    return allPages;
}

// ============================================
// 🆕 FUNÇÃO: Buscar dados das Landing Pages
// ============================================

async function getLandingPagesData(startDate, endDate) {
    try {
        // Buscar LPs do banco de dados
        const LandingPage = (await import('../models/LandingPage.js')).default;
        
        const landingPages = await LandingPage.find({
            status: 'active'
        }).select('slug title category metrics views leads').lean();

        console.log(`📄 ${landingPages.length} Landing Pages encontradas`);

        // Formatar para o dashboard
        const lpPages = landingPages.map(lp => ({
            title: lp.title || lp.slug,
            path: `/lp/${lp.slug}`,
            slug: lp.slug,
            category: lp.category,
            views: lp.metrics?.views || 0,
            leads: lp.metrics?.leads || 0,
            users: 0,
            avgEngagementTime: 120,
            bounceRate: 35,
            isLandingPage: true
        }));

        return {
            pages: lpPages,
            landingPages: lpPages
        };

    } catch (err) {
        console.error('❌ Erro ao buscar LPs:', err);
        return { pages: [], landingPages: [] }
    }
}

// ============================================
// FUNÇÃO: Buscar leads por página (filtrado por data)
// ============================================

async function getLeadsByPage(paths, startDate, endDate) {
    try {
        if (!paths || paths.length === 0) return {};
        const Lead = (await import('../models/Leads.js')).default;
        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        const result = await Lead.aggregate([
            { $match: { landingPage: { $in: paths }, createdAt: { $gte: start, $lte: end } } },
            { $group: { _id: '$landingPage', count: { $sum: 1 } } }
        ]);

        return result.reduce((map, r) => ({ ...map, [r._id]: r.count }), {});
    } catch (err) {
        console.error('❌ Erro em getLeadsByPage:', err.message);
        return {};
    }
}

// ============================================
// 🆕 FUNÇÃO: Buscar leads por dia
// ============================================

async function getLeadsByDay(startDate, endDate) {
    try {
        const Lead = (await import('../models/Leads.js')).default;
        
        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        // Total no período
        const totalPeriod = await Lead.countDocuments({
            createdAt: { $gte: start, $lte: end }
        });

        // Hoje
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayCount = await Lead.countDocuments({
            createdAt: { $gte: today }
        });

        // Esta semana
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const weekCount = await Lead.countDocuments({
            createdAt: { $gte: weekAgo }
        });

        // Este mês
        const monthAgo = new Date();
        monthAgo.setDate(monthAgo.getDate() - 30);
        const monthCount = await Lead.countDocuments({
            createdAt: { $gte: monthAgo }
        });

        return {
            total: totalPeriod,
            today: todayCount,
            week: weekCount,
            month: monthCount
        };

    } catch (err) {
        console.error('❌ Erro ao buscar leads:', err);
        return { total: 0, today: 0, week: 0, month: 0 };
    }
}

// ============================================
// 🆕 FUNÇÃO: Gerar relatório diário
// ============================================

function generateDailyReport(events, leadsData, startDate, endDate) {
    const dailyMap = {};
    
    // Inicializar todos os dias do período
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateKey = d.toISOString().split('T')[0];
        dailyMap[dateKey] = {
            date: dateKey,
            sessions: 0,
            users: 0,
            pageViews: 0,
            events: 0,
            leads: 0,
            conversions: 0
        };
    }
    
    // Agrupar eventos por dia
    events.forEach(event => {
        const dateKey = new Date(event.timestamp).toISOString().split('T')[0];
        if (dailyMap[dateKey]) {
            dailyMap[dateKey].events += Number(event.value || 1);
            
            if (event.action === 'page_view') {
                dailyMap[dateKey].pageViews += Number(event.value || 1);
            }
            
            if (['generate_lead', 'whatsapp_click', 'form_submission'].includes(event.action)) {
                dailyMap[dateKey].conversions += Number(event.value || 1);
            }
        }
    });
    
    // Converter para array ordenado
    return Object.values(dailyMap).sort((a, b) => 
        new Date(a.date) - new Date(b.date)
    );
}

// ============================================
// 🆕 ENDPOINT: Relatório Diário Detalhado
// ============================================

router.get('/daily-report', async (req, res) => {
    try {
        const { startDate, endDate } = parseDateRange(req);
        
        // Buscar leads detalhados por dia
        const Lead = (await import('../models/Leads.js')).default;
        
        const leads = await Lead.find({
            createdAt: {
                $gte: new Date(startDate),
                $lte: new Date(endDate + 'T23:59:59')
            }
        }).select('createdAt origin status metaTracking').lean();

        // Agrupar por dia
        const dailyData = {};
        
        leads.forEach(lead => {
            const dateKey = new Date(lead.createdAt).toISOString().split('T')[0];
            
            if (!dailyData[dateKey]) {
                dailyData[dateKey] = {
                    date: dateKey,
                    totalLeads: 0,
                    byOrigin: {},
                    bySource: {}
                };
            }
            
            dailyData[dateKey].totalLeads++;
            
            // Por origem
            const origin = lead.origin || 'Desconhecido';
            dailyData[dateKey].byOrigin[origin] = (dailyData[dateKey].byOrigin[origin] || 0) + 1;
            
            // Por source (metaTracking)
            const source = lead.metaTracking?.source || 'Não rastreado';
            dailyData[dateKey].bySource[source] = (dailyData[dateKey].bySource[source] || 0) + 1;
        });
        
        res.json({
            period: { startDate, endDate },
            dailyData: Object.values(dailyData).sort((a, b) => 
                new Date(a.date) - new Date(b.date)
            )
        });

    } catch (err) {
        console.error('❌ Erro no relatório diário:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// 🆕 ENDPOINT: Métricas das Landing Pages
// ============================================

router.get('/landing-pages', async (req, res) => {
    try {
        const { startDate, endDate } = parseDateRange(req);
        
        const LandingPage = (await import('../models/LandingPage.js')).default;
        
        const lps = await LandingPage.find({
            status: 'active'
        }).select('slug title category metrics lastUsedInPost postCount').sort({ 'metrics.views': -1 });

        res.json({
            period: { startDate, endDate },
            total: lps.length,
            landingPages: lps
        });

    } catch (err) {
        console.error('❌ Erro ao buscar LPs:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// HELPERS
// ============================================

function getEmptyMetrics() {
    return {
        totalUsers: 0,
        activeUsers: 0,
        sessions: 0,
        engagedSessions: 0,
        avgSessionDuration: 0,
        pageViews: 0,
        bounceRate: 0,
        conversions: 0,
        eventCount: 0
    };
}

// Endpoints originais (mantidos para compatibilidade)
router.get('/events', async (req, res) => {
    try {
        const { startDate, endDate } = parseDateRange(req);
        const events = await getGA4Events(startDate, endDate);
        res.json(events);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/metrics', async (req, res) => {
    try {
        const { startDate, endDate } = parseDateRange(req);
        const metrics = await getGA4Metrics(startDate, endDate);
        res.json(metrics);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/analytics/revenue/revenue-by-source
 */
router.get('/revenue/revenue-by-source', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await revenueAnalytics.getRevenueBySource(startDate, endDate);
    res.json({ success: true, data, meta: { startDate, endDate } });
  } catch (error) {
    console.error('[Analytics] Error in revenue-by-source:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/analytics/revenue/revenue-by-campaign
 */
router.get('/revenue/revenue-by-campaign', auth, async (req, res) => {
  try {
    const { startDate, endDate, source } = req.query;
    const data = await revenueAnalytics.getRevenueByCampaign(startDate, endDate, source);
    res.json({ success: true, data, meta: { startDate, endDate, source } });
  } catch (error) {
    console.error('[Analytics] Error in revenue-by-campaign:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/analytics/revenue/gmb-revenue
 */
router.get('/revenue/gmb-revenue', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await revenueAnalytics.getGMBRevenue(startDate, endDate);
    res.json({ success: true, data, meta: { startDate, endDate, source: 'gmb' } });
  } catch (error) {
    console.error('[Analytics] Error in gmb-revenue:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/analytics/revenue/dashboard
 */
router.get('/revenue/dashboard', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await revenueAnalytics.getRevenueDashboard(startDate, endDate);
    res.json({ success: true, data, meta: { startDate, endDate } });
  } catch (error) {
    console.error('[Analytics] Error in revenue/dashboard:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/analytics/revenue/conversion-funnel
 *
 * Retorna funnel de conversão: Leads → Appointments → Paid
 * Query params: startDate, endDate, source (opcional)
 */
router.get('/revenue/conversion-funnel', auth, async (req, res) => {
  try {
    const { startDate, endDate, source } = req.query;
    const data = await revenueAnalytics.getConversionFunnel(startDate, endDate, source);
    
    res.json({
      success: true,
      data,
      meta: { startDate, endDate, source }
    });
  } catch (error) {
    console.error('[Analytics] Error in conversion-funnel:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
