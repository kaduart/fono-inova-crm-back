// controllers/insuranceDashboardController.js
// Controller do Dashboard Financeiro de Convênio V2

import {
  getInsuranceSummary,
  getInsuranceProviders,
  getSummaryByProvider
} from '../services/insuranceDashboardService.js';

/**
 * GET /api/v2/financial/insurance-summary
 * Resumo financeiro de convênios (plugável no front legado)
 */
export async function getSummaryController(req, res) {
  try {
    const { month, year, provider } = req.query;
    
    const summary = await getInsuranceSummary({
      month: month ? parseInt(month) : null,
      year: year ? parseInt(year) : null,
      insuranceProvider: provider || null
    });
    
    res.json({
      success: true,
      data: summary
    });
    
  } catch (error) {
    console.error('[InsuranceDashboard] Erro ao gerar resumo:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * GET /api/v2/financial/insurance-providers
 * Lista convênios disponíveis
 */
export async function getProvidersController(req, res) {
  try {
    const providers = await getInsuranceProviders();
    
    res.json({
      success: true,
      data: providers
    });
    
  } catch (error) {
    console.error('[InsuranceDashboard] Erro ao listar convênios:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * GET /api/v2/financial/insurance-by-provider
 * Resumo detalhado por convênio (para gráficos)
 */
export async function getByProviderController(req, res) {
  try {
    const { month, year } = req.query;
    
    const data = await getSummaryByProvider({
      month: month ? parseInt(month) : null,
      year: year ? parseInt(year) : null
    });
    
    res.json({
      success: true,
      data
    });
    
  } catch (error) {
    console.error('[InsuranceDashboard] Erro ao gerar resumo por convênio:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

export default {
  getSummary: getSummaryController,
  getProviders: getProvidersController,
  getByProvider: getByProviderController
};
