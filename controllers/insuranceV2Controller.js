import Payment from '../models/Payment.js';
import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import { settleInsurancePayment, runAvulsoSettlement } from '../services/autoInsuranceSettlementService.js';
import { createBatch, sendBatch, processReturn } from '../services/insuranceBatchService.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import mongoose from 'mongoose';
import { isConvenioSession, buildInsuranceReceivableFilter, buildInsuranceBilledFilter, buildInsuranceReceivedFilter } from '../utils/billingHelpers.js';
import InsuranceResolverService from '../services/insuranceResolver.service.js';
import insuranceBilling from '../services/billing/insuranceBilling.js';
import { buildBatchFromGuides, listGuidesPendingBilling } from '../services/insuranceBatchGuideAdapter.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import { closeGuideBillingPeriod } from '../services/insuranceGuide/closeGuideBillingPeriod.js';

// Constantes do modelo de faturamento — mantidas num único lugar para evitar
// strings espalhadas e facilitar manutenção.
const BILLING_MODEL = {
  LEGACY_MONTHLY_BATCH: 'LEGACY_MONTHLY_BATCH',
  CURRENT_GUIDE_BATCH: 'CURRENT_GUIDE_BATCH'
};

/**
 * Resolve o modelo de faturamento aplicável a um conjunto de sessões.
 *
 * Regra de negócio (2026-08-06):
 * - O modelo legado mensal (guia reutilizada, faturada todo mês) é específico
 *   do histórico antigo da Unimed Anápolis.
 * - O corte operacional aproximado é Fevereiro/2026: até esse período a clínica
 *   usava o modelo mensal; a partir de Março/2026 passou a acumular sessões
 *   na guia e enviar só no fim.
 * - Outros convênios sempre usam o modelo atual (guia → lote único).
 *
 * Centralizar essa regra aqui evita ifs espalhados e permite ajustar o corte
 * ou adicionar novos convênios legados num único ponto.
 */
function resolveBillingModel(insuranceProvider, sessions) {
  const provider = String(insuranceProvider || '').toLowerCase().trim();
  if (provider !== 'unimed-anapolis') return BILLING_MODEL.CURRENT_GUIDE_BATCH;

  const cutoff = new Date('2026-03-01T00:00:00-03:00');
  const hasLegacy = sessions.some(s => {
    const raw = s.billedAt || s.sentDate || s.date;
    if (!raw) return false;
    const d = new Date(raw);
    return !isNaN(d.getTime()) && d < cutoff;
  });

  return hasLegacy ? BILLING_MODEL.LEGACY_MONTHLY_BATCH : BILLING_MODEL.CURRENT_GUIDE_BATCH;
}

/**
 * Variação que decide o modelo baseado apenas no provider+mês, sem precisar
 * das sessões. Usada na query do drawer para saber se deve trazer sessões de
 * outros meses das guias selecionadas.
 */
function resolveBillingModelForMonth(insuranceProvider, monthKey) {
  const provider = String(insuranceProvider || '').toLowerCase().trim();
  const [y, m] = String(monthKey).split('-').map(Number);
  if (!y || !m) return BILLING_MODEL.CURRENT_GUIDE_BATCH;

  // Se o provider não foi informado (ex: chamadas internas/testes), infere pelo
  // período: o modelo legado mensal só existiu antes de Março/2026. Períodos a
  // partir de Março/2026 sempre usam o modelo atual (guia → lote único).
  if (!provider) {
    if (y > 2026 || (y === 2026 && m >= 3)) return BILLING_MODEL.CURRENT_GUIDE_BATCH;
    return BILLING_MODEL.LEGACY_MONTHLY_BATCH;
  }

  // Unimed Anápolis: corte operacional em Março/2026.
  if (provider !== 'unimed-anapolis') return BILLING_MODEL.CURRENT_GUIDE_BATCH;
  if (y > 2026 || (y === 2026 && m >= 3)) return BILLING_MODEL.CURRENT_GUIDE_BATCH;
  return BILLING_MODEL.LEGACY_MONTHLY_BATCH;
}

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

    // Eventos financeiros de convênio devem ser filtrados pela data do evento,
    // não pela data da sessão clínica:
    // - Recebidos: insurance.receivedAt
    // - Faturados: insurance.billedAt
    // - A faturar: Session.date (ainda não houve evento financeiro)
    const isReceivedOnly = requestedStatuses?.length === 1 && requestedStatuses[0] === 'received';
    const isBilledOnly = requestedStatuses?.length === 1 && requestedStatuses[0] === 'billed';

    let sessionIds = null;
    let prevMonthTotal = null;
    let matchFilter;

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

      if (isReceivedOnly) {
        matchFilter = buildInsuranceReceivedFilter({ $gte: startOfMonth, $lte: endOfMonth });

        const prevAgg = await Payment.aggregate([
          { $match: buildInsuranceReceivedFilter({ $gte: prevStart, $lte: prevEnd }) },
          { $group: { _id: null, total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount'] } } } }
        ]);
        prevMonthTotal = prevAgg[0]?.total || 0;
      } else if (isBilledOnly) {
        matchFilter = buildInsuranceBilledFilter({ $gte: startOfMonth, $lte: endOfMonth });

        const prevAgg = await Payment.aggregate([
          { $match: buildInsuranceBilledFilter({ $gte: prevStart, $lte: prevEnd }) },
          { $group: { _id: null, total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount'] } } } }
        ]);
        prevMonthTotal = prevAgg[0]?.total || 0;
      } else {
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

        matchFilter = buildInsuranceReceivableFilter(sessionIds, requestedStatuses);
      }
    } else {
      if (isReceivedOnly) {
        matchFilter = buildInsuranceReceivedFilter(null);
      } else if (isBilledOnly) {
        matchFilter = buildInsuranceBilledFilter(null);
      } else {
        matchFilter = buildInsuranceReceivableFilter(sessionIds, requestedStatuses);
      }
    }

    const payments = await Payment.find(matchFilter)
      .populate('patient', 'fullName phone')
      .populate('session', 'date time specialty status insuranceProvider insuranceGuide patient')
      .populate({
        path: 'session',
        populate: [
          { path: 'patient', select: 'fullName phone' },
          { path: 'insuranceGuide', select: '_id number insurance specialty billingMode status closedAt' }
        ]
      })
      .populate('appointment', 'patient insuranceProvider insuranceGuide date specialty')
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
    const targetProvider = String(provider).toLowerCase();
    filteredPayments = payments.filter(p => {
      const resolved = InsuranceResolverService.resolveInsuranceProvider({
        payment: p,
        session: p.session,
        appointment: p.appointment,
        package: p.package
      });
      return resolved === targetProvider;
    });
  }
  
  // Agrupar por CONVÊNIO
  const grouped = {};
  
  for (const payment of filteredPayments) {
    const providerName = InsuranceResolverService.resolveInsuranceProvider({
      payment,
      session: payment.session,
      appointment: payment.appointment,
      package: payment.package
    });

    const patient = InsuranceResolverService.resolvePatient({
      payment,
      session: payment.session,
      appointment: payment.appointment
    });

    const patientId = patient?._id?.toString();
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
        patientName: patient?.fullName || 'N/A',
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
    
    const guide = payment.session?.insuranceGuide || null;

    patientGroup.payments.push({
      paymentId: payment._id.toString(),
      sessionId: payment.session?._id?.toString() || payment.session?.toString(),
      grossAmount: grossAmount,
      status: payment.insurance?.status || 'pending_billing',
      paymentDate: payment.paymentDate,
      paidAt: payment.paidAt || payment.insurance?.receivedAt || null,
      billedAt: payment.insurance?.billedAt || null,
      authorizationCode: payment.insurance?.authorizationCode,
      specialty: payment.session?.specialty || payment.session?.sessionType || 'Outros',
      guideId: guide?._id?.toString() || null,
      guideNumber: guide?.number || payment.insurance?.guideNumber || null,
      billingMode: guide?.billingMode || 'per_month',
      guideStatus: guide?.status || null,
      guideClosedAt: guide?.closedAt || null
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

      if (!adapterResult.invoiceNumber && !notaFiscal) {
        return res.status(400).json({
          success: false,
          error: 'Informe o número da Nota Fiscal para criar o lote. A NF pode ser informada no envio dos documentos ou no momento do faturamento.'
        });
      }

      const batch = await createBatch({
        insuranceProvider: adapterResult.provider,
        startDate: adapterResult.startDate,
        endDate: adapterResult.endDate,
        userId,
        sessionIds: adapterResult.sessionIds,
        invoiceNumber: adapterResult.invoiceNumber || notaFiscal || null,
        invoiceDate: adapterResult.invoiceDate
      });

      await sendBatch(batch._id, userId);

      // 🚫 DESATIVADO 2026-07-23 — fechamento automático NÃO roda mais em todo
      // faturamento. Auditoria real (scripts/audits/audit-guide-partial-billing-pattern.js
      // + audit-guide-would-have-cancelled.js) confirmou que guias per_month são
      // faturadas em múltiplos lotes ao longo de semanas/meses no fluxo real da
      // clínica (6 guias, 17 sessões faturadas em lote posterior ao primeiro).
      // Fechar automaticamente no primeiro lote teria cancelado appointments que
      // ainda seriam completados e faturados depois, legitimamente, na mesma guia.
      // closeGuideBillingPeriod continua existindo e testado — falta decidir um
      // gatilho seguro (manual, ou "só fecha se não sobrar pendência futura") antes
      // de reativar. Ver back/services/insuranceGuide/closeGuideBillingPeriod.js.
      const guideClosures = [];
      const totalAppointmentsCanceledOnClosure = 0;

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
          endDate: adapterResult.endDate,
          guideClosures,
          totalAppointmentsCanceledOnClosure
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
      sessionIds,
      invoiceNumber: notaFiscal || null,
      invoiceDate: null
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
 * POST /api/v2/financial/convenio/encerrar-guia
 * Fechamento MANUAL do período de faturamento de uma guia per_month.
 * Cancela appointments pendentes vinculados à guia (motivo guide_cycle_closed,
 * origem guide_closure). Só deve ser chamado explicitamente pelo operador,
 * nunca automaticamente após faturar lote — auditoria real provou que guias
 * per_month são faturadas em múltiplos lotes ao longo de semanas/meses.
 */
export async function encerrarGuia(req, res) {
  try {
    const { guideId } = req.body;
    const userId = req.user?.id;

    if (!guideId || !mongoose.Types.ObjectId.isValid(guideId)) {
      return res.status(400).json({ success: false, error: 'guideId inválido' });
    }

    const result = await closeGuideBillingPeriod(guideId, { userId });

    if (result.skipped) {
      return res.status(422).json({
        success: false,
        error: result.reason === 'not_per_month'
          ? 'Fechamento manual só é permitido para guias mensais (per_month)'
          : 'Guia não encontrada'
      });
    }

    res.json({
      success: true,
      message: result.canceled > 0
        ? `${result.canceled} agendamento(s) pendente(s) cancelado(s) — período da guia encerrado`
        : 'Nenhum agendamento pendente para cancelar — período da guia já está limpo',
      data: result
    });
  } catch (error) {
    console.error('[InsuranceV2][encerrarGuia] Erro:', error.message);
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
    const { insurance, patientId, month, page, limit, includeOverdue } = req.query;

    const result = await listGuidesPendingBilling({
      insurance,
      patientId,
      month,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50,
      includeOverdue: includeOverdue === 'true'
    });

    res.json({
      success: true,
      data: result.guides,
      orphanSessions: result.orphanSessions,
      overdue: result.overdue,
      overdueSummary: result.overdueSummary,
      competenceBreakdown: result.competenceBreakdown,
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

/**
 * POST /api/v2/insurance/guides/auto-link-orphans
 * Tenta vincular sessões órfãs a guias ativas do mesmo paciente/especialidade.
 */
export async function autoLinkOrphanSessions(req, res) {
  const mongoSession = await mongoose.startSession();
  mongoSession.startTransaction();
  try {
    const { month } = req.body;
    let periodStart, periodEnd;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      periodStart = new Date(y, m - 1, 1);
      periodEnd = new Date(y, m, 0, 23, 59, 59, 999);
    }

    const orphanMatch = {
      status: 'completed',
      $or: [{ paymentMethod: 'convenio' }, { billingType: 'convenio' }],
      $and: [
        { $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }] },
        { $or: [{ insuranceGuide: { $exists: false } }, { insuranceGuide: null }] }
      ]
    };
    if (periodStart && periodEnd) orphanMatch.date = { $gte: periodStart, $lte: periodEnd };

    const orphanSessions = await Session.find(orphanMatch)
      .populate('appointmentId', 'specialty insuranceProvider')
      .session(mongoSession)
      .lean();

    const linked = [];
    const skipped = [];

    for (const session of orphanSessions) {
      const patientId = session.patient;
      if (!patientId) {
        skipped.push({ sessionId: session._id.toString(), reason: 'Paciente não encontrado' });
        continue;
      }

      const specialty = (session.sessionType || session.appointmentId?.specialty || '').toLowerCase().trim();
      if (!specialty) {
        skipped.push({ sessionId: session._id.toString(), reason: 'Especialidade não encontrada' });
        continue;
      }

      const guide = await InsuranceGuide.findValid(
        patientId.toString(),
        specialty,
        session.date ? new Date(session.date) : new Date()
      );

      if (!guide) {
        skipped.push({ sessionId: session._id.toString(), reason: 'Nenhuma guia ativa compatível' });
        continue;
      }

      // Consome sessão na guia
      guide.usedSessions += 1;
      if (guide.usedSessions >= guide.totalSessions) guide.status = 'exhausted';
      guide.consumptionHistory.push({
        sessionId: session._id,
        sessionNumber: guide.usedSessions,
        consumedAt: new Date(),
        notes: 'Auto-link de sessão órfã'
      });
      await guide.save({ session: mongoSession });

      // Atualiza sessão
      await Session.findByIdAndUpdate(
        session._id,
        { $set: { insuranceGuide: guide._id, guideConsumed: true } },
        { session: mongoSession }
      );

      // Atualiza payment se existir
      await Payment.updateMany(
        { session: session._id, billingType: 'convenio' },
        { $set: { 'insurance.guideId': guide._id, insuranceGuide: guide._id } },
        { session: mongoSession }
      );

      linked.push({ sessionId: session._id.toString(), guideId: guide._id.toString(), guideNumber: guide.number });
    }

    await mongoSession.commitTransaction();

    res.json({
      success: true,
      linked,
      skipped,
      linkedCount: linked.length,
      skippedCount: skipped.length
    });
  } catch (error) {
    await mongoSession.abortTransaction();
    console.error('[InsuranceV2][autoLinkOrphanSessions] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    mongoSession.endSession();
  }
}

/**
 * POST /api/v2/insurance/guides/auto-link-orphans/preview
 * Pré-visualiza quais sessões órfãs seriam vinculadas a quais guias,
 * sem efetivar alterações no banco.
 */
export async function previewAutoLinkOrphanSessions(req, res) {
  try {
    const { month } = req.body;
    let periodStart, periodEnd;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      periodStart = new Date(y, m - 1, 1);
      periodEnd = new Date(y, m, 0, 23, 59, 59, 999);
    }

    const orphanMatch = {
      status: 'completed',
      $or: [{ paymentMethod: 'convenio' }, { billingType: 'convenio' }],
      $and: [
        { $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }] },
        { $or: [{ insuranceGuide: { $exists: false } }, { insuranceGuide: null }] }
      ]
    };
    if (periodStart && periodEnd) orphanMatch.date = { $gte: periodStart, $lte: periodEnd };

    const orphanSessions = await Session.find(orphanMatch)
      .populate('patient', 'fullName')
      .populate('appointmentId', 'specialty insuranceProvider')
      .lean();

    const linked = [];
    const skipped = [];

    for (const session of orphanSessions) {
      const rawPatientId = session.patient?._id || session.patient;
      const patientName = session.patient?.fullName || 'Paciente não identificado';
      const specialty = (session.sessionType || session.appointmentId?.specialty || '').toLowerCase().trim();

      if (!rawPatientId) {
        skipped.push({
          sessionId: session._id.toString(),
          patientName,
          specialty,
          date: session.date,
          reason: 'Paciente não encontrado'
        });
        continue;
      }

      if (!specialty) {
        skipped.push({
          sessionId: session._id.toString(),
          patientName,
          specialty,
          date: session.date,
          reason: 'Especialidade não encontrada'
        });
        continue;
      }

      const guide = await InsuranceGuide.findValid(
        rawPatientId.toString(),
        specialty,
        session.date ? new Date(session.date) : new Date()
      );

      if (!guide) {
        skipped.push({
          sessionId: session._id.toString(),
          patientName,
          specialty,
          date: session.date,
          reason: 'Nenhuma guia ativa compatível'
        });
        continue;
      }

      linked.push({
        sessionId: session._id.toString(),
        patientName,
        specialty,
        date: session.date,
        guideId: guide._id.toString(),
        guideNumber: guide.number,
        guideInsurance: guide.insurance,
        guideTotalSessions: guide.totalSessions,
        guideUsedSessions: guide.usedSessions,
        guideExpiresAt: guide.expiresAt
      });
    }

    res.json({
      success: true,
      linked,
      skipped,
      linkedCount: linked.length,
      skippedCount: skipped.length
    });
  } catch (error) {
    console.error('[InsuranceV2][previewAutoLinkOrphanSessions] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * POST /api/v2/insurance/guides/create-from-orphan
 * Cria uma nova guia a partir de uma sessão órfã e já a vincula.
 */
export async function createGuideFromOrphan(req, res) {
  const mongoSession = await mongoose.startSession();
  mongoSession.startTransaction();
  try {
    const { sessionId, number, totalSessions, expiresAt, sessionValue } = req.body;

    if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ success: false, error: 'sessionId inválido' });
    }
    if (!number || !totalSessions || !expiresAt) {
      return res.status(400).json({ success: false, error: 'number, totalSessions e expiresAt são obrigatórios' });
    }

    const session = await Session.findById(sessionId)
      .populate('patient', 'fullName')
      .populate('appointmentId', 'specialty insuranceProvider')
      .session(mongoSession);

    if (!session) {
      return res.status(404).json({ success: false, error: 'Sessão não encontrada' });
    }

    if (session.insuranceGuide) {
      return res.status(400).json({ success: false, error: 'Sessão já possui guia vinculada' });
    }

    const patientId = session.patient?._id || session.patient;
    const specialty = (session.sessionType || session.appointmentId?.specialty || '').toLowerCase().trim();
    const insurance = session.appointmentId?.insuranceProvider || 'nao_identificado';

    if (!patientId || !specialty) {
      return res.status(400).json({ success: false, error: 'Paciente ou especialidade ausente na sessão' });
    }

    const existingGuide = await InsuranceGuide.findOne({ number: number.toUpperCase().trim() }).session(mongoSession).lean();
    if (existingGuide) {
      return res.status(409).json({ success: false, error: 'Já existe uma guia com este número' });
    }

    const guide = new InsuranceGuide({
      number: number.toUpperCase().trim(),
      patientId,
      specialty,
      insurance,
      totalSessions: Number(totalSessions),
      usedSessions: 1,
      sessionValue: sessionValue ? Number(sessionValue) : (session.sessionValue || 0),
      expiresAt: new Date(expiresAt),
      status: Number(totalSessions) <= 1 ? 'exhausted' : 'active',
      consumptionHistory: [{
        sessionId: session._id,
        sessionNumber: 1,
        consumedAt: new Date(),
        notes: 'Criada a partir de sessão órfã'
      }]
    });

    await guide.save({ session: mongoSession });

    session.insuranceGuide = guide._id;
    session.guideConsumed = true;
    await session.save({ session: mongoSession });

    await Payment.updateMany(
      { session: session._id, billingType: 'convenio' },
      { $set: { 'insurance.guideId': guide._id, insuranceGuide: guide._id } },
      { session: mongoSession }
    );

    await mongoSession.commitTransaction();

    res.json({
      success: true,
      data: {
        guideId: guide._id.toString(),
        number: guide.number,
        sessionId: session._id.toString()
      }
    });
  } catch (error) {
    await mongoSession.abortTransaction();
    console.error('[InsuranceV2][createGuideFromOrphan] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    mongoSession.endSession();
  }
}

/**
 * POST /api/v2/insurance/guides/link-orphan-sessions
 * Vincula sessões órfãs a uma guia existente.
 */
export async function linkOrphanSessionsToGuide(req, res) {
  const mongoSession = await mongoose.startSession();
  mongoSession.startTransaction();
  try {
    const { guideId, guideNumber, sessionIds } = req.body;

    if (!guideId && !guideNumber) {
      return res.status(400).json({ success: false, error: 'guideId ou guideNumber é obrigatório' });
    }
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ success: false, error: 'sessionIds deve ser um array não vazio' });
    }

    let guide;
    if (guideId && mongoose.Types.ObjectId.isValid(guideId)) {
      guide = await InsuranceGuide.findById(guideId).session(mongoSession);
    }
    if (!guide && guideNumber) {
      guide = await InsuranceGuide.findOne({ number: guideNumber.toUpperCase().trim() }).session(mongoSession);
    }
    if (!guide) {
      return res.status(404).json({ success: false, error: 'Guia não encontrada' });
    }

    const available = guide.totalSessions - guide.usedSessions;
    if (available < sessionIds.length) {
      return res.status(400).json({ success: false, error: `Guia tem apenas ${available} sessão(ões) disponível(eis)` });
    }

    const sessions = await Session.find({
      _id: { $in: sessionIds.map(id => new mongoose.Types.ObjectId(id)) },
      status: 'completed',
      $or: [{ insuranceGuide: { $exists: false } }, { insuranceGuide: null }]
    }).session(mongoSession);

    if (sessions.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhuma sessão órfã válida encontrada' });
    }

    const linked = [];
    for (const session of sessions) {
      guide.usedSessions += 1;
      guide.consumptionHistory.push({
        sessionId: session._id,
        sessionNumber: guide.usedSessions,
        consumedAt: new Date(),
        notes: 'Vínculo manual de sessão órfã'
      });

      session.insuranceGuide = guide._id;
      session.guideConsumed = true;
      await session.save({ session: mongoSession });

      await Payment.updateMany(
        { session: session._id, billingType: 'convenio' },
        { $set: { 'insurance.guideId': guide._id, insuranceGuide: guide._id } },
        { session: mongoSession }
      );

      linked.push(session._id.toString());
    }

    if (guide.usedSessions >= guide.totalSessions) guide.status = 'exhausted';
    await guide.save({ session: mongoSession });

    await mongoSession.commitTransaction();

    res.json({ success: true, linked, guideId });
  } catch (error) {
    await mongoSession.abortTransaction();
    console.error('[InsuranceV2][linkOrphanSessionsToGuide] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    mongoSession.endSession();
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

    // ── Filtros base ──────────────────────────────────────────────────
    const batchBaseFilter = {};
    if (provider) batchBaseFilter.insuranceProvider = provider;

    const pkgFilter = { type: 'convenio' };
    if (provider) pkgFilter.insuranceProvider = provider;

    const avulsoFilter = {
      billingType: 'convenio',
      package: null,
      amount: { $gt: 0 },
      'insurance.provider': { $nin: [null, '', 'Convênio', 'convenio'] },
      serviceDate: { $gte: startDate, $lte: endDate },
      status: { $nin: ['cancelled', 'canceled'] }
    };
    if (provider) avulsoFilter['insurance.provider'] = provider;

    const guideFilter = provider
      ? { insurance: provider, $or: [
          { issuedAt: { $gte: startDate, $lte: endDate } },
          { issuedAt: null, createdAt: { $gte: startDate, $lte: endDate } }
        ] }
      : { $or: [
          { issuedAt: { $gte: startDate, $lte: endDate } },
          { issuedAt: null, createdAt: { $gte: startDate, $lte: endDate } }
        ] };

    // ── Round 1: 4 fontes em paralelo ─────────────────────────────────
    const [batches, packages, avulsoPayments, guidesInYear] = await Promise.all([
      InsuranceBatch.find(batchBaseFilter).lean(),
      Package.find(pkgFilter).populate('patient', 'fullName name phone').lean(),
      Payment.find(avulsoFilter).populate('patient', 'fullName name phone').lean(),
      InsuranceGuide.find(guideFilter).populate('patientId', 'fullName name phone').lean()
    ]);

    // Appointment e Session IDs presentes em algum batch (deduplicação JS — sem query extra)
    // IMPORTANTE: filter ANTES do String() — String(undefined) = "undefined" que é truthy
    const apptIdsInBatches = new Set();
    const sessionIdsInBatches = new Set();
    for (const batch of batches) {
      for (const s of (batch.sessions || [])) {
        if (s.appointment != null) apptIdsInBatches.add(String(s.appointment));
        if (s.session != null) sessionIdsInBatches.add(String(s.session));
      }
    }

    const batchApptOids  = [...apptIdsInBatches];
    const allPkgApptIds  = packages.flatMap(p => (p.appointments || []).filter(id => id && id !== 'undefined'));
    const avulsoApptIds  = avulsoPayments.map(p => p.appointment).filter(Boolean);
    const guideIds       = guidesInYear.map(g => g._id);

    // ── Round 1b: Sessões filhas das guias abertas no ano ─────────────
    const guideSessions = guideIds.length
      ? await Session.find({
          insuranceGuide: { $in: guideIds },
          status: 'completed'
        })
          .populate('patient', 'fullName name phone')
          .populate('doctor', 'fullName specialty')
          .lean()
      : [];

    // Mapa sessão → guia para corrigir provider/specialty quando o Payment
    // foi criado com dados genéricos (ex: insurance.provider='Outros' mas a
    // sessão aponta para uma InsuranceGuide real).
    const guideBySessionId = new Map();
    for (const session of guideSessions) {
      const guide = guidesInYear.find(g => String(g._id) === String(session.insuranceGuide));
      if (guide) guideBySessionId.set(String(session._id), guide);
    }

    // Mapa de nomes de paciente por ID — fallback robusto para casos onde o
    // Appointment não tem patientInfo populado (ex: lotes de convênio).
    const patientNameById = new Map();
    const patientPhoneById = new Map();
    function registerPatientName(patient) {
      if (!patient) return;
      const id = patient._id?.toString?.() || patient.toString?.();
      if (!id) return;
      const name = patient.fullName || patient.name;
      if (name && !patientNameById.has(id)) patientNameById.set(id, name);
      if (patient.phone && !patientPhoneById.has(id)) patientPhoneById.set(id, patient.phone);
    }
    for (const pmt of avulsoPayments) registerPatientName(pmt.patient);
    for (const pkg of packages) registerPatientName(pkg.patient);
    for (const g of guidesInYear) registerPatientName(g.patientId);
    for (const s of guideSessions) registerPatientName(s.patient);

    // ── Round 2: 3 lookups de Appointment em paralelo ─────────────────
    const [batchAppts, pkgAppts, avulsoAppts] = await Promise.all([
      batchApptOids.length
        ? Appointment.find({ _id: { $in: batchApptOids } }).select('patient patientInfo specialty date').lean()
        : Promise.resolve([]),
      allPkgApptIds.length
        ? Appointment.find({
            _id: { $in: allPkgApptIds },
            operationalStatus: 'completed',
            date: { $gte: startDate, $lte: endDate }
          }).select('_id date specialty operationalStatus').lean()
        : Promise.resolve([]),
      avulsoApptIds.length
        ? Appointment.find({ _id: { $in: avulsoApptIds } }).select('_id specialty').lean()
        : Promise.resolve([])
    ]);

    const bApptMap = {};
    for (const a of batchAppts) bApptMap[String(a._id)] = a;

    const pkgApptMap = {};
    for (const a of pkgAppts) pkgApptMap[String(a._id)] = a;

    // Regra de precedência: Payment ativo > Package quando mesmo appointment.
    // Evita double-counting no Histórico (P1): se existe Payment para o appointment,
    // a entrada do Package é suprimida — Payment é a fonte canônica.
    const apptIdsWithPayment = new Set(
      avulsoPayments.map(p => p.appointment).filter(Boolean).map(String)
    );

    // Sessões já contadas por outras fontes (lote, payment avulso, package)
    // serão ignoradas na quarta fonte (guia) para não duplicar valor/sessão.
    const countedSessionIds = new Set();
    for (const batch of batches) {
      for (const s of (batch.sessions || [])) {
        if (s.session) countedSessionIds.add(String(s.session));
      }
    }
    for (const pmt of avulsoPayments) {
      if (pmt.session) countedSessionIds.add(String(pmt.session));
    }
    for (const pkg of packages) {
      for (const apptId of (pkg.appointments || [])) {
        countedSessionIds.add(String(apptId));
      }
    }

    // ── 3. AGRUPA por mês → provider → paciente → especialidade ──────
    const byMonth = {};

    // Data de envio mais recente por convênio+mês — granularidade real é por
    // guia/lote, não por convênio+mês, então aqui é sempre o MAIS RECENTE
    // dentre tudo que contribuiu pra esse bucket (pode esconder envios mais
    // antigos do mesmo convênio no mesmo mês, ver P3.1 gap analysis).
    const lastSentAtByKey = {};
    function trackSentAt(monthKey, prov, date) {
      if (!date) return;
      const d = new Date(date);
      if (isNaN(d.getTime())) return;
      const key = `${monthKey}__${prov}`;
      if (!lastSentAtByKey[key] || d > lastSentAtByKey[key]) lastSentAtByKey[key] = d;
    }

    function addEntry(monthKey, prov, patientId, patientName, phone, specialty, value, source, batchStatus) {
      if (!byMonth[monthKey]) byMonth[monthKey] = {};
      if (!byMonth[monthKey][prov]) byMonth[monthKey][prov] = {};
      if (!byMonth[monthKey][prov][patientName]) byMonth[monthKey][prov][patientName] = { patientId, phone, specialties: {} };
      // Atualiza patientId se estiver faltando (prioriza o que já tem)
      if (patientId && !byMonth[monthKey][prov][patientName].patientId) {
        byMonth[monthKey][prov][patientName].patientId = patientId;
      }
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

    // Packages: 1 entrada por appointment completed no período
    // Excluído se: (a) já em batch, (b) existe Payment ativo para o mesmo appointment
    for (const pkg of packages) {
      const prov     = pkg.insuranceProvider || 'outros';
      const patientId = pkg.patient?._id?.toString() || null;
      const patName  = pkg.patient?.fullName || pkg.patient?.name || 'Desconhecido';
      const phone    = pkg.patient?.phone || '';
      const specialty = pkg.specialty || 'outros';
      const value    = pkg.sessionValue || 80;
      const status   = pkg.insuranceBillingStatus || 'pending_batch';

      for (const apptId of (pkg.appointments || [])) {
        if (apptIdsInBatches.has(String(apptId))) continue;   // já contado no batch
        if (apptIdsWithPayment.has(String(apptId))) continue; // Payment vence Package
        const appt = pkgApptMap[String(apptId)];
        if (!appt) continue; // fora do período ou não completed
        const d  = new Date(appt.date);
        const mk = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        addEntry(mk, prov, patientId, patName, phone, specialty, value, 'package', status);
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
        const patientId = appt?.patient?.toString() || null;
        // Fallback robusto: se o appointment não tiver patientInfo populado,
        // busca o nome do paciente no mapa construído a partir de payments,
        // packages, guias e sessões.
        const resolvedName = patientId && patientNameById.has(patientId)
          ? patientNameById.get(patientId)
          : (appt?.patientInfo?.fullName || appt?.patientInfo?.name || 'Desconhecido');
        const patName  = resolvedName;
        const phone    = (patientId && patientPhoneById.get(patientId)) || appt?.patientInfo?.phone || '';
        const specialty = appt?.specialty || 'outros';
        addEntry(mk, prov, patientId, patName, phone, specialty, s.grossAmount || 0, 'lote', batchStatus);
        if (batchStatus !== 'pending_batch') trackSentAt(mk, prov, batch.sentDate || batch.createdAt);
      }
    }

    // ── 3b. PAYMENTS AVULSOS (sem package, ex: Bradesco) ────────────
    // Já carregados no Round 1 — constrói mapa com resultados do Round 2
    const avulsoApptMap = {};
    for (const a of avulsoAppts) avulsoApptMap[String(a._id)] = a;
    for (const a of avulsoAppts) avulsoApptMap[String(a._id)] = a;

    for (const pmt of avulsoPayments) {
      const serviceDate = pmt.serviceDate;
      if (!serviceDate) continue;
      // Deduplica: se a sessão/appointment deste payment já foi contada em um
      // lote, não deve gerar segunda entrada.
      if (pmt.session && sessionIdsInBatches.has(String(pmt.session))) continue;
      if (pmt.appointment && apptIdsInBatches.has(String(pmt.appointment))) continue;
      const d  = new Date(serviceDate);
      if (d.getFullYear() !== filterYear) continue;
      const mk       = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      // Usa o slug cru (prov) como chave, igual ao caminho de batches — nunca o label
      // formatado. Misturar os dois criava 2 entradas pro mesmo convênio no mesmo mês
      // (achado 2026-07-30) e vazava o label pro frontend como "providerSlug", que
      // depois não batia com o slug real ao filtrar sessões (retornava lista vazia).
      // Se o Payment tiver session vinculada a uma InsuranceGuide, prioriza o provider
      // da guia — corrige casos onde o payment foi criado com provider genérico
      // (ex: 'Outros') mas a sessão aponta para o convênio real.
      const sessionGuide = pmt.session ? guideBySessionId.get(String(pmt.session)) : null;
      const prov     = sessionGuide?.insurance || pmt.insurance.provider;
      const patientId = pmt.patient?._id?.toString() || pmt.patientId?.toString() || null;
      const patName  = pmt.patient?.fullName || pmt.patient?.name || 'Desconhecido';
      const phone    = pmt.patient?.phone || '';
      const specialty = avulsoApptMap[String(pmt.appointment)]?.specialty || sessionGuide?.specialty || pmt.serviceType || 'outros';
      const insStatus = pmt.insurance?.status || 'pending_billing';
      const batchStatus = insStatus === 'received' ? 'received' : insStatus === 'billed' ? 'billed' : 'pending_batch';
      addEntry(mk, prov, patientId, patName, phone, specialty, pmt.amount, 'avulso', batchStatus);
      if (batchStatus !== 'pending_batch') trackSentAt(mk, prov, pmt.insurance?.billedAt);
    }

    // ── 3c. GUIAS ATIVAS NÃO LOTADAS (quarta fonte) ─────────────────
    // Sessões vinculadas a InsuranceGuide cuja competência (mês de emissão)
    // pertence ao ano filtrado, mas que ainda não entraram em lote nem geraram
    // Payment avulso/Package. Corrige sumiço de guias antigas cujas sessões
    // reais ocorreram em meses posteriores ao da abertura (P1/P3).
    for (const session of guideSessions) {
      if (countedSessionIds.has(String(session._id))) continue;

      const guide = guidesInYear.find(g => String(g._id) === String(session.insuranceGuide));
      if (!guide) continue;

      const competenceDate = guide.issuedAt || guide.createdAt;
      if (!competenceDate || competenceDate < startDate || competenceDate > endDate) continue;

      const d = new Date(competenceDate);
      const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const prov = guide.insurance || 'outros';
      const patientId =
        session.patient?._id?.toString() ||
        guide.patientId?._id?.toString() ||
        guide.patientId?.toString?.() ||
        null;
      const patName =
        session.patient?.fullName ||
        session.patient?.name ||
        guide.patientId?.fullName ||
        guide.patientId?.name ||
        'Desconhecido';
      const phone = session.patient?.phone || guide.patientId?.phone || '';
      const specialty = guide.specialty || session.sessionType || 'outros';
      const value = guide.sessionValue || session.sessionValue || 0;

      addEntry(mk, prov, patientId, patName, phone, specialty, value, 'guia', 'pending_batch');
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
          return { name: patName, patientId: pd.patientId, phone: pd.phone, specialties, totalSessions: totSess, totalValue: totValue };
        }).sort((a, b) => a.name.localeCompare(b.name));

        const totalSessions = patients.reduce((s, p) => s + p.totalSessions, 0);
        const totalValue    = patients.reduce((s, p) => s + p.totalValue, 0);

        // Status geral do provider no mês
        const allStatuses = patients.flatMap(p => p.specialties.map(s => s.batchStatus));
        const providerStatus = allStatuses.every(s => s === 'received') ? 'received'
          : allStatuses.some(s => s === 'billed') ? 'billed' : 'pending_batch';

        const provLabel = prov.split('-').map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(' ')
          .replace('Anapolis', 'Anápolis').replace('Goiania', 'Goiânia').replace('Saude', 'Saúde');

        return { provider: prov, providerLabel: provLabel, patients, totalSessions, totalValue, status: providerStatus, lastSentAt: lastSentAtByKey[`${mk}__${prov}`] || null };
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

// GET /api/v2/insurance/patient-sessions
// Sessões individuais de um paciente em um mês/especialidade (lazy expand no drawer)
export async function getPatientInsuranceSessions(req, res) {
  try {
    const { patientId, month, specialty, provider, status = 'all' } = req.query;

    if (!patientId || !month) {
      return res.status(400).json({ success: false, error: 'patientId e month são obrigatórios' });
    }

    if (!/^[0-9a-fA-F]{24}$/.test(patientId)) {
      return res.status(400).json({ success: false, error: 'patientId inválido' });
    }

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: 'month deve estar no formato YYYY-MM' });
    }

    const [y, m] = month.split('-').map(Number);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0, 23, 59, 59, 999);

    const patientOid = new mongoose.Types.ObjectId(patientId);

    // Modelo de faturamento aplicável a este provider+mês. No modelo ATUAL
    // (guia → lote único), selecionar um mês significa "guias cuja competência
    // é esse mês", e o drawer deve mostrar TODAS as sessões dessas guias,
    // inclusive as de meses seguintes. No modelo LEGADO, cada mês é um lote e
    // o drawer mostra apenas as sessões daquela competência.
    const billingModelForRequest = resolveBillingModelForMonth(provider, month);

    // Base de busca: sessões de convênio do paciente no mês.
    // Filtro de especialidade NÃO entra aqui — resolvemos em JS por causa das
    // divergências entre Package.specialty e Session.sessionType.
    const sessionMatch = {
      patient: patientOid,
      status: 'completed',
      date: { $gte: start, $lte: end },
      $or: [
        { billingType: 'convenio' },
        { paymentMethod: 'convenio' },
        { insuranceGuide: { $exists: true, $ne: null } },
        { paymentOrigin: 'convenio' }
      ]
    };

    // ── 1) Busca primária: sessões do mês + legado por competência ────────
    const [monthSessions, guideSessionsByCompetence, avulsoPayments, patientPackages] = await Promise.all([
      Session.find(sessionMatch)
        .populate('patient', 'fullName phone')
        .populate('doctor', 'fullName specialty')
        .populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions issuedAt createdAt')
        .lean(),
      // LEGADO: sessões cuja GUIA tem competência no mês, mesmo que a sessão
      // clínica tenha ocorrido em outro mês (ex: guia de fev com sessão em mar).
      Session.find({
        patient: patientOid,
        status: 'completed',
        insuranceGuide: { $exists: true, $ne: null },
        $or: [
          { billingType: 'convenio' },
          { paymentMethod: 'convenio' },
          { paymentOrigin: 'convenio' }
        ]
      })
        .populate('patient', 'fullName phone')
        .populate('doctor', 'fullName specialty')
        .populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions issuedAt createdAt')
        .lean(),
      Payment.find({
        patient: patientOid,
        billingType: 'convenio',
        package: null,
        serviceDate: { $gte: start, $lte: end },
        status: { $nin: ['cancelled', 'canceled'] }
      }).lean(),
      Package.find({ patient: patientOid, type: 'convenio' }).select('specialty insuranceBillingStatus').lean()
    ]);

    // ── 2) Monta o conjunto de sessões a processar ────────────────────────
    const sessionById = new Map();

    // MODELO LEGADO: inclui sessões do mês + sessões de guias cuja competência
    // (issuedAt/createdAt) cai no mês selecionado.
    if (billingModelForRequest === BILLING_MODEL.LEGACY_MONTHLY_BATCH) {
      for (const s of monthSessions) sessionById.set(String(s._id), s);
      for (const s of guideSessionsByCompetence) {
        const guide = s.insuranceGuide;
        if (!guide) continue;
        const competence = guide.issuedAt || guide.createdAt;
        if (!competence) continue;
        const d = new Date(competence);
        const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        if (mk !== month) continue;
        sessionById.set(String(s._id), s);
      }
    }

    // MODELO ATUAL: o filtro de mês significa "guias cuja competência cai no mês".
    // Depois de encontrar essas guias, busca TODAS as sessões delas — sem
    // reaplicar filtro por mês. Isso evita que uma guia iniciada em junho, com
    // sessões também em julho/agosto, apareça pela metade ao filtrar junho.
    if (billingModelForRequest === BILLING_MODEL.CURRENT_GUIDE_BATCH) {
      const guideIdSet = new Set();

      // Fonte 1: InsuranceGuide.patientId (mais direta).
      const guidesByPatient = await InsuranceGuide.find({
        patientId: patientOid,
        $or: [
          { issuedAt: { $gte: start, $lte: end } },
          { issuedAt: { $exists: false }, createdAt: { $gte: start, $lte: end } },
          { issuedAt: null, createdAt: { $gte: start, $lte: end } }
        ]
      }).select('_id').lean();
      for (const g of guidesByPatient) guideIdSet.add(String(g._id));

      // Fonte 2: sessões do mês (fallback robusto). Se InsuranceGuide.patientId
      // estiver nulo/errado em dados migrados, a Session ainda aponta para a guia
      // e permite encontrá-la.
      for (const s of monthSessions) {
        if (s.insuranceGuide?._id) guideIdSet.add(String(s.insuranceGuide._id));
      }

      const guideIds = [...guideIdSet];

      if (guideIds.length > 0) {
        const allGuideSessions = await Session.find({
          patient: patientOid,
          status: 'completed',
          insuranceGuide: { $in: guideIds.map(id => new mongoose.Types.ObjectId(id)) },
          $or: [
            { billingType: 'convenio' },
            { paymentMethod: 'convenio' },
            { paymentOrigin: 'convenio' }
          ]
        })
          .populate('patient', 'fullName phone')
          .populate('doctor', 'fullName specialty')
          .populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions issuedAt createdAt')
          .lean();

        for (const s of allGuideSessions) sessionById.set(String(s._id), s);
      }

      // Também inclui sessões avulsas do mês (sem guia) e payments avulsos.
      for (const s of monthSessions) {
        if (!s.insuranceGuide) sessionById.set(String(s._id), s);
      }
    }

    const mergedSessions = [...sessionById.values()];

    const packageSpecialtyById = Object.fromEntries(patientPackages.map(p => [p._id.toString(), p.specialty]));
    // getInsuranceHistory usa pkg.insuranceBillingStatus (nível Package) pra decidir o
    // status do card, mas o Payment de cada sessão individual tem seu próprio
    // insurance.status — achado 2026-08-03: um pode dizer "received" e o outro
    // "pending_batch" pro mesmo grupo. Aceita bater com qualquer um dos dois.
    const packageStatusById = Object.fromEntries(patientPackages.map(p => [p._id.toString(), p.insuranceBillingStatus || 'pending_batch']));
    function matchesStatusFilter(billingStatus, packageId) {
      if (status === 'all') return true;
      if (billingStatus === status) return true;
      const packageStatus = packageId ? packageStatusById[packageId.toString()] : null;
      return packageStatus === status;
    }
    const specialtyFilter = specialty ? specialty.toLowerCase().trim() : null;
    function matchesSpecialtyFilter(candidates) {
      if (!specialtyFilter) return true;
      const list = Array.isArray(candidates) ? candidates : [candidates];
      return list.some(c => (c || '').toLowerCase().trim() === specialtyFilter);
    }

    // InsuranceResolverService resolve UM provider por prioridade fixa (Payment >
    // Session.insuranceProvider > Session.insuranceGuide.insurance > ...), mas
    // getInsuranceHistory agrupa pelo campo bruto de quem efetivamente processou
    // o registro (batch.insuranceProvider p/ lote, pkg.insuranceProvider p/ pacote).
    // Quando esses dois divergem pro mesmo registro (achado 2026-08-03: guia com
    // insurance="unimed-campinas" mas processada num lote "unimed-anapolis"), um
    // filtro estrito no valor resolvido zera a busca mesmo a sessão pertencendo
    // de fato ao card clicado. Aceita bater com qualquer fonte plausível.
    function matchesProviderFilter(candidates) {
      if (!provider) return true;
      const target = provider.toLowerCase().trim();
      return candidates.some(c => (c || '').toLowerCase().trim() === target);
    }

    const sessionIds = mergedSessions.map(s => s._id);
    const appointmentIds = mergedSessions.map(s => s.appointmentId).filter(Boolean);
    const avulsoAppointmentIds = avulsoPayments.map(p => p.appointment).filter(Boolean);
    const allAppointmentIds = [...new Set([...appointmentIds, ...avulsoAppointmentIds])].map(id => id.toString());

    // ── 2) Appointments e Payments relacionados ─────────────────────────
    const [appointments, payments, batches] = await Promise.all([
      allAppointmentIds.length
        ? Appointment.find({ _id: { $in: allAppointmentIds } })
            .select('_id patient specialty insuranceProvider insuranceGuide date time patientInfo')
            .lean()
        : Promise.resolve([]),
      sessionIds.length || allAppointmentIds.length
        ? Payment.find({
            $or: [
              { session: { $in: sessionIds } },
              { appointment: { $in: allAppointmentIds } }
            ],
            status: { $nin: ['cancelled', 'canceled'] }
          }).lean()
        : Promise.resolve([]),
      sessionIds.length
        ? InsuranceBatch.find({ 'sessions.session': { $in: sessionIds } })
            .select('insuranceProvider status sessions.session sessions.status sessions.grossAmount sessions.appointment')
            .lean()
        : Promise.resolve([])
    ]);

    const apptById = Object.fromEntries(appointments.map(a => [a._id.toString(), a]));
    const paymentBySession = Object.fromEntries(payments.filter(p => p.session).map(p => [p.session.toString(), p]));
    const paymentByAppointment = Object.fromEntries(payments.filter(p => p.appointment).map(p => [p.appointment.toString(), p]));
    const avulsoPaymentByAppointment = Object.fromEntries(avulsoPayments.filter(p => p.appointment).map(p => [p.appointment.toString(), p]));

    // ── 3) Montar resultado ─────────────────────────────────────────────
    const result = [];
    const resultSessionIds = new Set();

    function analyzeSession(session) {
      const sessionId = session._id.toString();
      const appt = apptById[session.appointmentId?.toString()];
      const payment = paymentBySession[sessionId] || paymentByAppointment[session.appointmentId?.toString()];
      const batch = batches.find(b => b.sessions.some(s => s.session?.toString() === sessionId));
      const batchSession = batch?.sessions.find(s => s.session?.toString() === sessionId);

      let billingStatus = 'pending_batch';
      if (payment?.insurance?.status === 'received' || batchSession?.status === 'paid' || batch?.status === 'received') {
        billingStatus = 'received';
      } else if (payment?.insurance?.status === 'billed' || batchSession?.status === 'sent' || ['sent', 'processing'].includes(batch?.status)) {
        billingStatus = 'billed';
      }

      const sessionProvider = InsuranceResolverService.resolveInsuranceProvider({
        payment,
        session,
        appointment: appt,
        batch
      });

      // Prioriza a especialidade do Package (mesma fonte que getInsuranceHistory usa
      // pra agrupar) sobre a da Session — ver nota acima sobre a divergência.
      const packageSpecialty = session.package ? packageSpecialtyById[session.package.toString()] : null;
      const resolvedSpecialty = packageSpecialty || session.sessionType || appt?.specialty || session.insuranceGuide?.specialty || 'outros';

      const result = {
        sessionId,
        date: session.date,
        // Appointment.time é a hora real do atendimento — a hora embutida em
        // Session.date não bate com a lista de presença assinada (ver mesma
        // ressalva documentada em GuidePendingBillingSection/PendingGuideSession).
        time: appt?.time || null,
        patient: session.patient,
        doctor: session.doctor,
        specialty: resolvedSpecialty,
        provider: sessionProvider,
        guideNumber: session.insuranceGuide?.number || payment?.insurance?.authorizationCode || null,
        value: payment?.insurance?.grossAmount || payment?.amount || session.sessionValue || 0,
        grossAmount: payment?.insurance?.grossAmount || payment?.amount || session.sessionValue || 0,
        issRate: payment?.insurance?.issRate ?? null,
        issAmount: payment?.insurance?.issAmount ?? null,
        billingStatus,
        batchId: batch?._id || session.billingBatchId || null,
        batchNumber: batch?.batchNumber || null,
        sentDate: batch?.sentDate || batchSession?.sentAt || null,
        invoiceNumber: batch?.invoiceNumber || null,
        billedAt: payment?.insurance?.billedAt || null,
        receivedAt: payment?.insurance?.receivedAt || null,
        receivedAmount: payment?.insurance?.receivedAmount || null,
        paymentId: payment?._id || null,
        appointmentId: session.appointmentId || null,
        source: 'lote',
        professionalPaymentStatus: session.professionalPaymentStatus || 'payable',
        professionalPaymentOverride: session.professionalPaymentOverride || null
      };

      return {
        result,
        providerCandidates: [sessionProvider, batch?.insuranceProvider, appt?.insuranceProvider, session.insuranceGuide?.insurance, payment?.insurance?.provider],
        specialtyCandidates: [packageSpecialty, session.sessionType, appt?.specialty, session.insuranceGuide?.specialty],
        packageRef: session.package
      };
    }

    // No modelo por guia (CURRENT_GUIDE_BATCH), quando houver filtro de status,
    // trazemos a GUIA completa se ela tiver ao menos uma sessão do mês filtrado
    // com o status desejado. Isso reflete a regra de negócio "guia completada":
    // a clínica vê todas as sessões da guia para contexto, mesmo as já
    // faturadas/recebidas de meses anteriores. O status individual continua
    // sendo o real de cada sessão.
    if (billingModelForRequest === BILLING_MODEL.CURRENT_GUIDE_BATCH && status !== 'all') {
      const monthSessionIds = new Set(monthSessions.map(s => s._id.toString()));
      const candidates = [];

      for (const session of mergedSessions) {
        const analyzed = analyzeSession(session);
        if (!matchesProviderFilter(analyzed.providerCandidates)) continue;
        if (!matchesSpecialtyFilter(analyzed.specialtyCandidates)) continue;
        candidates.push({ session, analyzed, isMonthSession: monthSessionIds.has(analyzed.result.sessionId) });
      }

      const byGuide = new Map();
      const avulsos = [];
      for (const c of candidates) {
        const guideId = c.session.insuranceGuide?._id?.toString();
        if (guideId) {
          if (!byGuide.has(guideId)) byGuide.set(guideId, []);
          byGuide.get(guideId).push(c);
        } else {
          avulsos.push(c);
        }
      }

      for (const candidatesOfGuide of byGuide.values()) {
        const hasMatch = candidatesOfGuide.some(c => c.isMonthSession && matchesStatusFilter(c.analyzed.result.billingStatus, c.analyzed.packageRef));
        if (!hasMatch) continue;
        for (const c of candidatesOfGuide) {
          if (resultSessionIds.has(c.analyzed.result.sessionId)) continue;
          resultSessionIds.add(c.analyzed.result.sessionId);
          result.push(c.analyzed.result);
        }
      }

      for (const c of avulsos) {
        if (!c.isMonthSession) continue;
        if (!matchesStatusFilter(c.analyzed.result.billingStatus, c.analyzed.packageRef)) continue;
        if (resultSessionIds.has(c.analyzed.result.sessionId)) continue;
        resultSessionIds.add(c.analyzed.result.sessionId);
        result.push(c.analyzed.result);
      }
    } else {
      // Comportamento padrão/legado: filtra status por sessão individual.
      for (const session of mergedSessions) {
        const analyzed = analyzeSession(session);
        if (!matchesProviderFilter(analyzed.providerCandidates)) continue;
        if (!matchesStatusFilter(analyzed.result.billingStatus, analyzed.packageRef)) continue;
        if (!matchesSpecialtyFilter(analyzed.specialtyCandidates)) continue;
        result.push(analyzed.result);
      }
    }

    // Payments avulsos (sem sessão/package, ex: Bradesco antigo)
    for (const pmt of avulsoPayments) {
      const appt = apptById[pmt.appointment?.toString()];
      if (!matchesSpecialtyFilter([appt?.specialty, pmt.serviceType])) continue;

      const sessionId = pmt.session?.toString();
      // Evita duplicar se já adicionamos pela sessão
      if (sessionId && result.some(r => r.sessionId === sessionId)) continue;

      const batch = sessionId ? batches.find(b => b.sessions.some(s => s.session?.toString() === sessionId)) : null;
      const batchSession = batch?.sessions.find(s => s.session?.toString() === sessionId);
      const insStatus = pmt.insurance?.status || 'pending_billing';
      let billingStatus = insStatus === 'received' ? 'received' : insStatus === 'billed' ? 'billed' : 'pending_batch';
      if (batchSession?.status === 'paid' || batch?.status === 'received') billingStatus = 'received';
      else if (batchSession?.status === 'sent' || ['sent', 'processing'].includes(batch?.status)) billingStatus = 'billed';

      const sessionProvider = InsuranceResolverService.resolveInsuranceProvider({
        payment: pmt,
        appointment: appt
      });
      if (!matchesProviderFilter([sessionProvider, batch?.insuranceProvider, appt?.insuranceProvider, pmt.insurance?.provider])) continue;
      if (!matchesStatusFilter(billingStatus, pmt.package)) continue;

      result.push({
        sessionId: sessionId || null,
        date: pmt.serviceDate || pmt.paymentDate,
        time: appt?.time || null,
        patient: pmt.patient,
        doctor: pmt.doctor,
        specialty: appt?.specialty || pmt.serviceType || 'outros',
        provider: sessionProvider,
        guideNumber: pmt.insurance?.authorizationCode || pmt.insurance?.guideNumber || null,
        value: pmt.insurance?.grossAmount || pmt.amount || 0,
        grossAmount: pmt.insurance?.grossAmount || pmt.amount || 0,
        issRate: pmt.insurance?.issRate ?? null,
        issAmount: pmt.insurance?.issAmount ?? null,
        billingStatus,
        batchId: batch?._id || null,
        batchNumber: batch?.batchNumber || null,
        sentDate: batch?.sentDate || batchSession?.sentAt || null,
        invoiceNumber: batch?.invoiceNumber || null,
        billedAt: pmt.insurance?.billedAt || null,
        receivedAt: pmt.insurance?.receivedAt || null,
        receivedAmount: pmt.insurance?.receivedAmount || null,
        paymentId: pmt._id,
        appointmentId: pmt.appointment?.toString() || null,
        source: 'avulso',
        professionalPaymentStatus: null,
        professionalPaymentOverride: null
      });
    }

    // Ordena por data
    result.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // ── Detecta modelo de faturamento ─────────────────────────────────
    // Regra centralizada em resolveBillingModel/resolveBillingModelForMonth:
    // somente Unimed Anápolis com competências antes de Março/2026 usam o
    // modelo legado mensal. Demais convênios/períodos usam o atual.
    const billingModel = billingModelForRequest;

    function computeGroupStatus(sessions) {
      const statuses = new Set(sessions.map(s => s.billingStatus).filter(Boolean));
      if (statuses.size === 0) return 'pending_batch';
      if (statuses.size === 1) return sessions[0].billingStatus;
      const hasReceived = statuses.has('received');
      const hasBilled = statuses.has('billed');
      const hasPending = statuses.has('pending_batch');
      if (hasReceived && (hasBilled || hasPending)) return 'partial_received';
      if (hasBilled && hasPending) return 'partial_billed';
      return 'mixed';
    }

    function buildSummary(sessions) {
      const grossAmount = sessions.reduce((sum, s) => sum + (s.grossAmount || s.value || 0), 0);
      const issAmount = sessions.reduce((sum, s) => sum + (s.issAmount || 0), 0);
      return {
        sessions: sessions.length,
        grossAmount,
        issAmount,
        netAmount: grossAmount - issAmount,
        status: computeGroupStatus(sessions)
      };
    }

    // Agrupa para o drawer: por lote no legado, por guia no atual.
    // No modelo legado, sessões sem lote são agrupadas por COMPETÊNCIA
    // (mês de abertura da guia > mês da sessão), não jogadas todas num
    // único balde "sem-lote". Assim janeiro e fevereiro da mesma guia não
    // aparecem misturados.
    let groups = [];
    if (billingModel === BILLING_MODEL.LEGACY_MONTHLY_BATCH) {
      const byBatch = new Map();
      for (const s of result) {
        // Determina a competência de agrupamento: lote existente ou mês da guia/sessão
        let key;
        let competenceMonth;
        if (s.batchId) {
          key = String(s.batchId);
        } else {
          // Sem lote: agrupa pela competência da guia quando disponível,
          // senão pela data da sessão.
          const guide = s.guideNumber;
          const rawDate = s.billedAt || s.sentDate || s.date;
          const d = rawDate ? new Date(rawDate) : null;
          const monthKey = d && !isNaN(d.getTime())
            ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
            : 'sem-competencia';
          competenceMonth = monthKey;
          key = `no-batch__${guide || 'sem-guia'}__${monthKey}`;
        }
        if (!byBatch.has(key)) {
          byBatch.set(key, {
            type: 'batch',
            batchId: s.batchId,
            batchNumber: s.batchNumber,
            sentDate: s.sentDate,
            invoiceNumber: s.invoiceNumber,
            guideNumber: s.guideNumber,
            competenceMonth,
            sessions: []
          });
        }
        byBatch.get(key).sessions.push(s);
      }
      groups = [...byBatch.values()].map(g => ({
        ...g,
        summary: buildSummary(g.sessions)
      }));
    } else {
      const byGuide = new Map();
      for (const s of result) {
        const key = s.guideNumber || 'sem-guia';
        if (!byGuide.has(key)) {
          byGuide.set(key, {
            type: 'guide',
            guideNumber: s.guideNumber,
            sessions: []
          });
        }
        byGuide.get(key).sessions.push(s);
      }
      groups = [...byGuide.values()].map(g => ({
        ...g,
        summary: buildSummary(g.sessions)
      }));
    }

    res.json({
      success: true,
      data: result,
      count: result.length,
      billingModel,
      groups
    });
  } catch (error) {
    console.error('[InsuranceV2][getPatientInsuranceSessions] Erro:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
}

export default {
  getInsuranceReceivables,
  faturarLote,
  receberLote,
  encerrarGuia,
  billSession,
  receiveSession,
  listPendingGuides,
  getInsuranceHistory,
  getPatientInsuranceSessions,
  autoLinkOrphanSessions,
  previewAutoLinkOrphanSessions,
  createGuideFromOrphan,
  linkOrphanSessionsToGuide
};
