/**
 * 📊 Financial Metrics Dashboard
 *
 * Retorna métricas estruturadas para monitoramento interno dos serviços financeiros.
 */

import express from 'express';
import moment from 'moment-timezone';
import { auth, authorize } from '../../middleware/auth.js';
import MetricLog from '../../models/MetricLog.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

/**
 * @route   GET /api/v2/admin/financial-metrics
 * @desc    Métricas financeiras dos últimos N minutos/horas/dias
 * @query   ?window=24h (padrão) | 7d | 30d
 * @access  Admin
 */
router.get('/', auth, authorize(['admin']), async (req, res) => {
  try {
    const { window = '24h' } = req.query;
    const match = {};

    if (window) {
      const value = parseInt(window, 10);
      const unit = window.replace(/\d+/g, '');
      const since = moment.tz(TIMEZONE).subtract(value, unit).toDate();
      match.timestamp = { $gte: since };
    }

    // Agregação simples sem $percentile para compatibilidade com MongoDB < 7.0
    const metrics = await MetricLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: { service: '$service', operation: '$operation' },
          count: { $sum: 1 },
          avg: { $avg: '$data.executionTimeMs' },
          min: { $min: '$data.executionTimeMs' },
          max: { $max: '$data.executionTimeMs' },
          last: { $last: '$data.executionTimeMs' }
        }
      },
      { $sort: { '_id.service': 1, '_id.operation': 1 } }
    ]);

    const normalized = metrics.map(m => ({
      service: m._id.service,
      operation: m._id.operation,
      count: m.count,
      avg: Math.round((m.avg || 0) * 100) / 100,
      min: Math.round((m.min || 0) * 100) / 100,
      max: Math.round((m.max || 0) * 100) / 100,
      last: Math.round((m.last || 0) * 100) / 100
    }));

    // Contagem de chamadas de endpoints legados
    const legacyServices = ['LegacyCashflow', 'LegacyFinancialDashboard', 'LegacyFinancialMetrics'];
    const legacyCounts = await MetricLog.aggregate([
      { $match: { ...match, service: { $in: legacyServices } } },
      { $group: { _id: '$service', calls: { $sum: 1 } } }
    ]);

    res.json({
      success: true,
      window,
      generatedAt: new Date().toISOString(),
      metrics: normalized,
      legacy: legacyCounts.reduce((acc, item) => {
        acc[item._id] = item.calls;
        return acc;
      }, {})
    });
  } catch (error) {
    console.error('[FinancialMetricsRoutes]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
