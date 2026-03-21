/**
 * 💰 Financial Metrics Controller
 * 
 * Endpoint v2 unificado para métricas financeiras.
 * Substitui/consolida múltiplos endpoints legados:
 * - /financial (resumo geral)
 * - /cashflow (fluxo de caixa)
 * - /provisionamento (produção)
 * 
 * GET /api/financial/v2/overview
 */

import financialMetricsService from '../services/financialMetrics.service.js';
import historicalRatesService from '../services/historicalRates.service.js';

/**
 * GET /api/financial/v2/overview
 * 
 * Query params:
 * - startDate: ISO date string (obrigatório)
 * - endDate: ISO date string (obrigatório)
 * - includeKPIs: boolean (opcional, default: false)
 */
export const getOverview = async (req, res) => {
  try {
    const { startDate, endDate, includeKPIs } = req.query;

    // Validações
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_DATES',
        message: 'startDate e endDate são obrigatórios (formato ISO 8601)'
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_DATES',
        message: 'Datas inválidas. Use formato ISO 8601 (ex: 2026-03-01T00:00:00.000Z)'
      });
    }

    if (start > end) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_RANGE',
        message: 'startDate deve ser anterior ou igual a endDate'
      });
    }

    const period = { startDate: start, endDate: end };

    // Chamar service apropriado
    let result;
    if (includeKPIs === 'true' || includeKPIs === true) {
      result = await financialMetricsService.getKPIs(period);
    } else {
      result = await financialMetricsService.getOverview(period);
    }

    res.json({
      success: true,
      data: result,
      meta: {
        version: '2.0',
        sources: ['Payment', 'Session (FASE 1 - híbrido)'],
        notes: 'Session.paidAt implementado - caixa de pacote usa data correta'
      }
    });

  } catch (error) {
    console.error('❌ Erro no financialMetricsController:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
};

/**
 * GET /api/financial/v2/cash
 * 
 * Apenas caixa (para relatórios específicos)
 */
export const getCash = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_DATES',
        message: 'startDate e endDate são obrigatórios'
      });
    }

    const period = {
      startDate: new Date(startDate),
      endDate: new Date(endDate)
    };

    const cash = await financialMetricsService.calculateCash(period);

    res.json({
      success: true,
      data: cash
    });

  } catch (error) {
    console.error('❌ Erro ao calcular caixa:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
};

/**
 * GET /api/financial/v2/production
 * 
 * Apenas produção (serviços realizados)
 */
export const getProduction = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_DATES',
        message: 'startDate e endDate são obrigatórios'
      });
    }

    const period = {
      startDate: new Date(startDate),
      endDate: new Date(endDate)
    };

    const production = await financialMetricsService.calculateProduction(period);

    res.json({
      success: true,
      data: production
    });

  } catch (error) {
    console.error('❌ Erro ao calcular produção:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
};

/**
 * GET /api/financial/v2/receivable-detail
 *
 * Detalhe das guias convênio faturadas não recebidas
 */
export const getReceivableDetail = async (req, res) => {
  try {
    const Payment = (await import('../models/Payment.js')).default;
    const Session = (await import('../models/Session.js')).default;
    const Package = (await import('../models/Package.js')).default;

    // 1. Guias formalmente faturadas (Payment com insurance.status: 'billed')
    const payments = await Payment.find({
      billingType: 'convenio',
      'insurance.status': 'billed'
    })
      .populate('patient', 'fullName')
      .sort({ 'insurance.billedAt': -1 })
      .lean();

    const paymentItems = payments.map(p => ({
      _id: p._id,
      patientName: p.patient?.fullName || '—',
      convenio: p.insurance?.name || p.convenioName || '—',
      grossAmount: p.insurance?.grossAmount || 0,
      billedAt: p.insurance?.billedAt,
      status: 'Guia faturada',
      source: 'payment'
    }));

    // 2. Sessões de pacote convênio completadas não pagas (sem Payment vinculado)
    const sessionsPendentes = await Session.aggregate([
      {
        $match: {
          status: 'completed',
          paymentMethod: 'convenio',
          package: { $exists: true, $ne: null },
          $or: [{ isPaid: false }, { isPaid: { $exists: false } }]
        }
      },
      {
        $lookup: {
          from: 'payments',
          let: { sid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$session', '$$sid'] }, status: { $ne: 'canceled' } } },
            { $limit: 1 }
          ],
          as: 'linkedPayment'
        }
      },
      { $match: { linkedPayment: { $size: 0 } } },
      { $lookup: { from: 'packages', localField: 'package', foreignField: '_id', as: 'pkg' } },
      { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'patients', localField: 'patient', foreignField: '_id', as: 'patientDoc' } },
      { $unwind: { path: '$patientDoc', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          patientName: { $ifNull: ['$patientDoc.fullName', '—'] },
          convenio: { $ifNull: ['$pkg.insuranceProvider', '—'] },
          grossAmount: {
            $cond: {
              if: { $gt: ['$sessionValue', 0] },
              then: '$sessionValue',
              else: { $ifNull: ['$pkg.insuranceGrossAmount', 0] }
            }
          },
          date: '$date',
          status: { $literal: 'Sessão não paga' },
          source: { $literal: 'session' }
        }
      }
    ]);

    const items = [...paymentItems, ...sessionsPendentes]
      .sort((a, b) => (b.billedAt || b.date || '') > (a.billedAt || a.date || '') ? 1 : -1);

    res.json({ success: true, data: { items, total: items.reduce((s, i) => s + (i.grossAmount || 0), 0), count: items.length } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/financial/v2/historical-rates
 *
 * Taxas históricas de comparecimento e pagamento (últimos N dias)
 * Usadas para calcular cenários de projeção com dados reais
 */
export const getHistoricalRates = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 90;

    if (days < 7 || days > 365) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_DAYS',
        message: 'days deve estar entre 7 e 365'
      });
    }

    const rates = await historicalRatesService.getHistoricalRates(days);

    res.json({ success: true, data: rates });

  } catch (error) {
    console.error('❌ Erro ao calcular taxas históricas:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
};

/**
 * GET /api/financial/v2/receivable
 *
 * Apenas a receber (contas a receber)
 */
export const getReceivable = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_DATES',
        message: 'startDate e endDate são obrigatórios'
      });
    }

    const period = {
      startDate: new Date(startDate),
      endDate: new Date(endDate)
    };

    const receivable = await financialMetricsService.calculateReceivable(period);

    res.json({
      success: true,
      data: receivable
    });

  } catch (error) {
    console.error('❌ Erro ao calcular a receber:', error);
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
};
