/**
 * Meta Ads Routes — /api/meta
 */

import express from 'express';
import { auth } from '../middleware/auth.js';
import * as meta from '../services/metaAdsService.js';
import logger from '../utils/logger.js';

const router = express.Router();
router.use(auth);

function fail(res, err) {
  const status = err.response?.status || 500;
  logger.error('[MetaAds]', err.message);
  return res.status(status).json({ success: false, error: err.message });
}

// GET /api/meta/accounts
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await meta.getAdAccounts();
    res.json({ success: true, accounts });
  } catch (err) { fail(res, err); }
});

// GET /api/meta/campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const { status, refresh } = req.query;
    if (refresh === 'true') await meta.syncCampaignsWithCache(true);
    const campaigns = await meta.getCampaigns({ status });
    res.json({ success: true, count: campaigns.length, campaigns });
  } catch (err) { fail(res, err); }
});

// POST /api/meta/campaigns
router.post('/campaigns', async (req, res) => {
  try {
    const { name, objective, dailyBudget, lifetimeBudget } = req.body;
    if (!name || !objective) {
      return res.status(400).json({ success: false, error: 'name e objective são obrigatórios' });
    }
    const result = await meta.createCampaign({ name, objective, dailyBudget, lifetimeBudget });
    res.status(201).json({ success: true, campaign: result });
  } catch (err) { fail(res, err); }
});

// PATCH /api/meta/campaigns/:id
router.patch('/campaigns/:id', async (req, res) => {
  try {
    const { name, budget, status, dailyBudget, lifetimeBudget } = req.body;
    const result = await meta.updateCampaign(req.params.id, { name, status, dailyBudget, lifetimeBudget });
    res.json({ success: true, result });
  } catch (err) { fail(res, err); }
});

// PATCH /api/meta/campaigns/:id/pause
router.patch('/campaigns/:id/pause', async (req, res) => {
  try {
    const result = await meta.pauseCampaign(req.params.id);
    res.json({ success: true, result });
  } catch (err) { fail(res, err); }
});

// PATCH /api/meta/campaigns/:id/activate
router.patch('/campaigns/:id/activate', async (req, res) => {
  try {
    const result = await meta.activateCampaign(req.params.id);
    res.json({ success: true, result });
  } catch (err) { fail(res, err); }
});

// GET /api/meta/adsets?campaignId=
router.get('/adsets', async (req, res) => {
  try {
    const adsets = await meta.getAdSets(req.query.campaignId);
    res.json({ success: true, count: adsets.length, adsets });
  } catch (err) { fail(res, err); }
});

// POST /api/meta/adsets
router.post('/adsets', async (req, res) => {
  try {
    const { campaignId, name, dailyBudget, billingEvent, optimizationGoal, targeting } = req.body;
    if (!campaignId || !name || !dailyBudget) {
      return res.status(400).json({ success: false, error: 'campaignId, name e dailyBudget são obrigatórios' });
    }
    const result = await meta.createAdSet({ campaignId, name, dailyBudget, billingEvent, optimizationGoal, targeting });
    res.status(201).json({ success: true, adset: result });
  } catch (err) { fail(res, err); }
});

// GET /api/meta/ads?adsetId=
router.get('/ads', async (req, res) => {
  try {
    const ads = await meta.getAds(req.query.adsetId);
    res.json({ success: true, count: ads.length, ads });
  } catch (err) { fail(res, err); }
});

// POST /api/meta/ads
router.post('/ads', async (req, res) => {
  try {
    const { adsetId, name, creativeId } = req.body;
    if (!adsetId || !name || !creativeId) {
      return res.status(400).json({ success: false, error: 'adsetId, name e creativeId são obrigatórios' });
    }
    const result = await meta.createAd({ adsetId, name, creativeId });
    res.status(201).json({ success: true, ad: result });
  } catch (err) { fail(res, err); }
});

// GET /api/meta/insights?level=campaign|adset|ad&datePreset=last_7d
router.get('/insights', async (req, res) => {
  try {
    const { level = 'campaign', datePreset = 'last_7d', ids } = req.query;
    const idList = ids ? ids.split(',') : undefined;
    const insights = await meta.getInsights({ level, datePreset, ids: idList });
    res.json({ success: true, count: insights.length, insights });
  } catch (err) { fail(res, err); }
});

// POST /api/meta/sync
router.post('/sync', async (req, res) => {
  try {
    const result = await meta.syncCampaignsWithCache(true);
    await meta.updateCampaignLeadCounts();
    res.json({ success: true, message: 'Sincronização concluída', ...result });
  } catch (err) { fail(res, err); }
});

// GET /api/meta/debug-token
router.get('/debug-token', async (req, res) => {
  try {
    const debug = await meta.debugToken();
    res.json({
      success: true,
      debug,
      env_check: {
        has_token: !!process.env.META_ACCESS_TOKEN,
        has_app_id: !!process.env.META_APP_ID,
        has_app_secret: !!process.env.META_APP_SECRET,
        account_id: process.env.META_AD_ACCOUNT_ID
      }
    });
  } catch (err) { fail(res, err); }
});

export default router;
