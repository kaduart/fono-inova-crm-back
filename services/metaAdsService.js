/**
 * Meta Ads Service — Graph API v21.0
 * Conta principal: act_1313865209694265 (CA01 / BM01 Fono Inova)
 */

import axios from 'axios';
import MetaCampaign from '../models/MetaCampaign.js';
import Leads from '../models/Leads.js';
import { detectSpecialtyFromCampaignName } from '../utils/campaignDetector.js';
import logger from '../utils/logger.js';

const BASE = 'https://graph.facebook.com/v21.0';

function token() {
  const t = process.env.META_ACCESS_TOKEN;
  if (!t) throw new Error('META_ACCESS_TOKEN não configurado');
  return t;
}

function accountId() {
  const id = process.env.META_AD_ACCOUNT_ID || 'act_1313865209694265';
  return id.startsWith('act_') ? id : `act_${id}`;
}

async function get(path, params = {}) {
  const { data } = await axios.get(`${BASE}/${path}`, {
    params: { ...params, access_token: token() }
  });
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function post(path, body = {}) {
  const { data } = await axios.post(`${BASE}/${path}`, null, {
    params: { ...body, access_token: token() }
  });
  if (data.error) throw new Error(data.error.message);
  return data;
}

// ── Contas ──────────────────────────────────────────────────────────────────

export async function getAdAccounts() {
  const data = await get('me/adaccounts', {
    fields: 'id,name,account_status,currency,timezone_name'
  });
  return data.data || [];
}

// ── Campanhas ────────────────────────────────────────────────────────────────

export async function getCampaigns({ status, limit = 50 } = {}) {
  const params = {
    fields: 'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time',
    limit
  };
  if (status) params.effective_status = JSON.stringify([status]);

  const data = await get(`${accountId()}/campaigns`, params);

  return (data.data || []).map(c => ({
    campaignId: c.id,
    name: c.name,
    status: c.status,
    objective: c.objective || null,
    dailyBudget: c.daily_budget ? parseInt(c.daily_budget) / 100 : null,
    lifetimeBudget: c.lifetime_budget ? parseInt(c.lifetime_budget) / 100 : null,
    accountId: accountId(),
    specialty: detectSpecialtyFromCampaignName(c.name)
  }));
}

export async function createCampaign({ name, objective, dailyBudget, lifetimeBudget }) {
  return post(`${accountId()}/campaigns`, {
    name,
    objective,
    status: 'PAUSED',
    ...(dailyBudget && { daily_budget: Math.round(dailyBudget * 100) }),
    ...(lifetimeBudget && { lifetime_budget: Math.round(lifetimeBudget * 100) }),
    special_ad_categories: '[]'
  });
}

export async function updateCampaign(campaignId, fields) {
  const body = {};
  if (fields.name) body.name = fields.name;
  if (fields.status) body.status = fields.status;
  if (fields.dailyBudget != null) body.daily_budget = Math.round(fields.dailyBudget * 100);
  if (fields.lifetimeBudget != null) body.lifetime_budget = Math.round(fields.lifetimeBudget * 100);

  const { data } = await axios.post(`${BASE}/${campaignId}`, null, {
    params: { ...body, access_token: token() }
  });
  return data;
}

export async function pauseCampaign(campaignId) {
  return updateCampaign(campaignId, { status: 'PAUSED' });
}

export async function activateCampaign(campaignId) {
  return updateCampaign(campaignId, { status: 'ACTIVE' });
}

// ── Ad Sets ──────────────────────────────────────────────────────────────────

export async function getAdSets(campaignId) {
  const params = {
    fields: 'id,name,status,daily_budget,lifetime_budget,billing_event,optimization_goal,targeting',
    limit: 50
  };
  const path = campaignId
    ? `${campaignId}/adsets`
    : `${accountId()}/adsets`;

  const data = await get(path, params);
  return data.data || [];
}

export async function createAdSet({ campaignId, name, dailyBudget, billingEvent = 'IMPRESSIONS', optimizationGoal = 'REACH', targeting = {} }) {
  return post(`${accountId()}/adsets`, {
    campaign_id: campaignId,
    name,
    status: 'PAUSED',
    daily_budget: Math.round(dailyBudget * 100),
    billing_event: billingEvent,
    optimization_goal: optimizationGoal,
    targeting: JSON.stringify(targeting)
  });
}

// ── Anúncios ─────────────────────────────────────────────────────────────────

export async function getAds(adsetId) {
  const params = {
    fields: 'id,name,status,creative,adset_id',
    limit: 50
  };
  const path = adsetId
    ? `${adsetId}/ads`
    : `${accountId()}/ads`;

  const data = await get(path, params);
  return data.data || [];
}

export async function createAd({ adsetId, name, creativeId }) {
  return post(`${accountId()}/ads`, {
    adset_id: adsetId,
    name,
    status: 'PAUSED',
    creative: JSON.stringify({ creative_id: creativeId })
  });
}

// ── Insights ─────────────────────────────────────────────────────────────────

export async function getInsights({ level = 'campaign', datePreset = 'last_7d', ids } = {}) {
  const fields = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,impressions,clicks,spend,ctr,cpc,cpm,actions,cost_per_action_type';
  const params = { fields, level, date_preset: datePreset, limit: 100 };

  let path;
  if (ids && ids.length === 1) {
    path = `${ids[0]}/insights`;
  } else {
    path = `${accountId()}/insights`;
  }

  const data = await get(path, params);
  return (data.data || []).map(row => {
    const leadAction = row.actions?.find(a => a.action_type === 'lead');
    const leads = leadAction ? parseInt(leadAction.value) : 0;
    const cpl = leads > 0 && row.spend ? parseFloat(row.spend) / leads : null;

    return {
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      adsetId: row.adset_id,
      adsetName: row.adset_name,
      adId: row.ad_id,
      adName: row.ad_name,
      spend: parseFloat(row.spend) || 0,
      impressions: parseInt(row.impressions) || 0,
      clicks: parseInt(row.clicks) || 0,
      ctr: parseFloat(row.ctr) || 0,
      cpc: parseFloat(row.cpc) || 0,
      cpm: parseFloat(row.cpm) || 0,
      leads,
      cpl
    };
  });
}

// ── Token debug ───────────────────────────────────────────────────────────────

export async function debugToken() {
  const t = token();
  const appToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
  try {
    const data = await get('debug_token', { input_token: t, access_token: appToken });
    const info = data.data || {};
    const expiresAt = info.expires_at ? new Date(info.expires_at * 1000) : null;
    const daysUntilExpiry = expiresAt
      ? Math.floor((expiresAt - Date.now()) / 86_400_000)
      : null;
    return {
      app_id: info.app_id,
      is_valid: info.is_valid,
      type: info.type,
      expires_at: expiresAt,
      days_until_expiry: daysUntilExpiry,
      scopes: info.scopes,
      error: info.error
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Cache / sync (usado pelo cron) ────────────────────────────────────────────

export async function shouldSync() {
  const last = await MetaCampaign.findOne().sort({ lastSyncAt: -1 });
  if (!last?.lastSyncAt) return true;
  return last.lastSyncAt < new Date(Date.now() - 30 * 60_000);
}

export async function syncCampaignsWithCache(force = false) {
  logger.info('[MetaAds] Sincronizando campanhas...');
  const campaigns = await getCampaigns();
  let synced = 0, errors = 0;

  for (const c of campaigns) {
    try {
      const specialty = detectSpecialtyFromCampaignName(c.name);
      await MetaCampaign.findOneAndUpdate(
        { campaignId: c.id },
        {
          campaignId: c.id,
          accountId: accountId(),
          name: c.name,
          status: c.status,
          objective: c.objective || null,
          dailyBudget: c.daily_budget ? parseInt(c.daily_budget) / 100 : null,
          lifetimeBudget: c.lifetime_budget ? parseInt(c.lifetime_budget) / 100 : null,
          specialty,
          lastSyncAt: new Date()
        },
        { upsert: true, new: true }
      );
      synced++;
    } catch (err) {
      logger.error(`[MetaAds] Erro ao sincronizar ${c.id}:`, err.message);
      errors++;
    }
  }

  logger.info(`[MetaAds] Sync: ${synced} ok, ${errors} erros`);
  return { synced, total: campaigns.length, errors };
}

export async function updateCampaignLeadCounts() {
  const campaigns = await MetaCampaign.find({ status: 'ACTIVE' });

  for (const campaign of campaigns) {
    try {
      const leadsCount = await Leads.countDocuments({ 'metaTracking.campaignId': campaign.campaignId });
      const patientsCount = await Leads.countDocuments({
        'metaTracking.campaignId': campaign.campaignId,
        convertedToPatient: { $ne: null }
      });

      await MetaCampaign.updateOne({ _id: campaign._id }, { leadsCount, patientsCount });
    } catch (err) {
      logger.error(`[MetaAds] Erro ao atualizar leads de ${campaign.campaignId}:`, err.message);
    }
  }
}
