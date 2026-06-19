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
    ignoredGuides
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
 * @param {Object} filters
 * @param {string} [filters.insurance] - Filtrar por convênio
 * @param {string} [filters.patientId] - Filtrar por paciente
 * @param {string} [filters.month] - Filtrar por mês (YYYY-MM) baseado na data da sessão
 * @param {Date} [filters.startDate] - Início do período (alternativa ao month)
 * @param {Date} [filters.endDate] - Fim do período (alternativa ao month)
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=50]
 * @returns {Promise<{ guides: Array, orphanSessions: Array, total: number, page: number, limit: number }>}
 */
export async function listGuidesPendingBilling(filters = {}) {
  const { insurance, patientId, month, startDate, endDate, page = 1, limit = 50 } = filters;

  // Resolver período
  let periodStart = startDate ? new Date(startDate) : null;
  let periodEnd = endDate ? new Date(endDate) : null;
  const monthRange = resolveMonthRange(month);
  if (monthRange) {
    periodStart = monthRange.start;
    periodEnd = monthRange.end;
  }

  logger.info('listGuidesPendingBilling start', { month, periodStart, periodEnd, insurance, patientId, page, limit });

  // Pipeline: encontrar guias que têm ao menos uma sessão elegível
  const guideMatch = {};
  if (insurance) guideMatch.insurance = insurance.toLowerCase();
  if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
    guideMatch.patientId = new mongoose.Types.ObjectId(patientId);
  }

  // Status elegíveis: active, linked, exhausted. Cancelled/expired não entram.
  guideMatch.status = { $in: ['active', 'linked', 'exhausted'] };

  // Buscar sessões elegíveis por guia
  const sessionMatch = {
    status: 'completed',
    $or: [
      { billingBatchId: { $exists: false } },
      { billingBatchId: null }
    ]
  };

  if (periodStart && periodEnd) {
    sessionMatch.date = { $gte: periodStart, $lte: periodEnd };
  }

  // Só considera sessões de convênio (com ou sem guia)
  const convenioMatch = buildConvenioMatch();
  sessionMatch.$and = [convenioMatch];

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

  const total = await InsuranceGuide.countDocuments(guideMatch);

  const guides = await InsuranceGuide.find(guideMatch)
    .populate('patientId', 'fullName')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const pendingByGuide = new Map(guidesWithPending.map(g => [g._id.toString(), g]));

  // Buscar detalhes individuais das sessões pendentes de cada guia
  const sessionDetailMatch = {
    status: 'completed',
    insuranceGuide: { $in: guideIds },
    $or: [{ billingBatchId: { $exists: false } }, { billingBatchId: null }]
  };
  if (periodStart && periodEnd) sessionDetailMatch.date = { $gte: periodStart, $lte: periodEnd };

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

  const enrichedGuides = guides.map(guide => {
    const pending = pendingByGuide.get(guide._id.toString()) || { sessionsCount: 0, totalValue: 0 };
    const sessions = sessionsByGuide.get(guide._id.toString()) || [];
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
      pendingSessions: pending.sessionsCount,
      pendingValue: pending.totalValue || (pending.sessionsCount * (guide.sessionValue || 0)),
      firstSessionDate: pending.minDate,
      lastSessionDate: pending.maxDate,
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
  if (periodStart && periodEnd) orphanMatch.date = { $gte: periodStart, $lte: periodEnd };

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

  const enrichedOrphans = orphanSessions.map(session => {
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

  logger.info('listGuidesPendingBilling done', {
    guidesFound: enrichedGuides.length,
    orphanSessionsFound: enrichedOrphans.length,
    total
  });

  return {
    guides: enrichedGuides,
    orphanSessions: enrichedOrphans,
    total,
    page,
    limit
  };
}

export default {
  buildBatchFromGuides,
  listGuidesPendingBilling
};
