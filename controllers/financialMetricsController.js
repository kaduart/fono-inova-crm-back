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
