// services/insuranceDashboardService.js
// Dashboard Financeiro de Convênio V2 - Agregação de Payments

import Payment from '../models/Payment.js';
import InsuranceBatch from '../models/InsuranceBatch.js';

/**
 * Retorna resumo financeiro de convênios para dashboard
 * Fonte: Payment.insurance.status (source of truth)
 */
export async function getInsuranceSummary({ month, year, insuranceProvider }) {
  console.log('[InsuranceDashboard] Gerando resumo', { month, year, insuranceProvider });
  
  // Build filter base
  const matchFilter = {
    billingType: 'convenio'
  };
  
  // Filtro por período (se fornecido)
  if (month && year) {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    matchFilter.createdAt = { $gte: startDate, $lte: endDate };
  }
  
  // Filtro por convênio (se fornecido)
  if (insuranceProvider) {
    matchFilter['insurance.provider'] = insuranceProvider;
  }
  
  // Agregação por status
  const summaryByStatus = await Payment.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: '$insurance.status',
        total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount', 0] } },
        count: { $sum: 1 }
      }
    }
  ]);
  
  // Formata resposta
  const result = {
    pending_billing: { total: 0, count: 0, label: 'A faturar' },
    billed: { total: 0, count: 0, label: 'Faturado' },
    received: { total: 0, count: 0, label: 'Recebido' },
    partial: { total: 0, count: 0, label: 'Parcial' },
    glosa: { total: 0, count: 0, label: 'Glosa' }
  };
  
  let grandTotal = 0;
  let totalCount = 0;
  
  for (const item of summaryByStatus) {
    const status = item._id || 'pending_billing';
    if (result[status]) {
      result[status].total = item.total || 0;
      result[status].count = item.count || 0;
      grandTotal += item.total || 0;
      totalCount += item.count || 0;
    }
  }
  
  // Totais calculados
  const aReceber = result.pending_billing.total + result.billed.total;
  const recebido = result.received.total + result.partial.total;
  
  return {
    // Breakdown por status (igual ao legado)
    breakdown: result,
    
    // Totais consolidados (para cards do dashboard)
    totals: {
      aFaturar: result.pending_billing.total,
      faturado: result.billed.total,
      aReceber: aReceber,
      recebido: recebido,
      glosa: result.glosa.total,
      geral: grandTotal
    },
    
    // Contagens
    counts: {
      aFaturar: result.pending_billing.count,
      faturado: result.billed.count,
      recebido: result.received.count + result.partial.count,
      glosa: result.glosa.count,
      total: totalCount
    },
    
    // Metadados
    meta: {
      month: month || null,
      year: year || null,
      insuranceProvider: insuranceProvider || 'todos',
      generatedAt: new Date().toISOString()
    }
  };
}

/**
 * Lista convênios disponíveis para filtro
 */
export async function getInsuranceProviders() {
  const providers = await Payment.distinct('insurance.provider', {
    billingType: 'convenio',
    'insurance.provider': { $exists: true, $ne: null }
  });
  
  return providers.sort();
}

/**
 * Detalhe por convênio (para gráficos)
 */
export async function getSummaryByProvider({ month, year }) {
  const matchFilter = {
    billingType: 'convenio',
    'insurance.provider': { $exists: true, $ne: null }
  };
  
  if (month && year) {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    matchFilter.createdAt = { $gte: startDate, $lte: endDate };
  }
  
  const byProvider = await Payment.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: {
          provider: '$insurance.provider',
          status: '$insurance.status'
        },
        total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount', 0] } },
        count: { $sum: 1 }
      }
    },
    {
      $group: {
        _id: '$_id.provider',
        statuses: {
          $push: {
            status: '$_id.status',
            total: '$total',
            count: '$count'
          }
        },
        totalValue: { $sum: '$total' },
        totalCount: { $sum: '$count' }
      }
    },
    { $sort: { totalValue: -1 } }
  ]);
  
  return byProvider.map(p => ({
    provider: p._id,
    total: p.totalValue,
    count: p.totalCount,
    breakdown: p.statuses.reduce((acc, s) => {
      acc[s.status] = { total: s.total, count: s.count };
      return acc;
    }, {})
  }));
}

export default {
  getInsuranceSummary,
  getInsuranceProviders,
  getSummaryByProvider
};
