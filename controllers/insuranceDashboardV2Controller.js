/**
 * 💰 Insurance Dashboard V2 - FUNIL FINANCEIRO
 * 
 * Endpoint único que retorna:
 * - Produção (sessões completed)
 * - Faturamento (guias enviadas)
 * - Recebimento (dinheiro no caixa)
 * - Aging (dias em aberto)
 * - Gap (dinheiro perdido/produção não faturada)
 */

import mongoose from 'mongoose';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';

/**
 * GET /api/v2/insurance/dashboard
 * 
 * Query params:
 * - month: MM (ex: 04)
 * - year: YYYY (ex: 2026)
 * - provider: filtro por convênio (opcional)
 */
export async function getInsuranceDashboard(req, res) {
  try {
    const { month, year, provider } = req.query;
    
    if (!month || !year) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetros obrigatórios: month e year (ex: ?month=04&year=2026)'
      });
    }
    
    const startOfMonth = new Date(`${year}-${month}-01T00:00:00-03:00`);
    const endOfMonth = new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0, 23, 59, 59, 999);
    
    console.log(`[InsuranceDashboardV2] Calculando dashboard para ${month}/${year}`);
    
    // =====================================================
    // 1️⃣ PRODUÇÃO (sessões completed no mês)
    // =====================================================
    const productionMatch = {
      status: 'completed',
      date: { $gte: startOfMonth, $lte: endOfMonth },
      $or: [
        { paymentMethod: 'convenio' },
        { insuranceGuide: { $exists: true, $ne: null } },
        { 'package.type': 'convenio' }
      ]
    };
    
    if (provider) {
      productionMatch['$or'] = [
        { 'package.insuranceProvider': provider },
        { 'package.insuranceCompany': provider }
      ];
    }
    
    const productionSessions = await Session.find(productionMatch)
      .populate('package', 'insuranceProvider insuranceCompany insuranceGrossAmount')
      .populate('patient', 'fullName')
      .lean();
    
    const production = {
      total: 0,
      count: 0,
      byProvider: {},
      byPatient: [],
      sessions: []
    };
    
    for (const session of productionSessions) {
      const providerName = session.package?.insuranceProvider || 
                          session.package?.insuranceCompany || 
                          'Outros';
      const value = session.package?.insuranceGrossAmount || 80;
      
      production.total += value;
      production.count += 1;
      
      // Agrupa por convênio
      if (!production.byProvider[providerName]) {
        production.byProvider[providerName] = { total: 0, count: 0 };
      }
      production.byProvider[providerName].total += value;
      production.byProvider[providerName].count += 1;
      
      // Guarda sessão para referência
      production.sessions.push({
        sessionId: session._id.toString(),
        date: session.date,
        patient: session.patient?.fullName,
        provider: providerName,
        value
      });
    }
    
    // =====================================================
    // 2️⃣ FATURAMENTO (guias enviadas no mês)
    // =====================================================
    const billingMatch = {
      billingType: 'convenio',
      'insurance.billedAt': { $gte: startOfMonth, $lte: endOfMonth }
    };
    
    if (provider) {
      billingMatch['insurance.provider'] = provider;
    }
    
    const billingPayments = await Payment.find(billingMatch)
      .populate('session', 'date patient')
      .populate('patient', 'fullName')
      .lean();
    
    const billing = {
      total: 0,
      count: 0,
      byProvider: {},
      payments: []
    };
    
    for (const payment of billingPayments) {
      const providerName = payment.insurance?.provider || 'Outros';
      const value = payment.insurance?.grossAmount || payment.amount || 0;
      
      billing.total += value;
      billing.count += 1;
      
      if (!billing.byProvider[providerName]) {
        billing.byProvider[providerName] = { total: 0, count: 0 };
      }
      billing.byProvider[providerName].total += value;
      billing.byProvider[providerName].count += 1;
      
      billing.payments.push({
        paymentId: payment._id.toString(),
        billedAt: payment.insurance?.billedAt,
        patient: payment.patient?.fullName,
        provider: providerName,
        value,
        notaFiscal: payment.insurance?.notaFiscal
      });
    }
    
    // =====================================================
    // 3️⃣ RECEBIMENTO (dinheiro que entrou no caixa)
    // =====================================================
    const receivedMatch = {
      billingType: 'convenio',
      'insurance.status': 'received',
      'insurance.receivedAt': { $gte: startOfMonth, $lte: endOfMonth }
    };
    
    if (provider) {
      receivedMatch['insurance.provider'] = provider;
    }
    
    const receivedPayments = await Payment.find(receivedMatch)
      .populate('patient', 'fullName')
      .lean();
    
    const received = {
      total: 0,
      count: 0,
      byProvider: {},
      payments: []
    };
    
    for (const payment of receivedPayments) {
      const providerName = payment.insurance?.provider || 'Outros';
      const value = payment.insurance?.netAmount || 
                   payment.insurance?.grossAmount || 
                   payment.amount || 0;
      
      received.total += value;
      received.count += 1;
      
      if (!received.byProvider[providerName]) {
        received.byProvider[providerName] = { total: 0, count: 0 };
      }
      received.byProvider[providerName].total += value;
      received.byProvider[providerName].count += 1;
      
      received.payments.push({
        paymentId: payment._id.toString(),
        receivedAt: payment.insurance?.receivedAt,
        patient: payment.patient?.fullName,
        provider: providerName,
        value
      });
    }
    
    // =====================================================
    // 4️⃣ AGING (dias em aberto - só o que foi produzido mas não recebido)
    // =====================================================
    const agingBuckets = {
      '0-15': { total: 0, count: 0 },
      '16-30': { total: 0, count: 0 },
      '31-60': { total: 0, count: 0 },
      '60+': { total: 0, count: 0 }
    };
    
    const now = new Date();
    
    // Busca payments pendentes (produzido mas não recebido)
    const pendingMatch = {
      billingType: 'convenio',
      'insurance.status': { $in: ['pending_billing', 'billed'] }
    };
    
    if (provider) {
      pendingMatch['insurance.provider'] = provider;
    }
    
    const pendingPayments = await Payment.find(pendingMatch)
      .populate('session', 'date')
      .lean();
    
    for (const payment of pendingPayments) {
      // Data base: quando foi atendido (session.date) ou quando foi faturado
      const baseDate = payment.session?.date || payment.insurance?.billedAt || payment.createdAt;
      const daysOpen = Math.floor((now - new Date(baseDate)) / (1000 * 60 * 60 * 24));
      const value = payment.insurance?.grossAmount || payment.amount || 0;
      
      if (daysOpen <= 15) {
        agingBuckets['0-15'].total += value;
        agingBuckets['0-15'].count += 1;
      } else if (daysOpen <= 30) {
        agingBuckets['16-30'].total += value;
        agingBuckets['16-30'].count += 1;
      } else if (daysOpen <= 60) {
        agingBuckets['31-60'].total += value;
        agingBuckets['31-60'].count += 1;
      } else {
        agingBuckets['60+'].total += value;
        agingBuckets['60+'].count += 1;
      }
    }
    
    // =====================================================
    // 5️⃣ TICKET MÉDIO POR CONVÊNIO
    // =====================================================
    const ticketByProvider = {};
    for (const [name, data] of Object.entries(production.byProvider)) {
      ticketByProvider[name] = data.count > 0 ? (data.total / data.count).toFixed(2) : 0;
    }
    
    // =====================================================
    // 6️⃣ GAP (Dinheiro perdido / não faturado)
    // =====================================================
    // Produção do mês que ainda não foi faturada
    const producedSessionIds = productionSessions.map(s => s._id.toString());
    const billedSessionIds = billingPayments
      .filter(p => p.session)
      .map(p => p.session._id?.toString() || p.session.toString());
    
    const unbilledSessionIds = producedSessionIds.filter(id => !billedSessionIds.includes(id));
    
    const gap = {
      totalUnbilled: 0,
      countUnbilled: unbilledSessionIds.length,
      percentage: production.total > 0 ? ((unbilledSessionIds.length / production.count) * 100).toFixed(1) : 0
    };
    
    // Calcula valor do gap
    for (const session of productionSessions) {
      if (unbilledSessionIds.includes(session._id.toString())) {
        gap.totalUnbilled += session.package?.insuranceGrossAmount || 80;
      }
    }
    
    // =====================================================
    // 7️⃣ FUNIL FINANCEIRO
    // =====================================================
    const funnel = {
      production: production.total,
      billing: billing.total,
      received: received.total,
      
      // Taxas de conversão
      billingRate: production.total > 0 ? ((billing.total / production.total) * 100).toFixed(1) : 0,
      collectionRate: billing.total > 0 ? ((received.total / billing.total) * 100).toFixed(1) : 0,
      overallRate: production.total > 0 ? ((received.total / production.total) * 100).toFixed(1) : 0,
      
      // Gaps
      toBill: production.total - billing.total,  // Produzido mas não faturado
      toReceive: billing.total - received.total   // Faturado mas não recebido
    };
    
    // =====================================================
    // RESPOSTA
    // =====================================================
    res.json({
      success: true,
      period: { month: parseInt(month), year: parseInt(year) },
      
      // 🎯 FUNIL FINANCEIRO (visão geral)
      funnel: {
        description: 'Produção → Faturamento → Recebimento',
        production: funnel.production,
        billing: funnel.billing,
        received: funnel.received,
        conversion: {
          productionToBilling: parseFloat(funnel.billingRate),
          billingToReceived: parseFloat(funnel.collectionRate),
          productionToReceived: parseFloat(funnel.overallRate)
        },
        gaps: {
          toBill: funnel.toBill,
          toReceive: funnel.toReceive
        }
      },
      
      // 💰 PRODUÇÃO (sessões completed)
      production: {
        total: production.total,
        count: production.count,
        byProvider: production.byProvider,
        byPatient: production.sessions.reduce((acc, s) => {
          const existing = acc.find(p => p.patient === s.patient);
          if (existing) {
            existing.total += s.value;
            existing.count += 1;
          } else {
            acc.push({ patient: s.patient, total: s.value, count: 1 });
          }
          return acc;
        }, [])
      },
      
      // 📋 FATURAMENTO (guias enviadas)
      billing: {
        total: billing.total,
        count: billing.count,
        byProvider: billing.byProvider
      },
      
      // 💵 RECEBIMENTO (dinheiro no caixa)
      received: {
        total: received.total,
        count: received.count,
        byProvider: received.byProvider
      },
      
      // ⏱️ AGING (dias em aberto)
      aging: {
        description: 'Tempo médio de recebimento',
        buckets: agingBuckets,
        totalPending: Object.values(agingBuckets).reduce((sum, b) => sum + b.total, 0),
        countPending: Object.values(agingBuckets).reduce((sum, b) => sum + b.count, 0)
      },
      
      // 🎟️ TICKET MÉDIO
      ticket: {
        byProvider: ticketByProvider,
        overall: production.count > 0 ? (production.total / production.count).toFixed(2) : 0
      },
      
      // ⚠️ GAP (dinheiro perdido)
      gap: {
        description: 'Produção do mês ainda não faturada',
        totalUnbilled: gap.totalUnbilled,
        countUnbilled: gap.countUnbilled,
        percentage: parseFloat(gap.percentage),
        alert: gap.percentage > 20 ? 'ALTO: Mais de 20% da produção não faturada' : 'OK'
      }
    });
    
  } catch (error) {
    console.error('[InsuranceDashboardV2] Erro:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao calcular dashboard de convênios',
      message: error.message
    });
  }
}

export default {
  getInsuranceDashboard
};
