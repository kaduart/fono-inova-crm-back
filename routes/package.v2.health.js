// back/routes/package.v2.health.js
/**
 * Health Check para Packages V2
 * 
 * Endpoint rápido para monitoramento
 */

import express from 'express';
import PackagesView from '../models/PackagesView.js';
import { createContextLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createContextLogger('PackageV2Health');

/**
 * GET /api/v2/packages/health
 * 
 * Retorna métricas rápidas do sistema
 */
router.get('/', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Métricas básicas
    const [totalViews, staleViews, byStatus] = await Promise.all([
      PackagesView.countDocuments(),
      PackagesView.countDocuments({ 'snapshot.isStale': true }),
      PackagesView.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
    ]);
    
    // Última atualização
    const lastUpdate = await PackagesView.findOne()
      .sort({ 'snapshot.calculatedAt': -1 })
      .select('snapshot.calculatedAt')
      .lean();
    
    const duration = Date.now() - startTime;
    
    const health = {
      status: staleViews > 10 ? 'warning' : 'healthy',
      totalViews,
      staleViews,
      stalePercentage: totalViews > 0 ? Math.round((staleViews / totalViews) * 100) : 0,
      byStatus: byStatus.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      lastUpdate: lastUpdate?.snapshot?.calculatedAt || null,
      responseTime: `${duration}ms`
    };
    
    res.json({
      success: true,
      health,
      meta: { timestamp: new Date().toISOString() }
    });
    
  } catch (error) {
    logger.error('[PackageV2Health] Health check failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Health check failed',
      message: error.message
    });
  }
});

export default router;
