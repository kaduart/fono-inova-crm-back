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
import InsuranceResolverService from '../services/insuranceResolver.service.js';
import insuranceBilling from '../services/billing/insuranceBilling.js';
import { buildBatchFromGuides, listGuidesPendingBilling } from '../services/insuranceBatchGuideAdapter.js';
import InsuranceGuide from '../models/InsuranceGuide.js';

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
      .populate('session', 'date time specialty status insuranceProvider insuranceGuide patient')
      .populate({
        path: 'session',
        populate: [
          { path: 'patient', select: 'fullName phone' },
          { path: 'insuranceGuide', select: 'number insurance specialty' }
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
    
    patientGroup.payments.push({
      paymentId: payment._id.toString(),
      sessionId: payment.session?._id?.toString() || payment.session?.toString(),
      grossAmount: grossAmount,
      status: payment.insurance?.status || 'pending_billing',
      paymentDate: payment.paymentDate,
      paidAt: payment.paidAt || payment.insurance?.receivedAt || null,
      billedAt: payment.insurance?.billedAt || null,
      authorizationCode: payment.insurance?.authorizationCode,
      specialty: payment.session?.specialty || payment.session?.sessionType || 'Outros'
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

      const guide = await InsuranceGuide.findOne({
        patientId: new mongoose.Types.ObjectId(patientId.toString()),
        specialty,
        status: { $in: ['active', 'linked'] },
        expiresAt: { $gte: session.date || new Date() },
        $expr: { $lt: ['$usedSessions', '$totalSessions'] }
      })
        .sort({ expiresAt: 1 })
        .session(mongoSession);

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

      const guide = await InsuranceGuide.findOne({
        patientId: new mongoose.Types.ObjectId(rawPatientId.toString()),
        specialty,
        status: { $in: ['active', 'linked'] },
        expiresAt: { $gte: session.date || new Date() },
        $expr: { $lt: ['$usedSessions', '$totalSessions'] }
      })
        .sort({ expiresAt: 1 })
        .lean();

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

    // ── Round 1: 3 fontes em paralelo ─────────────────────────────────
    const [batches, packages, avulsoPayments] = await Promise.all([
      InsuranceBatch.find(batchBaseFilter).lean(),
      Package.find(pkgFilter).populate('patient', 'fullName name phone').lean(),
      Payment.find(avulsoFilter).populate('patient', 'fullName name phone').lean()
    ]);

    // Appointment IDs presentes em algum batch (deduplicação JS — sem query extra)
    // IMPORTANTE: filter ANTES do String() — String(undefined) = "undefined" que é truthy
    const apptIdsInBatches = new Set(
      batches.flatMap(b => (b.sessions || [])
        .filter(s => s.appointment != null)
        .map(s => String(s.appointment)))
    );

    const batchApptOids  = [...apptIdsInBatches];
    const allPkgApptIds  = packages.flatMap(p => (p.appointments || []).filter(id => id && id !== 'undefined'));
    const avulsoApptIds  = avulsoPayments.map(p => p.appointment).filter(Boolean);

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

    // ── 3. AGRUPA por mês → provider → paciente → especialidade ──────
    const byMonth = {};

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
        const patName  = appt?.patientInfo?.fullName || appt?.patientInfo?.name || 'Desconhecido';
        const phone    = appt?.patientInfo?.phone || '';
        const specialty = appt?.specialty || 'outros';
        addEntry(mk, prov, patientId, patName, phone, specialty, s.grossAmount || 0, 'lote', batchStatus);
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
      const d  = new Date(serviceDate);
      if (d.getFullYear() !== filterYear) continue;
      const mk       = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const prov     = pmt.insurance.provider;
      const provLabel = prov.split('-').map((w) => w.charAt(0).toUpperCase()+w.slice(1)).join(' ')
        .replace('Saude', 'Saúde').replace('Anapolis', 'Anápolis');
      const patientId = pmt.patient?._id?.toString() || pmt.patientId?.toString() || null;
      const patName  = pmt.patient?.fullName || pmt.patient?.name || 'Desconhecido';
      const phone    = pmt.patient?.phone || '';
      const specialty = avulsoApptMap[String(pmt.appointment)]?.specialty || pmt.serviceType || 'outros';
      const insStatus = pmt.insurance?.status || 'pending_billing';
      const batchStatus = insStatus === 'received' ? 'received' : insStatus === 'billed' ? 'billed' : 'pending_batch';
      addEntry(mk, provLabel, patientId, patName, phone, specialty, pmt.amount, 'avulso', batchStatus);
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

    // ── 1) Sessões de convênio do paciente no mês ───────────────────────
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

    if (specialty) {
      sessionMatch.sessionType = specialty.toLowerCase().trim();
    }

    const [sessions, avulsoPayments] = await Promise.all([
      Session.find(sessionMatch)
        .populate('patient', 'fullName phone')
        .populate('doctor', 'fullName specialty')
        .populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions')
        .lean(),
      Payment.find({
        patient: patientOid,
        billingType: 'convenio',
        package: null,
        serviceDate: { $gte: start, $lte: end },
        status: { $nin: ['cancelled', 'canceled'] }
      }).lean()
    ]);

    const sessionIds = sessions.map(s => s._id);
    const appointmentIds = sessions.map(s => s.appointmentId).filter(Boolean);
    const avulsoAppointmentIds = avulsoPayments.map(p => p.appointment).filter(Boolean);
    const allAppointmentIds = [...new Set([...appointmentIds, ...avulsoAppointmentIds])].map(id => id.toString());

    // ── 2) Appointments e Payments relacionados ─────────────────────────
    const [appointments, payments, batches] = await Promise.all([
      allAppointmentIds.length
        ? Appointment.find({ _id: { $in: allAppointmentIds } })
            .select('_id patient specialty insuranceProvider insuranceGuide date patientInfo')
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

    // Sessões com guia/lote
    for (const session of sessions) {
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

      if (provider && sessionProvider.toLowerCase() !== provider.toLowerCase()) continue;
      if (status !== 'all' && billingStatus !== status) continue;

      result.push({
        sessionId,
        date: session.date,
        patient: session.patient,
        doctor: session.doctor,
        specialty: session.sessionType || appt?.specialty || session.insuranceGuide?.specialty || 'outros',
        provider: sessionProvider,
        guideNumber: session.insuranceGuide?.number || payment?.insurance?.authorizationCode || null,
        value: payment?.insurance?.grossAmount || payment?.amount || session.sessionValue || 0,
        billingStatus,
        batchId: batch?._id || session.billingBatchId || null,
        paymentId: payment?._id || null,
        appointmentId: session.appointmentId || null,
        source: 'lote'
      });
    }

    // Payments avulsos (sem sessão/package, ex: Bradesco antigo)
    for (const pmt of avulsoPayments) {
      const appt = apptById[pmt.appointment?.toString()];
      if (specialty && (appt?.specialty || pmt.serviceType || 'outros').toLowerCase() !== specialty.toLowerCase()) continue;

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
      if (provider && sessionProvider.toLowerCase() !== provider.toLowerCase()) continue;
      if (status !== 'all' && billingStatus !== status) continue;

      result.push({
        sessionId: sessionId || null,
        date: pmt.serviceDate || pmt.paymentDate,
        patient: pmt.patient,
        doctor: pmt.doctor,
        specialty: appt?.specialty || pmt.serviceType || 'outros',
        provider: sessionProvider,
        guideNumber: pmt.insurance?.authorizationCode || pmt.insurance?.guideNumber || null,
        value: pmt.insurance?.grossAmount || pmt.amount || 0,
        billingStatus,
        batchId: batch?._id || null,
        paymentId: pmt._id,
        appointmentId: pmt.appointment?.toString() || null,
        source: 'avulso'
      });
    }

    // Ordena por data
    result.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    res.json({ success: true, data: result, count: result.length });
  } catch (error) {
    console.error('[InsuranceV2][getPatientInsuranceSessions] Erro:', error.message);
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
  getInsuranceHistory,
  getPatientInsuranceSessions,
  autoLinkOrphanSessions,
  previewAutoLinkOrphanSessions,
  createGuideFromOrphan,
  linkOrphanSessionsToGuide
};
