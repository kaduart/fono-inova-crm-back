/**
 * 💼 Meta Ads Service
 * Serviço de integração com Meta Marketing API usando REST (sem SDK problemático)
 * Busca campanhas, insights e sincroniza com banco local
 */

import MetaCampaign from '../../models/MetaCampaign.js';
import Leads from '../../models/Leads.js';
import { detectSpecialtyFromCampaignName, calculateCPL } from '../../utils/campaignDetector.js';
import logger from '../../utils/logger.js';

// Configurações
const API_VERSION = 'v18.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

function getToken() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    throw new Error('META_ACCESS_TOKEN não configurado no .env');
  }
  return token;
}

function getAccountIds() {
  const ids = process.env.META_AD_ACCOUNT_IDS || process.env.META_AD_ACCOUNT_ID || 'act_976430640058336';
  return ids.split(',').map(id => id.trim());
}

/**
 * Faz requisição para API do Meta
 */
async function metaApiRequest(endpoint, params = {}) {
  const token = getToken();
  const url = new URL(`${BASE_URL}/${endpoint}`);
  
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, value);
    }
  });
  url.searchParams.append('access_token', token);
  
  const response = await fetch(url.toString());
  const data = await response.json();
  
  if (data.error) {
    throw new Error(data.error.message || 'Erro na API do Meta');
  }
  
  return data;
}

/**
 * Verifica informações do token (debug)
 */
export async function debugToken() {
  const token = getToken();
  
  try {
    const appToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
    const data = await metaApiRequest('debug_token', {
      input_token: token,
      access_token: appToken
    });
    
    if (data.data) {
      const expiresAt = data.data.expires_at ? new Date(data.data.expires_at * 1000) : null;
      const now = new Date();
      const daysUntilExpiry = expiresAt ? Math.floor((expiresAt - now) / (1000 * 60 * 60 * 24)) : null;
      
      return {
        app_id: data.data.app_id,
        is_valid: data.data.is_valid,
        type: data.data.type,
        issued_at: data.data.issued_at ? new Date(data.data.issued_at * 1000) : null,
        expires_at: expiresAt,
        days_until_expiry: daysUntilExpiry,
        scopes: data.data.scopes,
        error: data.data.error
      };
    }
    
    return { error: 'Erro desconhecido' };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Busca campanhas de todas as contas configuradas
 * @returns {Promise<Array>} - Lista de campanhas
 */
export async function fetchCampaigns() {
  const token = getToken();
  const accountIds = getAccountIds();
  
  logger.info(`[MetaAds] Token carregado: ${token.substring(0, 30)}... (${token.length} chars)`);
  logger.info(`[MetaAds] Buscando campanhas de ${accountIds.length} conta(s): ${accountIds.join(', ')}`);
  
  const allCampaigns = [];
  
  for (const accountId of accountIds) {
    try {
      logger.info(`[MetaAds] Buscando da conta ${accountId}...`);
      
      const data = await metaApiRequest(`${accountId}/campaigns`, {
        fields: 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time',
        limit: 50
      });
      
      const campaigns = data.data || [];
      logger.info(`[MetaAds] Conta ${accountId}: ${campaigns.length} campanhas`);
      
      // Adiciona accountId aos dados da campanha
      const campaignsWithAccount = campaigns.map(campaign => ({
        campaignId: campaign.id,
        name: campaign.name,
        status: campaign.status,
        objective: campaign.objective,
        dailyBudget: campaign.daily_budget ? parseInt(campaign.daily_budget) / 100 : null,
        lifetimeBudget: campaign.lifetime_budget ? parseInt(campaign.lifetime_budget) / 100 : null,
        startTime: campaign.start_time,
        stopTime: campaign.stop_time,
        accountId: accountId // Identifica qual conta
      }));
      
      allCampaigns.push(...campaignsWithAccount);
      
    } catch (error) {
      logger.error(`[MetaAds] Erro ao buscar da conta ${accountId}:`, error.message);
      // Continua para próxima conta em caso de erro
    }
  }
  
  logger.info(`[MetaAds] Total: ${allCampaigns.length} campanhas de ${accountIds.length} conta(s)`);
  return allCampaigns;
}

/**
 * Busca insights (métricas) de uma campanha
 */
export async function fetchCampaignInsights(campaignId, datePreset = 'last_30d') {
  const token = getToken();
  
  logger.info(`[MetaAds] Buscando insights da campanha ${campaignId} (${datePreset})`);
  
  try {
    const data = await metaApiRequest(`${campaignId}/insights`, {
      fields: 'spend,impressions,clicks,ctr,cpc,cpp,actions,action_values',
      date_preset: datePreset,
      limit: 1
    });
    
    const insights = data.data?.[0];
    
    if (!insights) {
      return null;
    }
    
    // Extrai leads do actions
    const leadsAction = insights.actions?.find(a => a.action_type === 'lead');
    const leads = leadsAction ? parseInt(leadsAction.value) : 0;
    
    return {
      spend: parseFloat(insights.spend) || 0,
      impressions: parseInt(insights.impressions) || 0,
      clicks: parseInt(insights.clicks) || 0,
      ctr: parseFloat(insights.ctr) || 0,
      cpc: parseFloat(insights.cpc) || 0,
      leads
    };
    
  } catch (error) {
    logger.error(`[MetaAds] Erro ao buscar insights de ${campaignId}:`, error.message);
    return null;
  }
}

/**
 * Sincroniza campanhas com cache local
 */
export async function syncCampaignsWithCache(force = false) {
  logger.info('[MetaAds] Iniciando sincronização de campanhas...');
  
  const campaigns = await fetchCampaigns();
  let synced = 0;
  let errors = 0;
  
  for (const campaign of campaigns) {
    try {
      // Detecta especialidade do nome
      const specialty = detectSpecialtyFromCampaignName(campaign.name);
      
      // Busca ou cria no banco
      await MetaCampaign.findOneAndUpdate(
        { campaignId: campaign.campaignId },
        {
          ...campaign,
          specialty,
          lastSyncedAt: new Date()
        },
        { upsert: true, new: true }
      );
      
      synced++;
    } catch (error) {
      logger.error(`[MetaAds] Erro ao sincronizar campanha ${campaign.campaignId}:`, error.message);
      errors++;
    }
  }
  
  logger.info(`[MetaAds] Sincronização concluída: ${synced} sincronizadas, ${errors} erros`);
  
  return { synced, total: campaigns.length, errors };
}

/**
 * Atualiza contagem de leads por campanha
 */
export async function updateCampaignLeadCounts() {
  logger.info('[MetaAds] Atualizando contagem de leads...');
  
  const campaigns = await MetaCampaign.find({ status: 'ACTIVE' });
  
  for (const campaign of campaigns) {
    try {
      // Conta leads que vieram desta campanha
      const leadsCount = await Leads.countDocuments({
        'metaTracking.campaignId': campaign.campaignId
      });
      
      // Conta pacientes convertidos
      const patientsCount = await Leads.countDocuments({
        'metaTracking.campaignId': campaign.campaignId,
        convertedToPatient: { $ne: null }
      });
      
      // Calcula CPL
      const cpl = campaign.insights?.spend && leadsCount > 0
        ? campaign.insights.spend / leadsCount
        : null;
      
      await MetaCampaign.updateOne(
        { _id: campaign._id },
        {
          leadsCount,
          patientsCount,
          cpl,
          updatedAt: new Date()
        }
      );
      
    } catch (error) {
      logger.error(`[MetaAds] Erro ao atualizar leads de ${campaign.campaignId}:`, error.message);
    }
  }
  
  logger.info('[MetaAds] Contagem de leads atualizada');
}

/**
 * Retorna campanhas do cache
 */
export async function getCampaignsFromCache({ specialty, status } = {}) {
  const query = {};
  
  if (specialty) {
    query.specialty = specialty;
  }
  
  if (status) {
    query.status = status.toUpperCase();
  }
  
  return await MetaCampaign.find(query)
    .sort({ lastSyncedAt: -1 })
    .lean();
}

/**
 * Verifica se deve sincronizar (cache expirou)
 */
export async function shouldSync() {
  const lastCampaign = await MetaCampaign.findOne().sort({ lastSyncedAt: -1 });
  
  if (!lastCampaign || !lastCampaign.lastSyncedAt) {
    return true;
  }
  
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
  return lastCampaign.lastSyncedAt < thirtyMinutesAgo;
}

/**
 * Retorna métricas agregadas
 */
export async function getAggregatedMetrics() {
  const campaigns = await MetaCampaign.find({ status: 'ACTIVE' });
  
  const totalSpend = campaigns.reduce((sum, c) => sum + (c.insights?.spend || 0), 0);
  const totalLeads = campaigns.reduce((sum, c) => sum + (c.leadsCount || 0), 0);
  const totalPatients = campaigns.reduce((sum, c) => sum + (c.patientsCount || 0), 0);
  
  return {
    totalSpend,
    totalLeads,
    totalPatients,
    avgCpl: totalLeads > 0 ? totalSpend / totalLeads : null,
    avgCpa: totalPatients > 0 ? totalSpend / totalPatients : null,
    campaignCount: campaigns.length
  };
}

/**
 * Associa lead a campanha manualmente
 */
export async function associateLeadToCampaign(leadId, campaignId) {
  const campaign = await MetaCampaign.findOne({ campaignId });
  
  if (!campaign) {
    throw new Error('Campanha não encontrada');
  }
  
  const lead = await Leads.findByIdAndUpdate(
    leadId,
    {
      'metaTracking.campaignId': campaignId,
      'metaTracking.campaign': campaign.name,
      'metaTracking.source': 'meta_ads'
    },
    { new: true }
  );
  
  if (!lead) {
    throw new Error('Lead não encontrado');
  }
  
  return lead;
}

export default {
  fetchCampaigns,
  fetchCampaignInsights,
  syncCampaignsWithCache,
  updateCampaignLeadCounts,
  getCampaignsFromCache,
  shouldSync,
  getAggregatedMetrics,
  associateLeadToCampaign,
  debugToken
};
