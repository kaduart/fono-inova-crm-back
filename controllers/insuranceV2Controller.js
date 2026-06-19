import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import { settleInsurancePayment, runAvulsoSettlement } from '../services/autoInsuranceSettlementService.js';
import { createBatch, sendBatch, processReturn } from '../services/insuranceBatchService.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import mongoose from 'mongoose';
import { isConvenioSession, buildInsuranceReceivableFilter } from '../utils/billingHelpers.js';
import insuranceBilling from '../services/billing/insuranceBilling.js';
import { buildBatchFromGuides, listGuidesPendingBilling } from '../services/insuranceBatchGuideAdapter.js';

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
    const { paymentIds, guideIds, dataFaturamento, notaFiscal } = req.body;
    const userId = req.user?._id;

    // 🆕 GUIDE-BASED: novo modelo correto (InsuranceGuide -> InsuranceBatch)
    if (guideIds && Array.isArray(guideIds) && guideIds.length > 0) {
      const adapterResult = await buildBatchFromGuides(guideIds);

      if (adapterResult.sessionIds.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Nenhuma sessão elegível encontrada nas guias selecionadas'
        });
      }

      const batch = await createBatch({
        insuranceProvider: adapterResult.provider,
        startDate: adapterResult.startDate,
        endDate: adapterResult.endDate,
        userId,
        sessionIds: adapterResult.sessionIds
      });

      await sendBatch(batch._id, userId);

      return res.json({
        success: true,
        message: `${adapterResult.sessionIds.length} atendimentos faturados a partir de ${adapterResult.guides.length} guia(s)`,
        data: {
          batchId: batch._id,
          batchNumber: batch.batchNumber,
          provider: adapterResult.provider,
          sessionsFaturadas: adapterResult.sessionIds.length,
          guidesFaturadas: adapterResult.guides.length,
          guides: adapterResult.guides,
          ignoredGuides: adapterResult.ignoredGuides,
          startDate: adapterResult.startDate,
          endDate: adapterResult.endDate
        }
      });
    }

    // LEGACY: fallback para paymentIds (sessão-cêntrico)
    if (!paymentIds || !Array.isArray(paymentIds) || paymentIds.length === 0) {
      return res.status(400).json({ success: false, error: 'guideIds ou paymentIds obrigatório' });
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

    const paidAt = dataRecebimento ? new Date(dataRecebimento) : new Date();
    const oids = paymentIds.map(id => new mongoose.Types.ObjectId(id));

    // 1. Identifica quais estão em algum batch
    const batches = await InsuranceBatch.find({ 'sessions.payment': { $in: oids } });
    const inBatchSet = new Set(
      batches.flatMap(b => b.sessions.map(s => s.payment?.toString()).filter(Boolean))
    );

    // 2. Separa batch path vs avulso path
    const inBatch  = paymentIds.filter(id => inBatchSet.has(id));
    const avulsos  = paymentIds.filter(id => !inBatchSet.has(id));

    // 3. Batch path: processReturn para cada batch afetado
    const returnItems = await Promise.all(inBatch.map(async (pid) => {
      const p = await Payment.findById(pid).select('session insurance amount').lean();
      return {
        paymentId: pid,
        sessionId: p?.session?.toString(),
        status: 'paid',
        returnAmount: p?.insurance?.grossAmount || p?.amount || 0
      };
    }));

    const processedBatches = [];
    for (const batch of batches) {
      const result = await processReturn(batch._id, {
        items: returnItems,
        protocolNumber: `REC-${Date.now()}`,
        force: false
      });
      processedBatches.push(result);
    }

    // 4. Avulso path: settle direto via settleInsurancePayment
    const avulsoResults = [];
    for (const pid of avulsos) {
      try {
        const result = await settleInsurancePayment(pid, {
          reason: 'manual_receive_avulso',
          paidAt
        });
        avulsoResults.push(result);
      } catch (err) {
        avulsoResults.push({ paymentId: pid, error: err.message });
      }
    }

    const totalSettled = inBatch.length + avulsoResults.filter(r => r.settled).length;
    const errors = avulsoResults.filter(r => r.error).length;

    res.json({
      success: true,
      message: `${totalSettled} pagamento(s) recebido(s)${errors ? `, ${errors} erro(s)` : ''}`,
      data: {
        recebidos: totalSettled,
        batches: processedBatches.length,
        avulsos: avulsoResults.filter(r => r.settled).length,
        errors
      }
    });
  } catch (error) {
    console.error('[InsuranceV2][receberLote] Erro:', error.message);
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

/**
 * GET /api/v2/insurance/guides/pending-billing
 * Lista guias com sessões completed pendentes de faturamento.
 */
export async function listPendingGuides(req, res) {
  try {
    const { insurance, patientId, month, page, limit } = req.query;

    const result = await listGuidesPendingBilling({
      insurance,
      patientId,
      month,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50
    });

    res.json({
      success: true,
      data: result.guides,
      orphanSessions: result.orphanSessions,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        pages: Math.ceil(result.total / result.limit)
      }
    });
  } catch (error) {
    console.error('[InsuranceV2][listPendingGuides] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

// GET /api/v2/insurance/history
// Histórico acumulado mês a mês: Packages (legado) + InsuranceBatches (novo)
export async function getInsuranceHistory(req, res) {
  try {
    const { provider, year } = req.query;
    const filterYear = year ? parseInt(year) : new Date().getFullYear();

    const startDate = new Date(`${filterYear}-01-01T00:00:00-03:00`);
    const endDate   = new Date(`${filterYear}-12-31T23:59:59-03:00`);

    // ── 1. BATCHES (novo motor) — carrega primeiro para saber quais
    //    appointments já estão cobertos (evita dupla contagem no legado)
    const batchBaseFilter = {};
    if (provider) batchBaseFilter.insuranceProvider = provider;
    const batches = await InsuranceBatch.find(batchBaseFilter).lean();

    // Appointment IDs presentes em algum batch
    const apptIdsInBatches = new Set(
      batches.flatMap(b => (b.sessions || []).map(s => String(s.appointment)).filter(Boolean))
    );

    // Carrega appointments dos batches para nome/especialidade/data
    const batchApptOids = [...apptIdsInBatches];
    const batchAppts = batchApptOids.length
      ? await Appointment.find({ _id: { $in: batchApptOids } })
          .select('patientInfo specialty date')
          .lean()
      : [];
    const bApptMap = {};
    for (const a of batchAppts) bApptMap[String(a._id)] = a;

    // ── 2. PACKAGES LEGADOS (type=convenio) ──────────────────────────
    // Sem filtro de data no package — usamos a data de cada appointment individual
    const pkgFilter = { type: 'convenio' };
    if (provider) pkgFilter.insuranceProvider = provider;
    const packages = await Package.find(pkgFilter)
      .populate('patient', 'fullName name phone')
      .lean();

    // Carrega todos os appointments dos packages (data + status + especialidade)
    const allPkgApptIds = packages.flatMap(p => p.appointments || []);
    const pkgAppts = allPkgApptIds.length
      ? await Appointment.find({
          _id: { $in: allPkgApptIds },
          operationalStatus: 'completed',
          date: { $gte: startDate, $lte: endDate }
        }).select('_id date specialty operationalStatus').lean()
      : [];
    const pkgApptMap = {};
    for (const a of pkgAppts) pkgApptMap[String(a._id)] = a;

    // ── 3. AGRUPA por mês → provider → paciente → especialidade ──────
    const byMonth = {};

    function addEntry(monthKey, prov, patientName, phone, specialty, value, source, batchStatus) {
      if (!byMonth[monthKey]) byMonth[monthKey] = {};
      if (!byMonth[monthKey][prov]) byMonth[monthKey][prov] = {};
      if (!byMonth[monthKey][prov][patientName]) byMonth[monthKey][prov][patientName] = { phone, specialties: {} };
      if (!byMonth[monthKey][prov][patientName].specialties[specialty])
        byMonth[monthKey][prov][patientName].specialties[specialty] = { sessions: 0, value: 0, source, batchStatus };
      byMonth[monthKey][prov][patientName].specialties[specialty].sessions += 1;
      byMonth[monthKey][prov][patientName].specialties[specialty].value   += value;
      // Prioriza status mais avançado
      const rank = { received: 3, billed: 2, pending_batch: 1 };
      const cur = byMonth[monthKey][prov][patientName].specialties[specialty].batchStatus;
      if ((rank[batchStatus] || 0) > (rank[cur] || 0))
        byMonth[monthKey][prov][patientName].specialties[specialty].batchStatus = batchStatus;
    }

    // Packages legados: 1 entrada por appointment completed no período
    for (const pkg of packages) {
      const prov     = pkg.insuranceProvider || 'outros';
      const patName  = pkg.patient?.fullName || pkg.patient?.name || 'Desconhecido';
      const phone    = pkg.patient?.phone || '';
      const specialty = pkg.specialty || 'outros';
      const value    = pkg.sessionValue || 80;
      const status   = pkg.insuranceBillingStatus || 'pending_batch';

      for (const apptId of (pkg.appointments || [])) {
        if (apptIdsInBatches.has(String(apptId))) continue; // já contado no batch
        const appt = pkgApptMap[String(apptId)];
        if (!appt) continue; // fora do período ou não completed
        const d  = new Date(appt.date);
        const mk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        addEntry(mk, prov, patName, phone, specialty, value, 'legado', status);
      }
    }

    // Batches: 1 entrada por sessão, só do ano filtrado
    for (const batch of batches) {
      const prov = batch.insuranceProvider || 'outros';
      const batchStatus = batch.status === 'received' ? 'received'
        : (batch.status === 'sent' || batch.status === 'processing') ? 'billed'
        : 'pending_batch';
      for (const s of batch.sessions || []) {
        const appt = bApptMap[String(s.appointment)];
        const sessionDate = s.sessionDate || appt?.date;
        if (!sessionDate) continue;
        const d = new Date(sessionDate);
        if (d.getFullYear() !== filterYear) continue;
        const mk       = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        const patName  = appt?.patientInfo?.fullName || appt?.patientInfo?.name || 'Desconhecido';
        const phone    = appt?.patientInfo?.phone || '';
        const specialty = appt?.specialty || 'outros';
        addEntry(mk, prov, patName, phone, specialty, s.grossAmount || 0, 'lote', batchStatus);
      }
    }

    // ── 4. Serializa ─────────────────────────────────────────────────
    const result = Object.keys(byMonth).sort().map(mk => {
      const [y, m] = mk.split('-');
      const monthLabel = new Date(Number(y), Number(m)-1, 1)
        .toLocaleString('pt-BR', { month: 'long', year: 'numeric' });

      const providers = Object.keys(byMonth[mk]).map(prov => {
        const provData = byMonth[mk][prov];
        const patients = Object.keys(provData).map(patName => {
          const pd = provData[patName];
          const specialties = Object.keys(pd.specialties).map(sp => ({
            specialty: sp,
            sessions: pd.specialties[sp].sessions,
            value: pd.specialties[sp].value,
            source: pd.specialties[sp].source,
            batchStatus: pd.specialties[sp].batchStatus,
          }));
          const totSess  = specialties.reduce((s, x) => s + x.sessions, 0);
          const totValue = specialties.reduce((s, x) => s + x.value, 0);
          return { name: patName, phone: pd.phone, specialties, totalSessions: totSess, totalValue: totValue };
        }).sort((a, b) => a.name.localeCompare(b.name));

        const totalSessions = patients.reduce((s, p) => s + p.totalSessions, 0);
        const totalValue    = patients.reduce((s, p) => s + p.totalValue, 0);

        // Status geral do provider no mês
        const allStatuses = patients.flatMap(p => p.specialties.map(s => s.batchStatus));
        const providerStatus = allStatuses.every(s => s === 'received') ? 'received'
          : allStatuses.some(s => s === 'billed') ? 'billed' : 'pending_batch';

        const provLabel = prov.split('-').map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(' ')
          .replace('Anapolis', 'Anápolis').replace('Goiania', 'Goiânia').replace('Saude', 'Saúde');

        return { provider: prov, providerLabel: provLabel, patients, totalSessions, totalValue, status: providerStatus };
      });

      const monthTotal = providers.reduce((s, p) => s + p.totalValue, 0);
      const monthSessions = providers.reduce((s, p) => s + p.totalSessions, 0);

      return { monthKey: mk, monthLabel, providers, totalSessions: monthSessions, totalValue: monthTotal };
    });

    res.json({ success: true, data: result, year: filterYear });
  } catch (error) {
    console.error('[InsuranceV2][getInsuranceHistory] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

export default {
  getInsuranceReceivables,
  faturarLote,
  receberLote,
  billSession,
  receiveSession,
  listPendingGuides,
  getInsuranceHistory
};
