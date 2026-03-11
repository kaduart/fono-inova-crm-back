/**
 * 🎯 Meta Ads Routes
 * API endpoints para integração com Meta Marketing API
 * Autenticação: Requer usuário admin
 */

import express from 'express';
import { auth } from '../middleware/auth.js';
import * as adsService from '../services/meta/adsService.js';
import { parseLeadSource, detectSpecialtyFromMessage } from '../utils/campaignDetector.js';
import Leads from '../models/Leads.js';
import MetaCampaign from '../models/MetaCampaign.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Todas as rotas requerem autenticação
router.use(auth);

/**
 * GET /api/meta-ads/campaigns
 * Lista campanhas ativas do Meta Ads com métricas
 * Query params: specialty, status
 */
router.get('/campaigns', async (req, res) => {
  try {
    const { specialty, status, refresh } = req.query;
    
    // Se solicitado refresh, sincroniza com Meta primeiro
    if (refresh === 'true') {
      logger.info('[MetaAds API] Refresh solicitado, sincronizando campanhas...');
      await adsService.syncCampaignsWithCache();
      await adsService.updateCampaignLeadCounts();
    }
    
    // Busca campanhas do cache
    const campaigns = await adsService.getCampaignsFromCache({ 
      specialty, 
      status 
    });
    
    res.json({
      success: true,
      count: campaigns.length,
      campaigns,
      lastSync: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('[MetaAds API] Erro ao buscar campanhas:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar campanhas',
      message: error.message
    });
  }
});

/**
 * GET /api/meta-ads/campaigns/:id
 * Detalhes de uma campanha específica
 */
router.get('/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { datePreset } = req.query;
    
    // Busca do cache
    let campaign = await MetaCampaign.findOne({ campaignId: id }).lean();
    
    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: 'Campanha não encontrada'
      });
    }
    
    // Se solicitou período diferente, busca insights atualizados
    if (datePreset) {
      const insights = await adsService.fetchCampaignInsights(id, datePreset);
      if (insights) {
        campaign.insights = insights;
      }
    }
    
    // Adiciona métricas calculadas
    const campaignWithMetrics = {
      ...campaign,
      cpl: campaign.leadsCount > 0 && campaign.insights?.spend
        ? campaign.insights.spend / campaign.leadsCount
        : null,
      cpa: campaign.patientsCount > 0 && campaign.insights?.spend
        ? campaign.insights.spend / campaign.patientsCount
        : null
    };
    
    res.json({
      success: true,
      campaign: campaignWithMetrics
    });
    
  } catch (error) {
    logger.error('[MetaAds API] Erro ao buscar campanha:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar campanha',
      message: error.message
    });
  }
});

/**
 * GET /api/meta-ads/insights
 * Métricas agregadas de todas as campanhas
 */
router.get('/insights', async (req, res) => {
  try {
    const metrics = await adsService.getAggregatedMetrics();
    
    res.json({
      success: true,
      metrics
    });
    
  } catch (error) {
    logger.error('[MetaAds API] Erro ao buscar insights:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar insights',
      message: error.message
    });
  }
});

/**
 * POST /api/meta-ads/sync
 * Força sincronização manual com Meta API
 * Útil quando quiser atualizar dados imediatamente
 */
router.post('/sync', async (req, res) => {
  try {
    logger.info('[MetaAds API] Sincronização manual iniciada');
    
    const result = await adsService.syncCampaignsWithCache();
    await adsService.updateCampaignLeadCounts();
    
    res.json({
      success: true,
      message: 'Sincronização concluída',
      ...result
    });
    
  } catch (error) {
    logger.error('[MetaAds API] Erro na sincronização:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro na sincronização',
      message: error.message
    });
  }
});

/**
 * GET /api/meta-ads/leads
 * Lista leads que vieram do Meta Ads, opcionalmente filtrados por campanha
 * Query: campaignId, specialty, startDate, endDate
 */
router.get('/leads', async (req, res) => {
  try {
    const { campaignId, specialty, startDate, endDate, limit = 50 } = req.query;
    
    const query = {
      'metaTracking.source': { $in: ['meta_ads', 'facebook', 'instagram'] }
    };
    
    if (campaignId) {
      query['metaTracking.campaignId'] = campaignId;
    }
    
    if (specialty) {
      query['metaTracking.specialty'] = specialty;
    }
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    const leads = await Leads.find(query)
      .select('name contact status stage metaTracking createdAt')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();
    
    res.json({
      success: true,
      count: leads.length,
      leads
    });
    
  } catch (error) {
    logger.error('[MetaAds API] Erro ao buscar leads:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao buscar leads',
      message: error.message
    });
  }
});

/**
 * POST /api/meta-ads/leads/:id/associate
 * Associa um lead existente a uma campanha
 * Body: { campaignId }
 */
router.post('/leads/:id/associate', async (req, res) => {
  try {
    const { id } = req.params;
    const { campaignId } = req.body;
    
    if (!campaignId) {
      return res.status(400).json({
        success: false,
        error: 'campaignId é obrigatório'
      });
    }
    
    const lead = await adsService.associateLeadToCampaign(id, campaignId);
    
    res.json({
      success: true,
      message: 'Lead associado à campanha com sucesso',
      lead: {
        id: lead._id,
        name: lead.name,
        metaTracking: lead.metaTracking
      }
    });
    
  } catch (error) {
    logger.error('[MetaAds API] Erro ao associar lead:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao associar lead',
      message: error.message
    });
  }
});

/**
 * POST /api/meta-ads/detect-source
 * Endpoint utilitário para detectar origem de uma mensagem
 * Útil para testar o detector de campanha
 * Body: { message, fbclid, utmCampaign }
 */
router.post('/detect-source', async (req, res) => {
  try {
    const { message, fbclid, utmCampaign, utmSource, utmMedium } = req.body;
    
    const detection = parseLeadSource({
      message,
      fbclid,
      utmCampaign,
      utmSource,
      utmMedium
    });
    
    // Também detecta especialidade da mensagem
    const specialtyFromMsg = message ? detectSpecialtyFromMessage(message) : null;
    
    res.json({
      success: true,
      detection: {
        ...detection,
        specialtyDetected: specialtyFromMsg
      }
    });
    
  } catch (error) {
    logger.error('[MetaAds API] Erro ao detectar origem:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao detectar origem',
      message: error.message
    });
  }
});

/**
 * GET /api/meta-ads/by-specialty
 * Agrupa métricas por especialidade
 * Útil para comparar performance entre áreas (psico vs fono vs fisio)
 */
router.get('/by-specialty', async (req, res) => {
  try {
    const specialties = ['psicologia', 'fono', 'fisio', 'neuropsicologia', 'geral'];
    
    const results = await Promise.all(
      specialties.map(async (specialty) => {
        const campaigns = await MetaCampaign.find({ specialty, isActive: true });
        
        const totals = campaigns.reduce((acc, camp) => ({
          spend: acc.spend + (camp.insights?.spend || 0),
          leads: acc.leads + (camp.leadsCount || 0),
          patients: acc.patients + (camp.patientsCount || 0),
          clicks: acc.clicks + (camp.insights?.clicks || 0),
          impressions: acc.impressions + (camp.insights?.impressions || 0)
        }), { spend: 0, leads: 0, patients: 0, clicks: 0, impressions: 0 });
        
        return {
          specialty,
          campaignCount: campaigns.length,
          ...totals,
          cpl: totals.leads > 0 ? totals.spend / totals.leads : null,
          cpa: totals.patients > 0 ? totals.spend / totals.patients : null,
          ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : null
        };
      })
    );
    
    res.json({
      success: true,
      specialties: results.filter(s => s.campaignCount > 0 || s.leads > 0)
    });
    
  } catch (error) {
    logger.error('[MetaAds API] Erro ao agrupar por especialidade:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao agrupar por especialidade',
      message: error.message
    });
  }
});

export default router;
