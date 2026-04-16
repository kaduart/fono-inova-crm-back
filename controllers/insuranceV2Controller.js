import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import { createBatch, sendBatch, processReturn } from '../services/insuranceBatchService.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import mongoose from 'mongoose';
import { isConvenioSession } from '../utils/billingHelpers.js';
import insuranceBilling from '../services/billing/insuranceBilling.js';

// GET /api/v2/payments/insurance/receivables
export async function getInsuranceReceivables(req, res) {
  try {
    const { provider, status, month } = req.query;
    
    // 🆕 CORREÇÃO: Segue mesma regra do legado (ConvenioMetricsService)
    // Busca SESSÕES completadas no período, não payments por paymentDate
    
    let sessions = [];
    
    if (month) {
      const startOfMonth = new Date(month + '-01T00:00:00-03:00');
      const endOfMonth = new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0, 23, 59, 59, 999);

      // Busca TODAS as sessões completadas do mês e filtra por isConvenioSession
      // Isso garante consistência com outros endpoints financeiros.
      const allSessions = await Session.find({
        status: 'completed',
        date: { $gte: startOfMonth, $lte: endOfMonth }
      })
      .populate('patient', 'fullName phone')
      .populate('package', 'insuranceProvider insuranceCompany insuranceGrossAmount insuranceGuideNumber type')
      .populate('doctor', 'fullName specialty')
      .sort({ date: -1 })
      .lean();

      sessions = allSessions.filter(isConvenioSession);
    } else {
      // Sem mês, busca todos os payments pendentes (comportamento antigo)
      const matchFilter = { billingType: 'convenio' };
      if (status) {
        matchFilter['insurance.status'] = status;
      } else {
        matchFilter['insurance.status'] = { $in: ['pending_billing', 'billed'] };
      }
      
      const payments = await Payment.find(matchFilter)
        .populate('patient', 'fullName phone')
        .populate('session', 'date time specialty status')
        .populate('package', 'insuranceProvider insuranceGuide')
        .lean();
      
      // Converte payments para formato de sessão
      return _processPaymentsLegacy(res, payments, provider);
    }
    
    // Filtra por provider se especificado
    if (provider) {
      sessions = sessions.filter(s => 
        s.package?.insuranceProvider === provider || 
        s.package?.insuranceCompany === provider
      );
    }
    
    // Para cada sessão, busca o payment associado
    const sessionIds = sessions.map(s => s._id.toString());
    const payments = await Payment.find({
      session: { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) },
      billingType: 'convenio'
    }).lean();
    
    // Cria map de session -> payment
    const paymentBySession = {};
    payments.forEach(p => {
      if (p.session) {
        paymentBySession[p.session.toString()] = p;
      }
    });
    
    // Agrupar por CONVÊNIO (formato que InsuranceTab.tsx espera)
    const grouped = {};
    
    for (const session of sessions) {
      const payment = paymentBySession[session._id.toString()];
      
      // 🆕 CORREÇÃO: Se não tem payment, considera como 'pending_billing'
      const paymentStatus = payment?.insurance?.status || 'pending_billing';
      
      // Se especificou status, filtra
      if (status && paymentStatus !== status) continue;
      // Se não especificou, mostra pending_billing e billed
      if (!status && !['pending_billing', 'billed'].includes(paymentStatus)) continue;
      
      const providerName = session.package?.insuranceProvider || 
                           session.package?.insuranceCompany || 
                           payment?.insurance?.provider || 
                           'Outros';
      
      const patientId = session.patient?._id?.toString();
      if (!patientId) continue;
      
      if (!grouped[providerName]) {
        grouped[providerName] = {
          _id: providerName,
          name: providerName,
          totalPending: 0,
          count: 0,
          patients: []
        };
      }
      
      // Encontrar ou criar o paciente neste grupo
      let patientGroup = grouped[providerName].patients.find(p => p.patientId === patientId);
      if (!patientGroup) {
        patientGroup = {
          patientId: patientId,
          patientName: session.patient?.fullName || 'N/A',
          total: 0,
          count: 0,
          payments: []
        };
        grouped[providerName].patients.push(patientGroup);
      }
      
      const grossAmount = session.package?.insuranceGrossAmount || 
                         payment?.insurance?.grossAmount || 
                         payment?.amount || 80;
      
      // Atualizar totais
      grouped[providerName].totalPending += grossAmount;
      grouped[providerName].count += 1;
      patientGroup.total += grossAmount;
      patientGroup.count += 1;
      
      // Adicionar payment
      patientGroup.payments.push({
        paymentId: payment?._id?.toString() || session._id.toString(),
        grossAmount: grossAmount,
        status: payment?.insurance?.status || 'pending_billing',
        paymentDate: session.date,
        authorizationCode: payment?.insurance?.authorizationCode || session.package?.insuranceAuthorizationCode,
        specialty: session.doctor?.specialty || 'Outros'
      });
    }
    
    const result = Object.values(grouped);
    
    const summary = {
      totalProviders: result.length,
      grandTotal: result.reduce((sum, g) => sum + g.totalPending, 0),
      pendingCount: result.reduce((sum, g) => 
        sum + g.patients.reduce((pSum, p) => 
          pSum + p.payments.filter(pay => pay.status === 'pending_billing').length, 0
        ), 0
      )
    };
    
    res.json({ success: true, data: result, summary });
  } catch (error) {
    console.error('[InsuranceV2] Erro:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// Função auxiliar para comportamento legacy (sem month)
async function _processPaymentsLegacy(res, payments, provider) {
  // Filtra por provider se especificado
  let filteredPayments = payments;
  if (provider) {
    filteredPayments = payments.filter(p => 
      p.insurance?.provider === provider || 
      p.package?.insuranceProvider === provider
    );
  }
  
  // Agrupar por CONVÊNIO
  const grouped = {};
  
  for (const payment of filteredPayments) {
    const providerName = payment.insurance?.provider || payment.package?.insuranceProvider || 'Outros';
    const patientId = payment.patient?._id?.toString();
    if (!patientId) continue;
    
    if (!grouped[providerName]) {
      grouped[providerName] = {
        _id: providerName,
        name: providerName,
        totalPending: 0,
        count: 0,
        patients: []
      };
    }
    
    let patientGroup = grouped[providerName].patients.find(p => p.patientId === patientId);
    if (!patientGroup) {
      patientGroup = {
        patientId: patientId,
        patientName: payment.patient?.fullName || 'N/A',
        total: 0,
        count: 0,
        payments: []
      };
      grouped[providerName].patients.push(patientGroup);
    }
    
    const grossAmount = payment.insurance?.grossAmount || payment.amount || 0;
    
    grouped[providerName].totalPending += grossAmount;
    grouped[providerName].count += 1;
    patientGroup.total += grossAmount;
    patientGroup.count += 1;
    
    patientGroup.payments.push({
      paymentId: payment._id.toString(),
      grossAmount: grossAmount,
      status: payment.insurance?.status || 'pending_billing',
      paymentDate: payment.paymentDate,
      authorizationCode: payment.insurance?.authorizationCode,
      specialty: payment.session?.specialty || 'Outros'
    });
  }
  
  const result = Object.values(grouped);
  
  const summary = {
    totalProviders: result.length,
    grandTotal: result.reduce((sum, g) => sum + g.totalPending, 0),
    pendingCount: filteredPayments.filter(p => p.insurance?.status === 'pending_billing').length
  };
  
  res.json({ success: true, data: result, summary });
}

// POST /api/v2/financial/convenio/faturar-lote
export async function faturarLote(req, res) {
  try {
    const { paymentIds, dataFaturamento, notaFiscal } = req.body;
    const userId = req.user?._id;
    
    if (!paymentIds || !Array.isArray(paymentIds) || paymentIds.length === 0) {
      return res.status(400).json({ success: false, error: 'paymentIds obrigatório' });
    }
    
    // Buscar payments para determinar provider e período
    const payments = await Payment.find({
      _id: { $in: paymentIds },
      billingType: 'convenio'
    }).populate('session');
    
    if (payments.length === 0) {
      return res.status(404).json({ success: false, error: 'Nenhum payment encontrado' });
    }
    
    const provider = payments[0].insurance?.provider || 'convenio';
    const dates = payments.map(p => p.session?.date).filter(Boolean).sort();
    const startDate = dates[0];
    const endDate = dates[dates.length - 1];
    
    // 1. Criar batch V2
    const batch = await createBatch({
      insuranceProvider: provider,
      startDate,
      endDate,
      userId
    });
    
    // 2. Enviar batch V2
    await sendBatch(batch._id, userId);
    
    res.json({
      success: true,
      message: `${payments.length} atendimentos faturados`,
      data: { batchId: batch._id, faturados: payments.length }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// POST /api/v2/financial/convenio/receber-lote
export async function receberLote(req, res) {
  try {
    const { paymentIds, dataRecebimento } = req.body;
    
    if (!paymentIds || !Array.isArray(paymentIds) || paymentIds.length === 0 || !dataRecebimento) {
      return res.status(400).json({ success: false, error: 'paymentIds e dataRecebimento obrigatórios' });
    }
    
    // Buscar batch que contém esses payments
    const batches = await InsuranceBatch.find({
      'sessions.payment': { $in: paymentIds.map(id => new mongoose.Types.ObjectId(id)) }
    });
    
    // Montar returnData
    const returnItems = await Promise.all(paymentIds.map(async (pid) => {
      const payment = await Payment.findById(pid);
      return {
        paymentId: pid,
        sessionId: payment?.session?.toString(),
        status: 'paid',
        returnAmount: payment?.insurance?.grossAmount || payment?.amount || 0
      };
    }));
    
    // Processar retorno em cada batch afetado
    const processedBatches = [];
    for (const batch of batches) {
      const result = await processReturn(batch._id, {
        items: returnItems,
        protocolNumber: `REC-${Date.now()}`,
        force: false
      });
      processedBatches.push(result);
    }
    
    res.json({
      success: true,
      message: `${paymentIds.length} pagamentos recebidos`,
      data: { recebidos: paymentIds.length, batches: processedBatches.length }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * PATCH /api/v2/insurance/session/:sessionId/bill
 * Marca sessão de convênio como faturada
 */
export async function billSession(req, res) {
  try {
    const { sessionId } = req.params;
    const { billedAmount, billedAt, notes } = req.body;

    if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ success: false, error: 'sessionId inválido' });
    }

    const result = await insuranceBilling.markSessionAsBilled(
      sessionId,
      billedAmount,
      billedAt,
      notes
    );

    res.json(result);
  } catch (error) {
    console.error('[InsuranceV2][billSession] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * PATCH /api/v2/insurance/session/:sessionId/receive
 * Marca sessão de convênio como recebida
 */
export async function receiveSession(req, res) {
  try {
    const { sessionId } = req.params;
    const { receivedAmount, receivedDate } = req.body;

    if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ success: false, error: 'sessionId inválido' });
    }

    if (receivedAmount === undefined || receivedAmount === null || Number(receivedAmount) < 0) {
      return res.status(400).json({ success: false, error: 'receivedAmount obrigatório' });
    }

    const result = await insuranceBilling.markSessionAsReceived(
      sessionId,
      Number(receivedAmount),
      receivedDate
    );

    res.json(result);
  } catch (error) {
    console.error('[InsuranceV2][receiveSession] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

export default {
  getInsuranceReceivables,
  faturarLote,
  receberLote,
  billSession,
  receiveSession
};
