/**
 * 💼 Meta Ads Service
 * Serviço de integração com Meta Marketing API
 * Busca campanhas, insights e sincroniza com banco local
 */

import { FacebookAdsApi, AdAccount, Campaign } from 'facebook-nodejs-business-sdk';
import MetaCampaign from '../../models/MetaCampaign.js';
import Leads from '../../models/Leads.js';
import { detectSpecialtyFromCampaignName, calculateCPL } from '../../utils/campaignDetector.js';
import logger from '../../utils/logger.js';

// Configurações
const ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || 'act_976430640058336';

/**
 * Inicializa a API do Meta com o token configurado
 */
function initApi() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    throw new Error('META_ACCESS_TOKEN não configurado no .env');
  }
  
  // Debug: mostrar primeiros caracteres do token (nunca logar token completo!)
  logger.info(`[MetaAds] Token encontrado: ${token.substring(0, 15)}... (${token.length} chars)`);
  
  return FacebookAdsApi.init(token);
}

/**
 * Busca campanhas ativas da conta
 * @returns {Promise<Array>} - Lista de campanhas
 */
export async function fetchCampaigns() {
  try {
    const api = initApi();
    const account = new AdAccount(ACCOUNT_ID);
    
    logger.info(`[MetaAds] Buscando campanhas da conta ${ACCOUNT_ID}`);
    
    // Adicionar timeout e tratamento de erro mais detalhado
    let campaigns;
    try {
      campaigns = await Promise.race([
        account.getCampaigns([
          Campaign.Fields.ID,
          Campaign.Fields.NAME,
          Campaign.Fields.STATUS,
          Campaign.Fields.OBJECTIVE,
          Campaign.Fields.DAILY_BUDGET,
          Campaign.Fields.LIFETIME_BUDGET,
          Campaign.Fields.START_TIME,
          Campaign.Fields.STOP_TIME,
        ], {
          limit: 50
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout ao buscar campanhas')), 30000)
        )
      ]);
    } catch (apiError) {
      logger.error('[MetaAds] Erro na chamada da API:', apiError.message);
      
      // Verificar se é erro de autenticação
      if (apiError.message?.includes('Syntax error') || apiError.message?.includes('Expected name')) {
        throw new Error('Token inválido ou expirado. Verifique o META_ACCESS_TOKEN no .env. O token pode ter sido gerado para outro app ou expirado.');
      }
      
      throw apiError;
    }
    
    logger.info(`[MetaAds] ${campaigns.length} campanhas encontradas`);
    
    return campaigns.map(campaign => ({
      campaignId: campaign.id,
      name: campaign.name,
      status: campaign.status,
      objective: campaign.objective,
      dailyBudget: campaign.daily_budget ? parseInt(campaign.daily_budget) / 100 : null, // API retorna em centavos
      lifetimeBudget: campaign.lifetime_budget ? parseInt(campaign.lifetime_budget) / 100 : null,
      startTime: campaign.start_time,
      stopTime: campaign.stop_time
    }));
    
  } catch (error) {
    logger.error('[MetaAds] Erro ao buscar campanhas:', error.message);
    throw error;
  }
}

/**
 * Busca insights (métricas) de uma campanha específica
 * @param {string} campaignId - ID da campanha
 * @param {string} datePreset - Período (last_7d, last_30d, this_month, etc)
 * @returns {Promise<object>} - Insights da campanha
 */
export async function fetchCampaignInsights(campaignId, datePreset = 'last_30d') {
  try {
    const api = initApi();
    const campaign = new Campaign(campaignId);
    
    const insights = await campaign.getInsights([
      'spend',
      'clicks',
      'impressions',
      'reach',
      'cpc',
      'ctr',
      'cpm',
      'conversions',
      'cost_per_conversion'
    ], {
      date_preset: datePreset
    });
    
    if (!insights || insights.length === 0) {
      return null;
    }
    
    const data = insights[0];
    
    return {
      spend: parseFloat(data.spend || 0),
      clicks: parseInt(data.clicks || 0),
      impressions: parseInt(data.impressions || 0),
      reach: parseInt(data.reach || 0),
      cpc: parseFloat(data.cpc || 0),
      ctr: parseFloat(data.ctr || 0),
      cpm: parseFloat(data.cpm || 0),
      conversions: parseInt(data.conversions || 0),
      costPerConversion: parseFloat(data.cost_per_conversion || 0)
    };
    
  } catch (error) {
    logger.error(`[MetaAds] Erro ao buscar insights da campanha ${campaignId}:`, error.message);
    return null;
  }
}

/**
 * Verifica se precisa sincronizar (rate limit protection)
 * Só sincroniza se última sync foi há mais de 30 minutos
 * @returns {Promise<boolean>} - true se deve sincronizar
 */
export async function shouldSync() {
  const lastSync = await MetaCampaign.findOne().sort({ lastSyncAt: -1 });
  
  if (!lastSync) {
    return true; // Nunca sincronizou
  }
  
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
  
  return lastSync.lastSyncAt < thirtyMinutesAgo;
}

/**
 * Sincroniza campanhas do Meta com banco local (cache)
 * Atualiza ou cria registros na collection MetaCampaign
 * @param {boolean} force - Força sincronização ignorando cache
 * @returns {Promise<object>} - Resultado da sincronização
 */
export async function syncCampaignsWithCache(force = false) {
  try {
    // Rate limit protection
    if (!force) {
      const should = await shouldSync();
      if (!should) {
        logger.info('[MetaAds] Usando cache (sincronizado há menos de 30 min)');
        return {
          success: true,
          cached: true,
          message: 'Usando cache local (sincronizado recentemente)'
        };
      }
    }
    
    logger.info('[MetaAds] Iniciando sincronização de campanhas...');
    
    // 1. Busca campanhas do Meta
    const campaigns = await fetchCampaigns();
    
    // 2. Para cada campanha, busca insights e salva no banco
    const results = await Promise.all(
      campaigns.map(async (campaign) => {
        try {
          // Busca insights dos últimos 30 dias
          const insights = await fetchCampaignInsights(campaign.campaignId, 'last_30d');
          
          // Detecta especialidade pelo nome
          const specialty = detectSpecialtyFromCampaignName(campaign.name);
          
          // Atualiza ou cria no banco
          const updated = await MetaCampaign.findOneAndUpdate(
            { campaignId: campaign.campaignId },
            {
              $set: {
                name: campaign.name,
                status: campaign.status,
                objective: campaign.objective,
                dailyBudget: campaign.dailyBudget,
                lifetimeBudget: campaign.lifetimeBudget,
                specialty: specialty,
                isActive: campaign.status === 'ACTIVE',
                lastSyncAt: new Date(),
                syncStatus: 'synced',
                ...(insights && {
                  'insights.spend': insights.spend,
                  'insights.clicks': insights.clicks,
                  'insights.impressions': insights.impressions,
                  'insights.reach': insights.reach,
                  'insights.cpc': insights.cpc,
                  'insights.ctr': insights.ctr,
                  'insights.cpm': insights.cpm,
                  'insights.conversions': insights.conversions,
                  'insights.costPerConversion': insights.costPerConversion
                })
              }
            },
            { upsert: true, new: true }
          );
          
          return { success: true, campaignId: campaign.campaignId, name: campaign.name };
          
        } catch (err) {
          logger.error(`[MetaAds] Erro ao sincronizar campanha ${campaign.campaignId}:`, err.message);
          return { success: false, campaignId: campaign.campaignId, error: err.message };
        }
      })
    );
    
    const successCount = results.filter(r => r.success).length;
    const errorCount = results.filter(r => !r.success).length;
    
    logger.info(`[MetaAds] Sincronização concluída: ${successCount} sucesso, ${errorCount} erros`);
    
    return {
      success: true,
      synced: successCount,
      errors: errorCount,
      campaigns: results
    };
    
  } catch (error) {
    logger.error('[MetaAds] Erro na sincronização:', error.message);
    throw error;
  }
}

/**
 * Atualiza contagem de leads por campanha (denormalização)
 * Calcula quantos leads cada campanha gerou
 * @returns {Promise<void>}
 */
export async function updateCampaignLeadCounts() {
  try {
    logger.info('[MetaAds] Atualizando contagem de leads por campanha...');
    
    // Busca todas as campanhas do banco
    const campaigns = await MetaCampaign.find({});
    
    for (const campaign of campaigns) {
      // Conta leads que têm este campaignId
      const leadsCount = await Leads.countDocuments({
        'metaTracking.campaignId': campaign.campaignId
      });
      
      // Conta leads que viraram pacientes (status específico)
      const patientsCount = await Leads.countDocuments({
        'metaTracking.campaignId': campaign.campaignId,
        status: { $in: ['virou_paciente', 'paciente', 'convertido'] }
      });
      
      // Atualiza no documento da campanha
      await MetaCampaign.updateOne(
        { _id: campaign._id },
        { 
          $set: { 
            leadsCount,
            patientsCount
          } 
        }
      );
    }
    
    logger.info('[MetaAds] Contagem de leads atualizada');
    
  } catch (error) {
    logger.error('[MetaAds] Erro ao atualizar contagem de leads:', error.message);
    throw error;
  }
}

/**
 * Busca campanhas do cache local com métricas calculadas
 * @param {object} filters - Filtros (specialty, status, etc)
 * @returns {Promise<Array>} - Campanhas com métricas
 */
export async function getCampaignsFromCache(filters = {}) {
  try {
    const query = { isActive: true };
    
    if (filters.specialty) {
      query.specialty = filters.specialty;
    }
    
    if (filters.status) {
      query.status = filters.status;
    }
    
    const campaigns = await MetaCampaign.find(query)
      .sort({ 'insights.spend': -1 })  // Ordena por gasto (maior primeiro)
      .lean();
    
    // Adiciona métricas calculadas
    return campaigns.map(campaign => ({
      ...campaign,
      cpl: campaign.leadsCount > 0 && campaign.insights?.spend 
        ? campaign.insights.spend / campaign.leadsCount 
        : null,
      cpa: campaign.patientsCount > 0 && campaign.insights?.spend
        ? campaign.insights.spend / campaign.patientsCount
        : null,
      formattedSpend: campaign.insights?.spend 
        ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(campaign.insights.spend)
        : 'R$ 0,00'
    }));
    
  } catch (error) {
    logger.error('[MetaAds] Erro ao buscar campanhas do cache:', error.message);
    throw error;
  }
}

/**
 * Busca métricas agregadas de todas as campanhas
 * @returns {Promise<object>} - Métricas totais
 */
export async function getAggregatedMetrics() {
  try {
    const campaigns = await MetaCampaign.find({ isActive: true });
    
    const totals = campaigns.reduce((acc, campaign) => {
      acc.totalSpend += campaign.insights?.spend || 0;
      acc.totalClicks += campaign.insights?.clicks || 0;
      acc.totalImpressions += campaign.insights?.impressions || 0;
      acc.totalLeads += campaign.leadsCount || 0;
      acc.totalPatients += campaign.patientsCount || 0;
      return acc;
    }, {
      totalSpend: 0,
      totalClicks: 0,
      totalImpressions: 0,
      totalLeads: 0,
      totalPatients: 0
    });
    
    return {
      ...totals,
      avgCPL: totals.totalLeads > 0 ? totals.totalSpend / totals.totalLeads : null,
      avgCPA: totals.totalPatients > 0 ? totals.totalSpend / totals.totalPatients : null,
      avgCTR: totals.totalImpressions > 0 ? (totals.totalClicks / totals.totalImpressions) * 100 : null,
      campaignCount: campaigns.length
    };
    
  } catch (error) {
    logger.error('[MetaAds] Erro ao calcular métricas agregadas:', error.message);
    throw error;
  }
}

/**
 * Associa um lead a uma campanha específica
 * Usado quando queremos vincular manualmente ou corrigir
 * @param {string} leadId - ID do lead
 * @param {string} campaignId - ID da campanha
 * @returns {Promise<object>} - Lead atualizado
 */
export async function associateLeadToCampaign(leadId, campaignId) {
  try {
    // Busca a campanha no cache
    const campaign = await MetaCampaign.findOne({ campaignId });
    
    if (!campaign) {
      throw new Error('Campanha não encontrada');
    }
    
    // Atualiza o lead
    const lead = await Leads.findByIdAndUpdate(
      leadId,
      {
        $set: {
          'metaTracking.source': 'meta_ads',
          'metaTracking.campaignId': campaignId,
          'metaTracking.campaign': campaign.name,
          'metaTracking.specialty': campaign.specialty
        }
      },
      { new: true }
    );
    
    if (!lead) {
      throw new Error('Lead não encontrado');
    }
    
    // Atualiza contagem na campanha
    await updateCampaignLeadCounts();
    
    return lead;
    
  } catch (error) {
    logger.error('[MetaAds] Erro ao associar lead à campanha:', error.message);
    throw error;
  }
}

export default {
  fetchCampaigns,
  fetchCampaignInsights,
  syncCampaignsWithCache,
  updateCampaignLeadCounts,
  getCampaignsFromCache,
  getAggregatedMetrics,
  associateLeadToCampaign
};
