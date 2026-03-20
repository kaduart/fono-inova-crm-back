/**
 * 📊 Analytics Routes
 * 
 * Endpoints para dashboard de revenue e atribuição
 */

import express from 'express';
import { auth } from '../middleware/auth.js';
import revenueAnalytics from '../services/revenueAnalyticsService.js';

const router = express.Router();

/**
 * GET /api/analytics/revenue-by-source
 * 
 * Retorna receita total agrupada por origem (source)
 * Query params: startDate, endDate (opcional)
 */
router.get('/revenue-by-source', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await revenueAnalytics.getRevenueBySource(startDate, endDate);
    
    res.json({
      success: true,
      data,
      meta: { startDate, endDate }
    });
  } catch (error) {
    console.error('[Analytics] Error in revenue-by-source:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/analytics/revenue-by-campaign
 * 
 * Retorna receita total agrupada por campanha
 * Query params: startDate, endDate, source (opcional)
 */
router.get('/revenue-by-campaign', auth, async (req, res) => {
  try {
    const { startDate, endDate, source } = req.query;
    const data = await revenueAnalytics.getRevenueByCampaign(startDate, endDate, source);
    
    res.json({
      success: true,
      data,
      meta: { startDate, endDate, source }
    });
  } catch (error) {
    console.error('[Analytics] Error in revenue-by-campaign:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/analytics/gmb-revenue
 * 
 * Retorna receita específica do GMB (Google Business Profile)
 * Query params: startDate, endDate (opcional)
 */
router.get('/gmb-revenue', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await revenueAnalytics.getGMBRevenue(startDate, endDate);
    
    res.json({
      success: true,
      data,
      meta: { startDate, endDate, source: 'gmb' }
    });
  } catch (error) {
    console.error('[Analytics] Error in gmb-revenue:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/analytics/dashboard
 * 
 * Retorna dashboard consolidado com todas as métricas
 * Query params: startDate, endDate (opcional)
 */
router.get('/dashboard', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const data = await revenueAnalytics.getRevenueDashboard(startDate, endDate);
    
    res.json({
      success: true,
      data,
      meta: { startDate, endDate }
    });
  } catch (error) {
    console.error('[Analytics] Error in dashboard:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/analytics/conversion-funnel
 * 
 * Retorna funnel de conversão: Leads → Appointments → Paid
 * Query params: startDate, endDate, source (opcional)
 */
router.get('/conversion-funnel', auth, async (req, res) => {
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
