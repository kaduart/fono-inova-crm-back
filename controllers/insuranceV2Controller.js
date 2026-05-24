import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import { createBatch, sendBatch, processReturn } from '../services/insuranceBatchService.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import mongoose from 'mongoose';
import { isConvenioSession, buildInsuranceReceivableFilter } from '../utils/billingHelpers.js';
import insuranceBilling from '../services/billing/insuranceBilling.js';

// GET /api/v2/payments/insurance/receivables
export async function getInsuranceReceivables(req, res) {
  try {
    const { provider, status, month } = req.query;
    
    // 🆕 CORREÇÃO: Segue mesma regra do legado (ConvenioMetricsService)
    // Busca SESSÕES completadas no período, não payments por paymentDate
    
    // Fonte de verdade: Payment com billingType='convenio'
    // Session é usada apenas para filtrar pelo date range do mês

    const requestedStatuses = status
      ? status.split(',').map(s => s.trim()).filter(Boolean)
      : null;

    let sessionIds = null;
    let prevMonthTotal = null;

    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ success: false, error: 'Formato de mês inválido. Use YYYY-MM.' });
      }
      const startOfMonth = new Date(month + '-01T00:00:00-03:00');
      const endOfMonth = new Date(startOfMonth.getFullYear(), startOfMonth.getMonth() + 1, 0, 23, 59, 59, 999);
      if (isNaN(startOfMonth.getTime()) || isNaN(endOfMonth.getTime())) {
        return res.status(400).json({ success: false, error: 'Mês inválido.' });
      }

      const [curY, curM] = month.split('-').map(Number);
      const prevY = curM === 1 ? curY - 1 : curY;
      const prevM = curM === 1 ? 12 : curM - 1;
      const prevStart = new Date(`${prevY}-${String(prevM).padStart(2, '0')}-01T00:00:00-03:00`);
      const prevEnd = new Date(prevY, prevM, 0, 23, 59, 59, 999); // last day of prevMonth

      const [sessionsInMonth, prevSessionsInMonth] = await Promise.all([
        Session.find({ date: { $gte: startOfMonth, $lte: endOfMonth } }).select('_id').lean(),
        Session.find({ date: { $gte: prevStart, $lte: prevEnd } }).select('_id').lean()
      ]);

      sessionIds = sessionsInMonth.map(s => s._id);

      const prevFilter = buildInsuranceReceivableFilter(prevSessionsInMonth.map(s => s._id), null);
      const prevAgg = await Payment.aggregate([
        { $match: prevFilter },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount'] } } } }
      ]);
      prevMonthTotal = prevAgg[0]?.total || 0;
    }

    const matchFilter = buildInsuranceReceivableFilter(sessionIds, requestedStatuses);

    const payments = await Payment.find(matchFilter)
      .populate('patient', 'fullName phone')
      .populate('session', 'date time specialty status')
      .populate('package', 'insuranceProvider insuranceGuide')
      .lean();

    return _processPaymentsLegacy(res, payments, provider, prevMonthTotal);
  } catch (error) {
    console.error('[InsuranceV2] Erro:', error);
    res.status(500).json({ success: false, error: error.message, stack: error.stack });
  }
}

// Função auxiliar para comportamento legacy (sem month)
async function _processPaymentsLegacy(res, payments, provider, prevMonthTotal = null) {
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
      sessionId: payment.session?._id?.toString() || payment.session?.toString(),
      grossAmount: grossAmount,
      status: payment.insurance?.status || 'pending_billing',
      paymentDate: payment.paymentDate,
      authorizationCode: payment.insurance?.authorizationCode,
      specialty: payment.session?.specialty || 'Outros'
    });
  }
  
  const result = Object.values(grouped);
  
  const grandTotal = result.reduce((sum, g) => sum + g.totalPending, 0);
  const summary = {
    totalProviders: result.length,
    grandTotal,
    pendingCount: filteredPayments.filter(p => ['pending_billing', 'billed'].includes(p.insurance?.status)).length,
    prevMonthTotal,
    change: prevMonthTotal !== null ? grandTotal - prevMonthTotal : null,
    changePercent: prevMonthTotal ? Math.round(((grandTotal - prevMonthTotal) / prevMonthTotal) * 100) : null
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
    
    // Buscar payments reais (paymentIds que são de Payment documents)
    const payments = await Payment.find({
      _id: { $in: paymentIds },
      billingType: 'convenio'
    }).populate('session');

    // IDs não encontrados como Payment podem ser sessionIds (fallback do getInsuranceReceivables)
    const foundPaymentIds = new Set(payments.map(p => p._id.toString()));
    const unmatchedIds = paymentIds.filter(id => !foundPaymentIds.has(id));

    // Resolve IDs órfãos como sessions diretas
    const orphanSessions = unmatchedIds.length > 0
      ? await Session.find({ _id: { $in: unmatchedIds }, status: 'completed' }).lean()
      : [];

    if (payments.length === 0 && orphanSessions.length === 0) {
      return res.status(404).json({ success: false, error: 'Nenhum payment ou sessão encontrada' });
    }

    const provider = payments[0]?.insurance?.provider || orphanSessions[0]?.insuranceProvider || 'convenio';

    // Junta sessionIds: via payment + via session direta
    const sessionIdsFromPayments = payments
      .filter(p => p.session?._id)
      .map(p => p.session._id.toString());

    const sessionIdsFromOrphans = orphanSessions.map(s => s._id.toString());
    const sessionIds = [...new Set([...sessionIdsFromPayments, ...sessionIdsFromOrphans])];

    const paymentsSemSession = payments.filter(p => !p.session?._id);

    const allDates = [
      ...payments.map(p => p.session?.date),
      ...orphanSessions.map(s => s.date)
    ].filter(Boolean).sort();
    const startDate = allDates[0];
    const endDate = allDates[allDates.length - 1];

    if (sessionIds.length === 0) {
      return res.status(422).json({ success: false, error: 'Nenhum payment possui sessão vinculada para faturar' });
    }

    // 1. Criar batch V2 com sessions específicas
    const batch = await createBatch({
      insuranceProvider: provider,
      startDate,
      endDate,
      userId,
      sessionIds
    });

    // 2. Enviar batch V2
    await sendBatch(batch._id, userId);

    const ignorados = paymentsSemSession.length;
    res.json({
      success: true,
      message: `${sessionIds.length} atendimentos faturados${ignorados > 0 ? ` (${ignorados} sem sessão vinculada ignorados)` : ''}`,
      data: {
        batchId: batch._id,
        faturados: sessionIds.length,
        ignorados,
        ignoradosIds: paymentsSemSession.map(p => p._id.toString())
      }
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
