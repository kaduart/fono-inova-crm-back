// back/services/insuranceBatchGuideAdapter.js
/**
 * InsuranceBatch Guide Adapter
 *
 * Adapta o modelo de faturamento de convênio de "sessão/payment" para "guia".
 * Recebe guideIds, resolve as sessões completed pendentes de faturamento e
 * devolve os parâmetros que insuranceBatchService.createBatch espera.
 *
 * Regra de ouro:
 *   Guia = unidade clínica de agrupamento
 *   InsuranceBatch = unidade financeira de envio ao convênio
 *   Sessão = detalhe de execução dentro da guia
 */

import mongoose from 'mongoose';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Session from '../models/Session.js';
import Payment from '../models/Payment.js';
import InsuranceCommunication from '../models/InsuranceCommunication.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import { createContextLogger } from '../utils/logger.js';


const logger = createContextLogger('InsuranceBatchGuideAdapter');

/**
 * Resolve um ObjectId a partir de string/ObjectId/número.
 */
function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (mongoose.Types.ObjectId.isValid(value)) return new mongoose.Types.ObjectId(value);
  return null;
}

/**
 * Resolve TODAS as sessões elegíveis a partir de um conjunto de guias.
 *
 * IMPORTANTE: Esta função NÃO filtra por mês. Ao faturar uma guia, todas as
 * sessões completed e ainda não faturadas daquela guia entram no lote,
 * independentemente do mês de competência. O mês é apenas filtro visual na
 * listagem (listGuidesPendingBilling).
 *
 * @param {string[]} guideIds - Array de InsuranceGuide._id (strings)
 * @param {Object} options
 * @param {mongoose.ClientSession} [options.mongoSession] - Sessão MongoDB para atomicidade
 * @returns {Promise<{
 *   provider: string,
 *   sessionIds: string[],
 *   startDate: Date,
 *   endDate: Date,
 *   guides: Array<{ guideId: string, number: string, sessionsCount: number }>,
 *   ignoredGuides: Array<{ guideId: string, number: string, reason: string }>
 * }>}
 */
export async function buildBatchFromGuides(guideIds, options = {}) {
  const { mongoSession } = options;

  if (!Array.isArray(guideIds) || guideIds.length === 0) {
    throw new Error('guideIds deve ser um array não vazio');
  }

  const validIds = guideIds
    .map(id => toObjectId(id))
    .filter(Boolean);

  if (validIds.length === 0) {
    throw new Error('Nenhum guideId válido fornecido');
  }

  // 1. Buscar guias
  const guides = await InsuranceGuide.find(
    { _id: { $in: validIds } },
    null,
    { session: mongoSession }
  ).lean();

  if (guides.length === 0) {
    throw new Error('Nenhuma guia encontrada para os IDs fornecidos');
  }

  // 2. Validar provider único (fase 1: um lote por provider)
  const providers = [...new Set(guides.map(g => g.insurance).filter(Boolean))];
  if (providers.length > 1) {
    throw new Error(
      `Guias selecionadas pertencem a convênios diferentes (${providers.join(', ')}). ` +
      'Selecione guias de um único convênio por lote.'
    );
  }

  const provider = providers[0] || 'convenio';

  // 2.1. Buscar Nota Fiscal da comunicação de faturamento mais recente vinculada às guias.
  // Por ora o lote armazena uma única NF (mesmo que várias guias). Futuramente,
  // se cada guia exigir NF distinta, o modelo deverá permitir NFs por sessão.
  const latestCommunication = await InsuranceCommunication.findOne({
    guideId: { $in: validIds },
    purpose: 'billing',
    status: 'sent'
  })
    .sort({ updatedAt: -1 })
    .select('invoiceNumber invoiceDate')
    .lean();

  const invoice = latestCommunication
    ? {
        invoiceNumber: latestCommunication.invoiceNumber,
        invoiceDate: latestCommunication.invoiceDate
      }
    : { invoiceNumber: null, invoiceDate: null };

  // 3. Buscar sessões completed, vinculadas às guias, ainda não faturadas
  const sessions = await Session.find({
    status: 'completed',
    insuranceGuide: { $in: validIds },
    $or: [
      { billingBatchId: { $exists: false } },
      { billingBatchId: null }
    ]
  }, null, { session: mongoSession })
    .sort({ date: 1 })
    .lean();

  // 4. Agrupar sessões por guia para metadados
  const sessionsByGuide = new Map();
  for (const session of sessions) {
    const guideId = session.insuranceGuide?.toString();
    if (!guideId) continue;
    if (!sessionsByGuide.has(guideId)) {
      sessionsByGuide.set(guideId, []);
    }
    sessionsByGuide.get(guideId).push(session);
  }

  const sessionIds = sessions.map(s => s._id.toString());

  if (sessionIds.length === 0) {
    throw new Error('Nenhuma sessão completed pendente de faturamento encontrada nas guias selecionadas');
  }

  const dates = sessions.map(s => s.date).filter(Boolean).sort((a, b) => a - b);
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  const guidesMeta = [];
  const ignoredGuides = [];

  for (const guide of guides) {
    const guideSessions = sessionsByGuide.get(guide._id.toString()) || [];
    if (guideSessions.length > 0) {
      guidesMeta.push({
        guideId: guide._id.toString(),
        number: guide.number,
        sessionsCount: guideSessions.length
      });
    } else {
      ignoredGuides.push({
        guideId: guide._id.toString(),
        number: guide.number,
        reason: 'Nenhuma sessão completed pendente de faturamento'
      });
    }
  }

  logger.info('Adapter resolved guide-based batch', {
    provider,
    guidesSelected: guides.length,
    sessionsEligible: sessionIds.length,
    startDate,
    endDate
  });

  return {
    provider,
    sessionIds,
    startDate,
    endDate,
    guides: guidesMeta,
    ignoredGuides,
    ...invoice
  };
}

/**
 * Resolve período de mês YYYY-MM como objetos Date.
 * Usa horário local (00:00 do 1º dia até 23:59:59 do último dia).
 */
function resolveMonthRange(month) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  return {
    start: new Date(y, m - 1, 1),
    end: new Date(y, m, 0, 23, 59, 59, 999)
  };
}

// Status de Payment que significam "já entrou no fluxo de faturamento" — não
// devem aparecer como pendente mesmo que Session.billingBatchId nunca tenha
// sido setado. Achado real 2026-07-20: sessões antigas (fluxo legado que só
// atualizava Payment.insurance.status, sem popular billingBatchId na Session)
// continuavam aparecendo como "a faturar" meses depois de já pagas — caso
// Davi Felipe Araújo, 19 de 41 sessões "pendentes" já billed/received.
const ALREADY_HANDLED_PAYMENT_STATUSES = ['billed', 'received', 'partial'];

/**
 * Sessões cujo Payment já mostra billed/received/partial não são pendentes de
 * faturamento, independente do estado de billingBatchId na Session.
 */
async function findAlreadyHandledSessionIds(sessionIds) {
  if (!sessionIds.length) return new Set();
  const payments = await Payment.find({
    session: { $in: sessionIds },
    $or: [
      { 'insurance.status': { $in: ALREADY_HANDLED_PAYMENT_STATUSES } },
      { status: { $in: ALREADY_HANDLED_PAYMENT_STATUSES } }
    ]
  }).select('session').lean();
  return new Set(payments.map(p => p.session?.toString()).filter(Boolean));
}

// Piso padrão da listagem de "A Faturar" quando nenhum período é passado
// explicitamente. Decisão de produto 2026-07-20: pendências anteriores a essa
// data são legado conhecido (Session.sessionValue nunca propagado da guia na
// criação, Unimed Anápolis ainda em billingMode per_month) — não aparecem mais
// na tela padrão. O dado continua intacto no banco, só não entra nesta query;
// quem passar month/startDate/endDate explicitamente ainda enxerga qualquer
// período, incluindo antes do corte.
const LEGACY_PENDING_CUTOFF = new Date('2026-05-01T00:00:00');

/**
 * Filtro de data flexível: aceita início sem fim (período aberto), os dois, ou
 * nenhum. `periodStart` sozinho é o caso comum agora que existe LEGACY_PENDING_CUTOFF.
 */
function buildDateFilter(start, end) {
  if (!start && !end) return null;
  const filter = {};
  if (start) filter.$gte = start;
  if (end) filter.$lte = end;
  return filter;
}

/**
 * Filtro Mongo para sessões de convênio (independentemente de terem guia).
 */
function buildConvenioMatch(prefix = '') {
  const field = (name) => (prefix ? `${prefix}.${name}` : name);
  return {
    $or: [
      { [field('billingType')]: 'convenio' },
      { [field('paymentMethod')]: 'convenio' },
      { [field('packageType')]: 'convenio' },
      { [field('paymentOrigin')]: 'convenio' },
      { [field('insuranceProvider')]: { $exists: true, $ne: null } },
      { [field('package')]: { $exists: true, $ne: null }, [field('insuranceGuide')]: { $exists: true, $ne: null } }
    ]
  };
}

/**
 * Lista guias que possuem ao menos uma sessão completed pendente de faturamento.
 *
 * O parâmetro `month` (YYYY-MM) filtra apenas a visualização: mostra guias que
 * tiveram sessões pendentes naquele mês. O faturamento em si, via
 * buildBatchFromGuides, sempre pega todas as sessões pendentes da guia.
 *
 * IMPORTANTE (achado 2026-07-20, caso Joaquim Rocha Simão): o filtro por `month`
 * é eliminatório, não apenas visual — sessões pendentes de faturamento em meses
 * anteriores ao selecionado somem da resposta e não aparecem em nenhuma outra
 * tela. Isso pode fazer a clínica esquecer de faturar convênio indefinidamente.
 * `includeOverdue: true` resolve isso trazendo, além da lista do mês
 * selecionado, um resumo agrupado por competência de tudo que ficou pendente
 * ANTES do período filtrado (guias e sessões órfãs).
 *
 * @param {Object} filters
 * @param {string} [filters.insurance] - Filtrar por convênio
 * @param {string} [filters.patientId] - Filtrar por paciente
 * @param {string} [filters.month] - Filtrar por mês (YYYY-MM) baseado na data da sessão
 * @param {Date} [filters.startDate] - Início do período (alternativa ao month)
 * @param {Date} [filters.endDate] - Fim do período (alternativa ao month)
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=50]
 * @param {boolean} [filters.includeOverdue=false] - Se true, inclui `overdue`/`overdueSummary` com pendências anteriores ao período filtrado
 * @returns {Promise<{ guides: Array, orphanSessions: Array, total: number, page: number, limit: number, overdue: Array|null, overdueSummary: Object|null }>}
 */
export async function listGuidesPendingBilling(filters = {}) {
  const { insurance, patientId, month, startDate, endDate, page = 1, limit = 50, includeOverdue = false } = filters;

  // Resolver período
  let periodStart = startDate ? new Date(startDate) : null;
  let periodEnd = endDate ? new Date(endDate) : null;
  const monthRange = resolveMonthRange(month);
  if (monthRange) {
    periodStart = monthRange.start;
    periodEnd = monthRange.end;
  }

  // Sem período explícito: aplica o piso de legado por padrão (ver LEGACY_PENDING_CUTOFF).
  // Quem pedir um período explicitamente (month/startDate/endDate) continua vendo
  // qualquer data, incluindo antes do corte — o piso é só o comportamento default.
  if (!month && !startDate && !endDate) {
    periodStart = LEGACY_PENDING_CUTOFF;
  }

  logger.info('listGuidesPendingBilling start', { month, periodStart, periodEnd, insurance, patientId, page, limit });

  // Pipeline: encontrar guias que têm ao menos uma sessão elegível
  const guideMatch = {};
  if (insurance) guideMatch.insurance = insurance.toLowerCase();
  if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
    guideMatch.patientId = new mongoose.Types.ObjectId(patientId);
  }

  // Buscar sessões elegíveis por guia
  const sessionMatch = {
    status: 'completed',
    $or: [
      { billingBatchId: { $exists: false } },
      { billingBatchId: null }
    ]
  };

  const mainDateFilter = buildDateFilter(periodStart, periodEnd);
  if (mainDateFilter) {
    sessionMatch.date = mainDateFilter;
  }

  // Só considera sessões de convênio (com ou sem guia)
  const convenioMatch = buildConvenioMatch();
  sessionMatch.$and = [convenioMatch];

  // Exclui sessões cujo Payment já mostra billed/received/partial (fluxo legado
  // que não seta billingBatchId na Session — ver findAlreadyHandledSessionIds).
  const candidateIds = await Session.find(sessionMatch).select('_id').lean();
  const handledIds = await findAlreadyHandledSessionIds(candidateIds.map(c => c._id));
  if (handledIds.size > 0) {
    sessionMatch._id = { $nin: [...handledIds].map(id => new mongoose.Types.ObjectId(id)) };
  }

  const guidesWithPending = await Session.aggregate([
    { $match: sessionMatch },
    {
      $group: {
        _id: '$insuranceGuide',
        sessionsCount: { $sum: 1 },
        totalValue: { $sum: { $ifNull: ['$sessionValue', 0] } },
        minDate: { $min: '$date' },
        maxDate: { $max: '$date' }
      }
    },
    { $match: { _id: { $ne: null } } }
  ]);

  const guideIds = guidesWithPending.map(g => g._id);
  if (guideIds.length === 0) {
    logger.info('listGuidesPendingBilling: no guides with pending sessions');
    return { guides: [], orphanSessions: [], total: 0, page, limit };
  }

  guideMatch._id = { $in: guideIds };

  const allGuides = await InsuranceGuide.find(guideMatch)
    .populate('patientId', 'fullName')
    .sort({ createdAt: -1 })
    .lean();

  // Nota: uma guia pode estar superseded/cancelled/expired e ainda possuir sessões
  // already completed pendentes de faturamento. O faturamento deve considerar essas
  // sessões, não o lifecycle de elegibilidade para novas sessões.
  const total = allGuides.length;
  const guides = allGuides.slice((page - 1) * limit, page * limit);

  const pendingByGuide = new Map(guidesWithPending.map(g => [g._id.toString(), g]));

  // Buscar detalhes individuais das sessões pendentes de cada guia
  const sessionDetailMatch = {
    status: 'completed',
    insuranceGuide: { $in: guideIds },
    $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }]
  };
  if (mainDateFilter) sessionDetailMatch.date = mainDateFilter;
  if (handledIds.size > 0) {
    sessionDetailMatch._id = { $nin: [...handledIds].map(id => new mongoose.Types.ObjectId(id)) };
  }

  const sessionDetails = await Session.find(sessionDetailMatch)
    .select('_id insuranceGuide date sessionValue specialty doctor')
    .populate('doctor', 'fullName')
    .sort({ date: 1 })
    .lean();

  const sessionsByGuide = new Map();
  for (const s of sessionDetails) {
    const gid = s.insuranceGuide?.toString();
    if (!gid) continue;
    if (!sessionsByGuide.has(gid)) sessionsByGuide.set(gid, []);
    sessionsByGuide.get(gid).push({
      sessionId: s._id.toString(),
      date: s.date,
      doctorName: s.doctor?.fullName || null,
      specialty: s.specialty || null,
      value: s.sessionValue || 0
    });
  }

  // Documentação (guia + lista de presença) já enviada por e-mail ao convênio,
  // via BillingCommunicationWizard — não significa faturado (billingBatchId),
  // só que a etapa de envio já ocorreu. Sem isso, a tela não distingue "nunca
  // mexi nessa guia" de "já mandei e-mail, falta criar o lote".
  const sentCommunications = await InsuranceCommunication.find({
    guideId: { $in: guides.map(g => g._id) },
    purpose: 'billing',
    status: 'sent'
  }).select('guideId invoiceNumber updatedAt').sort({ updatedAt: -1 }).lean();
  const documentationSentAtByGuide = new Map();
  const invoiceNumberByGuide = new Map();
  for (const comm of sentCommunications) {
    const gid = comm.guideId?.toString();
    if (gid) {
      if (!documentationSentAtByGuide.has(gid)) {
        documentationSentAtByGuide.set(gid, comm.updatedAt);
      }
      if (comm.invoiceNumber && !invoiceNumberByGuide.has(gid)) {
        invoiceNumberByGuide.set(gid, comm.invoiceNumber);
      }
    }
  }

  // Guia pode estar parcialmente faturada: parte das sessões já entrou num lote
  // anterior, e só a sobra (sessão nova ou esquecida) aparece como pendente aqui.
  // Sem isso, o card não distingue "nunca faturada" de "sobrou 1 sessão de um
  // lote de 15" — achado real 2026-07-21 (guia 15650231: 12 sessões já em 3
  // lotes `sent`, 1 sessão de 04/05 esquecida fora de todos eles).
  const billedSessions = await Session.find({
    insuranceGuide: { $in: guides.map(g => g._id) },
    billingBatchId: { $ne: null }
  }).select('insuranceGuide billingBatchId').lean();

  const billedBatchIds = [...new Set(billedSessions.map(s => s.billingBatchId?.toString()).filter(Boolean))];
  const batches = billedBatchIds.length
    ? await InsuranceBatch.find({ _id: { $in: billedBatchIds } }).select('createdAt').lean()
    : [];
  const batchCreatedAtById = new Map(batches.map(b => [b._id.toString(), b.createdAt]));

  const billingStatsByGuide = new Map();
  for (const s of billedSessions) {
    const gid = s.insuranceGuide?.toString();
    if (!gid) continue;
    const stats = billingStatsByGuide.get(gid) || { count: 0, lastBatchSentAt: null };
    stats.count += 1;
    const batchDate = batchCreatedAtById.get(s.billingBatchId?.toString());
    if (batchDate && (!stats.lastBatchSentAt || batchDate > stats.lastBatchSentAt)) {
      stats.lastBatchSentAt = batchDate;
    }
    billingStatsByGuide.set(gid, stats);
  }

  // Pagamentos já recebidos do convênio para as guias listadas. Usado para
  // derivar o estado "Recebida" sem depender de campo mutável na guia.
  const receivedPayments = await Payment.find({
    insuranceGuide: { $in: guideIds },
    billingType: 'convenio',
    'insurance.status': 'received'
  }).select('insuranceGuide').lean();
  const receivedGuideIds = new Set(receivedPayments.map(p => p.insuranceGuide?.toString()).filter(Boolean));

  const enrichedGuides = guides.map(guide => {
    const pending = pendingByGuide.get(guide._id.toString()) || { sessionsCount: 0, totalValue: 0 };
    const sessions = sessionsByGuide.get(guide._id.toString()) || [];
    const billingMode = guide.billingMode || 'per_month';
    const billingStats = billingStatsByGuide.get(guide._id.toString()) || { count: 0, lastBatchSentAt: null };

    const hasSentCommunication = documentationSentAtByGuide.has(guide._id.toString());
    const hasBilledSession = billingStats.count > 0;
    const hasReceivedPayment = receivedGuideIds.has(guide._id.toString());
    const isClosed = !!guide.closedAt;
    const hasPendingSessions = pending.sessionsCount > 0;

    const billingState = deriveGuideBillingState(guide, {
      hasSentCommunication,
      hasBilledSession,
      hasReceivedPayment,
      isClosed,
      hasPendingSessions
    });

    // "A faturar" deve refletir apenas o valor das sessões já realizadas e
    // pendentes de faturamento no período filtrado, independente do modo de
    // faturamento da guia. Não deve incluir sessões futuras nem o valor total
    // autorizado da guia.
    //
    // Sempre preferimos pending.totalValue (soma dos sessionValue das sessões
    // pendentes), pois uma mesma guia pode ter sessões com valores diferentes.
    // O fallback por multiplicação existe apenas para dados antigos em que o
    // campo sessionValue não foi propagado para as sessões.
    const pendingValue =
      pending.totalValue ??
      (pending.sessionsCount * (guide.sessionValue || 0));

    return {
      guideId: guide._id.toString(),
      number: guide.number,
      insurance: guide.insurance,
      specialty: guide.specialty,
      patient: guide.patientId,
      totalSessions: guide.totalSessions,
      usedSessions: guide.usedSessions,
      remaining: guide.totalSessions - guide.usedSessions,
      sessionValue: guide.sessionValue,
      billingMode,
      totalAuthorizedValue: guide.totalAuthorizedValue || null,
      sessionsThisMonth: pending.sessionsCount,
      pendingSessions: pending.sessionsCount,
      pendingValue,
      firstSessionDate: pending.minDate,
      lastSessionDate: pending.maxDate,
      documentationSentAt: documentationSentAtByGuide.get(guide._id.toString()) || null,
      invoiceNumber: invoiceNumberByGuide.get(guide._id.toString()) || null,
      alreadyBilledSessions: billingStats.count,
      lastBatchSentAt: billingStats.lastBatchSentAt,
      guideStatus: guide.status,
      billingState,
      sessions
    };
  });

  // Sessões órfãs: convenio completed sem guia vinculada na Session.
  //
  // ATENÇÃO: "órfã" aqui significa session.insuranceGuide = null. Isso NÃO implica
  // ausência de guia no appointment ou no payment — o vínculo pode existir nesses
  // modelos e estar ausente apenas na Session (rastreabilidade perdida).
  //
  // Causa histórica (pré-jun/2026): o fluxo de conclusão preenchia appointment.insuranceGuide
  // e payment.insurance.guideId mas não propagava para session.insuranceGuide.
  // Em jun/2026, 40 sessões foram corrigidas via backfill. Se aparecerem "órfãs" novamente,
  // verificar PRIMEIRO se appointment.insuranceGuide está preenchido antes de concluir
  // que a guia está realmente ausente.
  //
  // Filtro preciso (paymentMethod/billingType = 'convenio') evita que sessões
  // particulares com insuranceProvider="" entrem indevidamente.
  const orphanMatch = {
    status: 'completed',
    $or: [{ paymentMethod: 'convenio' }, { billingType: 'convenio' }],
    $and: [
      { $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }] },
      { $or: [{ insuranceGuide: { $exists: false } }, { insuranceGuide: null }] }
    ]
  };
  if (mainDateFilter) orphanMatch.date = mainDateFilter;

  const orphanSessions = await Session.find(orphanMatch)
    .populate('patient', 'fullName')
    .populate('package', 'insuranceProvider')
    .populate('appointmentId', 'specialty insuranceProvider')
    .sort({ date: 1 })
    .lean();

  // Busca payments dessas sessions para pegar insurance.provider e dados financeiros
  const orphanSessionIds = orphanSessions.map(s => s._id);
  const orphanPayments = orphanSessionIds.length
    ? await Payment.find({
        session: { $in: orphanSessionIds },
        billingType: 'convenio'
      }).select('session insurance sessionType package amount status').populate('package', 'insuranceProvider').lean()
    : [];

  const paymentBySession = new Map(orphanPayments.map(p => [p.session?.toString(), p]));

  // Mesma exclusão do fluxo principal: órfã cujo Payment já mostra
  // billed/received/partial não é pendente de faturamento.
  const orphanSessionsFiltered = orphanSessions.filter(session => {
    const payment = paymentBySession.get(session._id.toString());
    const payStatus = payment?.insurance?.status || payment?.status;
    return !ALREADY_HANDLED_PAYMENT_STATUSES.includes(payStatus);
  });

  const enrichedOrphans = orphanSessionsFiltered.map(session => {
    const payment = paymentBySession.get(session._id.toString());
    return {
      paymentId: payment?._id?.toString() || null,
      sessionId: session._id.toString(),
      date: session.date,
      patient: session.patient,
      specialty: session.specialty || session.appointmentId?.specialty || payment?.sessionType || 'Outros',
      sessionValue: payment?.insurance?.grossAmount || payment?.amount || session.sessionValue || 0,
      authorizationCode: payment?.insurance?.authorizationCode || null,
      insuranceProvider:
        payment?.insurance?.provider ||
        session.package?.insuranceProvider ||
        payment?.package?.insuranceProvider ||
        session.appointmentId?.insuranceProvider ||
        'nao_identificado'
    };
  });

  // Segunda passagem: inferir provider pelo paciente
  // Se um paciente tem sessões com provider conhecido E sessões sem, unifica tudo no mesmo provider
  const patientProviderMap = new Map();
  for (const s of enrichedOrphans) {
    if (s.insuranceProvider !== 'nao_identificado') {
      const pid = s.patient?._id?.toString();
      if (pid && !patientProviderMap.has(pid)) {
        patientProviderMap.set(pid, s.insuranceProvider);
      }
    }
  }
  for (const s of enrichedOrphans) {
    if (s.insuranceProvider === 'nao_identificado') {
      const pid = s.patient?._id?.toString();
      const inferred = pid ? patientProviderMap.get(pid) : null;
      if (inferred) s.insuranceProvider = inferred;
    }
  }

  // Pendências de competências anteriores ao período filtrado. Só faz sentido
  // quando há um período de referência (month/startDate+endDate) — sem período,
  // a própria listagem já é "tudo", não há "antes" para comparar.
  let overdue = null;
  let overdueSummary = null;
  if (includeOverdue && periodStart) {
    overdue = await buildOverdueBuckets({ periodStart, insurance, patientId });
    overdueSummary = {
      totalValue: overdue.reduce((sum, bucket) => sum + bucket.totalValue, 0),
      totalSessions: overdue.reduce((sum, bucket) => sum + bucket.sessionsCount, 0),
      competenceCount: overdue.length
    };
  }

  // Achado 2026-07-27: a listagem (guides/orphanSessions) é deliberadamente sem
  // escopo de mês — o operacional pensa em "guia", não em competência, e uma
  // guia com sessão de junho e julho não pode virar duas linhas na tela. Mas o
  // "Resumo do mês" da tela precisa saber quanto do total pendente é do mês
  // corrente vs. backlog de meses anteriores, sem recomputar isso no frontend
  // (KPI financeiro é sempre computado no backend). Por isso essa quebra usa o
  // MESMO conjunto de sessões que já compõe `guides`/`orphanSessions` — decompõe
  // o total pra exibição, não filtra nem duplica nenhuma guia.
  const currentCompetence = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  let currentCompetenceValue = 0;
  let currentCompetenceSessions = 0;
  let previousCompetenceValue = 0;
  let previousCompetenceSessions = 0;
  for (const guide of enrichedGuides) {
    for (const session of guide.sessions || []) {
      const competence = new Date(session.date).toISOString().slice(0, 7);
      if (competence === currentCompetence) {
        currentCompetenceValue += session.value || 0;
        currentCompetenceSessions += 1;
      } else {
        previousCompetenceValue += session.value || 0;
        previousCompetenceSessions += 1;
      }
    }
  }
  for (const orphan of enrichedOrphans) {
    const competence = new Date(orphan.date).toISOString().slice(0, 7);
    if (competence === currentCompetence) {
      currentCompetenceValue += orphan.sessionValue || 0;
      currentCompetenceSessions += 1;
    } else {
      previousCompetenceValue += orphan.sessionValue || 0;
      previousCompetenceSessions += 1;
    }
  }
  const competenceBreakdown = {
    referenceMonth: currentCompetence,
    current: { value: currentCompetenceValue, sessions: currentCompetenceSessions },
    previous: { value: previousCompetenceValue, sessions: previousCompetenceSessions }
  };

  logger.info('listGuidesPendingBilling done', {
    guidesFound: enrichedGuides.length,
    orphanSessionsFound: enrichedOrphans.length,
    total,
    overdueCompetences: overdue?.length ?? null,
    competenceBreakdown
  });

  return {
    guides: enrichedGuides,
    orphanSessions: enrichedOrphans,
    total,
    page,
    limit,
    overdue,
    overdueSummary,
    competenceBreakdown
  };
}

/**
 * Agrupa por competência (YYYY-MM) tudo que ficou pendente de faturamento
 * ANTES de `periodStart` — tanto sessões vinculadas a guia quanto órfãs
 * (session.insuranceGuide null, ver nota em listGuidesPendingBilling sobre
 * `orphanSessions`). Sem paginação: é um resumo de alerta, não uma listagem
 * de trabalho.
 *
 * Sessões órfãs só entram no resumo quando nenhum filtro de `insurance` está
 * ativo — sem guia vinculada, o provider real exige a mesma heurística de
 * inferência usada em `enrichedOrphans`, e replicá-la aqui só pra filtrar por
 * convênio específico não vale a complexidade adicional neste resumo.
 */
async function buildOverdueBuckets({ periodStart, insurance, patientId }) {
  const guideMatch = {};
  if (insurance) guideMatch.insurance = insurance.toLowerCase();
  if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
    guideMatch.patientId = new mongoose.Types.ObjectId(patientId);
  }

  const baseSessionMatch = {
    status: 'completed',
    $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }],
    date: { $lt: periodStart },
    $and: [buildConvenioMatch()]
  };

  // Mesma exclusão de listGuidesPendingBilling: Payment já billed/received/partial
  // não é pendente, mesmo sem billingBatchId setado na Session (fluxo legado).
  const overdueCandidateIds = await Session.find(baseSessionMatch).select('_id').lean();
  const overdueHandledIds = await findAlreadyHandledSessionIds(overdueCandidateIds.map(c => c._id));
  if (overdueHandledIds.size > 0) {
    baseSessionMatch._id = { $nin: [...overdueHandledIds].map(id => new mongoose.Types.ObjectId(id)) };
  }

  const buckets = new Map(); // competence (YYYY-MM) -> { competence, sessionsCount, totalValue, guides: [], orphanSessions: [] }
  const getBucket = (competence) => {
    if (!buckets.has(competence)) {
      buckets.set(competence, { competence, sessionsCount: 0, totalValue: 0, guides: [], orphanSessions: [] });
    }
    return buckets.get(competence);
  };

  // 1. Sessões vinculadas a guia
  const guidePendingAgg = await Session.aggregate([
    { $match: { ...baseSessionMatch, insuranceGuide: { $ne: null } } },
    {
      $group: {
        _id: { guide: '$insuranceGuide', competence: { $dateToString: { format: '%Y-%m', date: '$date' } } },
        sessionsCount: { $sum: 1 },
        totalValue: { $sum: { $ifNull: ['$sessionValue', 0] } },
        minDate: { $min: '$date' },
        maxDate: { $max: '$date' }
      }
    }
  ]);

  if (guidePendingAgg.length > 0) {
    const guideIds = [...new Set(guidePendingAgg.map(row => row._id.guide.toString()))]
      .map(id => new mongoose.Types.ObjectId(id));
    const guides = await InsuranceGuide.find({ _id: { $in: guideIds }, ...guideMatch })
      .populate('patientId', 'fullName')
      .lean();
    const guideById = new Map(guides.map(g => [g._id.toString(), g]));

    for (const row of guidePendingAgg) {
      const guideId = row._id.guide.toString();
      const guide = guideById.get(guideId);
      if (!guide) continue; // filtrado por insurance/patientId
      const bucket = getBucket(row._id.competence);
      bucket.sessionsCount += row.sessionsCount;
      bucket.totalValue += row.totalValue;
      bucket.guides.push({
        guideId,
        number: guide.number,
        insurance: guide.insurance,
        specialty: guide.specialty,
        patient: guide.patientId,
        sessionsCount: row.sessionsCount,
        totalValue: row.totalValue,
        firstSessionDate: row.minDate,
        lastSessionDate: row.maxDate
      });
    }
  }

  // 2. Sessões órfãs (sem guia vinculada na Session) — só quando não há filtro de convênio ativo
  if (!insurance) {
    const orphanMatch = {
      status: 'completed',
      $or: [{ paymentMethod: 'convenio' }, { billingType: 'convenio' }],
      date: { $lt: periodStart },
      $and: [
        { $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }] },
        { $or: [{ insuranceGuide: { $exists: false } }, { insuranceGuide: null }] }
      ]
    };
    if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
      orphanMatch.patient = new mongoose.Types.ObjectId(patientId);
    }

    const orphanSessions = await Session.find(orphanMatch)
      .populate('patient', 'fullName')
      .select('_id date patient sessionValue specialty')
      .sort({ date: 1 })
      .lean();

    const orphanHandledIds = await findAlreadyHandledSessionIds(orphanSessions.map(s => s._id));

    for (const session of orphanSessions) {
      if (orphanHandledIds.has(session._id.toString())) continue;
      const competence = session.date.toISOString().slice(0, 7);
      const bucket = getBucket(competence);
      const value = session.sessionValue || 0;
      bucket.sessionsCount += 1;
      bucket.totalValue += value;
      bucket.orphanSessions.push({
        sessionId: session._id.toString(),
        date: session.date,
        patient: session.patient,
        specialty: session.specialty || null,
        sessionValue: value
      });
    }
  }

  return [...buckets.values()].sort((a, b) => a.competence.localeCompare(b.competence));
}

export const GuideBillingState = {
  PENDING: 'pending',
  DOCUMENTATION_SENT: 'documentation_sent',
  BILLED: 'billed',
  RECEIVED: 'received',
  CLOSED: 'closed'
};

/**
 * Deriva o estado de faturamento de uma guia a partir dos eventos reais registrados
 * no sistema. Não há campo mutável `billingStatus` em InsuranceGuide; o estado é
 * inferido para evitar inconsistências entre UI e banco.
 *
 * Uma guia per_guide fica aberta por meses e é faturada em ciclos sucessivos —
 * não existe faturamento único no fechamento. Achado real 2026-07-27 (caso
 * Benjamim Rocha Simão, guia 16145509): sessões de jun/2026 entraram num lote
 * legado, mas 14 sessões novas (inclusive jul/2026) nunca foram batched. Com
 * `hasBilledSession` decidindo antes de olhar pendência, a guia virava BILLED
 * pra sempre a partir do primeiro lote e sumia das abas "A Faturar"/"Aguardando
 * Faturamento" — mesmo com sessões reais aguardando ação. O mesmo vale pra
 * RECEIVED: pagamento recebido de um ciclo anterior não significa que não haja
 * sessão nova pendente agora.
 *
 * Por isso "existe sessão pendente?" é a primeira pergunta, não a última —
 * histórico de faturamento (billed/received) só decide o estado quando não
 * sobra nenhuma sessão pendente no momento.
 *
 * NÃO adicione um `if (hasBilledSession) return BILLED` (ou equivalente para
 * RECEIVED) ANTES do check de `hasPendingSessions` — foi exatamente essa
 * ordem que causou a regressão acima. "Já faturou alguma vez" e "terminou de
 * faturar" são estados diferentes; só o segundo pode aposentar a guia das
 * abas de pendência.
 *
 *   isClosed?
 *     └── sim -> CLOSED (fechamento é definitivo, vence mesmo com pendência)
 *     └── não -> hasPendingSessions?
 *           ├── sim -> hasSentCommunication? DOCUMENTATION_SENT : PENDING
 *           └── não -> hasReceivedPayment?
 *                 ├── sim -> RECEIVED
 *                 └── não -> hasBilledSession? BILLED : PENDING
 */
export function deriveGuideBillingState(guide, { hasSentCommunication, hasBilledSession, hasReceivedPayment, isClosed, hasPendingSessions }) {
  if (isClosed) return GuideBillingState.CLOSED;
  if (hasPendingSessions) return hasSentCommunication ? GuideBillingState.DOCUMENTATION_SENT : GuideBillingState.PENDING;
  if (hasReceivedPayment) return GuideBillingState.RECEIVED;
  if (hasBilledSession) return GuideBillingState.BILLED;
  return GuideBillingState.PENDING;
}

export default {
  buildBatchFromGuides,
  listGuidesPendingBilling,
  deriveGuideBillingState,
  GuideBillingState
};
