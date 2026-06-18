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
import { createContextLogger } from '../utils/logger.js';

const logger = createContextLogger('InsuranceBatchGuideAdapter');

/**
 * Resolve sessões elegíveis a partir de um conjunto de guias.
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
    .filter(id => mongoose.Types.ObjectId.isValid(id))
    .map(id => new mongoose.Types.ObjectId(id));

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
 * Lista guias que possuem ao menos uma sessão completed pendente de faturamento.
 *
 * @param {Object} filters
 * @param {string} [filters.insurance] - Filtrar por convênio
 * @param {string} [filters.patientId] - Filtrar por paciente
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=50]
 * @returns {Promise<{ guides: Array, total: number, page: number, limit: number }>}
 */
export async function listGuidesPendingBilling(filters = {}) {
  const { insurance, patientId, page = 1, limit = 50 } = filters;

  // Pipeline: encontrar guias que têm ao menos uma sessão elegível
  const matchStage = {};
  if (insurance) matchStage.insurance = insurance.toLowerCase();
  if (patientId && mongoose.Types.ObjectId.isValid(patientId)) {
    matchStage.patientId = new mongoose.Types.ObjectId(patientId);
  }

  // Status elegíveis: active, linked, exhausted. Cancelled/expired não entram.
  matchStage.status = { $in: ['active', 'linked', 'exhausted'] };

  // Buscar sessões elegíveis por guia
  const sessionMatch = {
    status: 'completed',
    $or: [
      { billingBatchId: { $exists: false } },
      { billingBatchId: null }
    ]
  };

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
    return { guides: [], total: 0, page, limit };
  }

  matchStage._id = { $in: guideIds };

  const total = await InsuranceGuide.countDocuments(matchStage);

  const guides = await InsuranceGuide.find(matchStage)
    .populate('patientId', 'fullName')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const pendingByGuide = new Map(guidesWithPending.map(g => [g._id.toString(), g]));

  const enrichedGuides = guides.map(guide => {
    const pending = pendingByGuide.get(guide._id.toString()) || { sessionsCount: 0, totalValue: 0 };
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
      lastSessionDate: pending.maxDate
    };
  });

  return {
    guides: enrichedGuides,
    total,
    page,
    limit
  };
}

export default {
  buildBatchFromGuides,
  listGuidesPendingBilling
};
