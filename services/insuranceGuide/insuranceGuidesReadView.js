// back/services/insuranceGuide/insuranceGuidesReadView.js
/**
 * Insurance Guides Read View — fonte de leitura composta da aba Convênios.
 *
 * SOMENTE LEITURA. Não escreve, não recalcula valor financeiro, não muda status.
 *
 * Substitui a leitura de listGuidesPendingBilling, que parte da sessão pendente e
 * por isso perde toda guia já faturada (59 de 112 guias em prod, 2026-08-07).
 * Aqui o universo é a GUIA: toda guia existente aparece, sempre.
 *
 * Regra de ouro (auditoria 2026-08-07):
 *   A unidade do ciclo financeiro é a SESSÃO, não a guia.
 *   A guia é contêiner operacional e pode ter sessões em fases diferentes ao
 *   mesmo tempo — 9 guias em prod estão nesse estado (billingMode 'per_month',
 *   faturamento mês a mês). Por isso a verdade vive nos CONTADORES por fase.
 *   `billingState` é só rótulo visual; mistura NÃO é rótulo, é a característica
 *   `hasMixedStates` — ver decisão em GuideBillingLabel.
 *
 * Fontes e responsabilidades (inalteradas):
 *   Payment                → SSOT financeiro (valor, billedAt, receivedAt)
 *   InsuranceGuide.status  → ciclo de vida da autorização, nunca faturamento
 *   InsuranceCommunication → controle de envio de documentação
 *   InsuranceBatch         → unidade de envio ao convênio
 *
 * Composição em tempo de consulta, sem materializar projeção: o volume é
 * trivial (112 guias, 710 sessões, 720 payments, 22 lotes em prod 2026-08-07)
 * e os models de projeção InsuranceGuideView/insurance_guides_view estão mortos
 * (zero imports, zero documentos). Reavaliar só se o volume crescer ~100x.
 */

import mongoose from 'mongoose';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import InsuranceCommunication from '../../models/InsuranceCommunication.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import { createContextLogger } from '../../utils/logger.js';

const logger = createContextLogger('InsuranceGuidesReadView');

/**
 * Fases do ciclo financeiro. Vivem na SESSÃO.
 * A ordem aqui é a ordem de avanço do ciclo e é usada como precedência.
 */
export const SessionPhase = {
  PENDING_BILLING: 'pendingBilling',
  DOCUMENTATION_SENT: 'documentationSent',
  BILLED: 'billed',
  RECEIVED: 'received'
};

const PHASE_ORDER = [
  SessionPhase.PENDING_BILLING,
  SessionPhase.DOCUMENTATION_SENT,
  SessionPhase.BILLED,
  SessionPhase.RECEIVED
];

/**
 * Rótulos de `billingState`. NÃO é fonte de verdade — é resumo visual.
 *
 * Decisão 2026-08-07: não existe rótulo 'mixed'. Mistura é CARACTERÍSTICA da
 * guia, não estado de negócio — expressa por `hasMixedStates` + os contadores.
 * Um valor 'mixed' aqui viraria, em poucos meses, mais um case de switch e um
 * estado oficial paralelo aos contadores.
 */
export const GuideBillingLabel = {
  NO_SESSIONS: 'no_sessions',
  PENDING: 'pending',
  DOCUMENTATION_SENT: 'documentation_sent',
  BILLED: 'billed',
  RECEIVED: 'received',
  CLOSED: 'closed'
};

const CANCELED_PAYMENT_STATUSES = ['canceled', 'cancelled'];

// ─────────────────────────────────────────────────────────────────────────────
// Funções puras — testáveis sem banco
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extrai ObjectId de campo que pode vir populado, como ObjectId ou como string.
 * Padrão do projeto: nunca .toString() direto em objeto populado.
 */
export function idOf(value) {
  if (!value) return null;
  return (value?._id || value)?.toString?.() || null;
}

/**
 * Valor financeiro de uma sessão. Payment é SSOT; sessão e guia são fallback
 * apenas para dados antigos em que sessionValue nunca foi propagado.
 */
export function resolveSessionValue(session, payment, guide) {
  const gross = payment?.insurance?.grossAmount;
  if (typeof gross === 'number' && gross > 0) return gross;
  if (typeof payment?.amount === 'number' && payment.amount > 0) return payment.amount;
  if (typeof session?.sessionValue === 'number' && session.sessionValue > 0) return session.sessionValue;
  if (typeof guide?.sessionValue === 'number' && guide.sessionValue > 0) return guide.sessionValue;
  return 0;
}

/**
 * Fase de UMA sessão. Precedência do mais avançado para o menos avançado.
 *
 * `billed` aceita duas evidências independentes porque o fluxo legado nem sempre
 * gravou billingBatchId na Session (ver findAlreadyHandledSessionIds no adapter).
 *
 * @param {Object} session  - Session (completed)
 * @param {Object|null} payment - Payment vivo da sessão (canceled já filtrado)
 * @param {boolean} guideHasSentDocumentation - guia tem InsuranceCommunication billing/sent
 * @returns {string|null} fase, ou null se a sessão está fora do ciclo (não completed)
 */
export function deriveSessionPhase(session, payment, guideHasSentDocumentation) {
  if (session?.status !== 'completed') return null;

  if (payment?.insurance?.status === 'received') return SessionPhase.RECEIVED;

  if (session?.billingBatchId || payment?.insurance?.status === 'billed') {
    return SessionPhase.BILLED;
  }

  if (guideHasSentDocumentation) return SessionPhase.DOCUMENTATION_SENT;

  return SessionPhase.PENDING_BILLING;
}

/**
 * Rótulo da guia a partir dos contadores. Resumo visual, nunca fonte de verdade.
 *
 * Quando há mais de uma fase ativa, o rótulo é a fase MENOS AVANÇADA — ou seja,
 * a próxima ação pendente. Nunca a mais avançada.
 *
 * Motivo: numa guia com 7 sessões faturadas e 4 a faturar, rotular "Faturada"
 * esconderia trabalho pendente da secretária — que é exatamente o bug original
 * (guia faturada sumia da tela), só que invertido. A parte já faturada não se
 * perde: vive nos contadores e em `hasMixedStates`.
 *
 * - guia fechada manualmente vence tudo (closedAt)
 * - nenhuma sessão no ciclo => NO_SESSIONS (a guia continua aparecendo)
 */
export function deriveBillingLabel(counters, { isClosed = false } = {}) {
  if (isClosed) return GuideBillingLabel.CLOSED;

  const active = PHASE_ORDER.filter(phase => (counters?.[phase] || 0) > 0);
  if (active.length === 0) return GuideBillingLabel.NO_SESSIONS;

  switch (active[0]) {
    case SessionPhase.RECEIVED: return GuideBillingLabel.RECEIVED;
    case SessionPhase.BILLED: return GuideBillingLabel.BILLED;
    case SessionPhase.DOCUMENTATION_SENT: return GuideBillingLabel.DOCUMENTATION_SENT;
    default: return GuideBillingLabel.PENDING;
  }
}

/**
 * A guia tem sessões em mais de uma fase ao mesmo tempo?
 * Característica da guia, não estado. Sinaliza à UI que o rótulo sozinho não
 * conta a história e os contadores precisam ser exibidos.
 */
export function hasMixedStates(counters) {
  return PHASE_ORDER.filter(phase => (counters?.[phase] || 0) > 0).length > 1;
}

/**
 * Data de competência de uma sessão, por eixo próprio da fase.
 * Diretriz 2026-08-07: nunca usar um único campo de data para todas as fases.
 *
 *   pendingBilling     -> Session.date
 *   documentationSent  -> data de envio da comunicação
 *   billed             -> Payment.insurance.billedAt
 *   received           -> Payment.insurance.receivedAt
 */
export function competenceDateFor(phase, { session, payment, documentationSentAt }) {
  switch (phase) {
    case SessionPhase.RECEIVED: return payment?.insurance?.receivedAt || null;
    case SessionPhase.BILLED: return payment?.insurance?.billedAt || null;
    case SessionPhase.DOCUMENTATION_SENT: return documentationSentAt || session?.date || null;
    case SessionPhase.PENDING_BILLING: return session?.date || null;
    default: return session?.date || null;
  }
}

/**
 * Agrega as sessões já classificadas em contadores + somas por fase.
 * Invariante: sessions.total === soma dos 4 contadores de fase.
 */
export function composeGuideAggregates(classifiedSessions) {
  const counters = {
    [SessionPhase.PENDING_BILLING]: 0,
    [SessionPhase.DOCUMENTATION_SENT]: 0,
    [SessionPhase.BILLED]: 0,
    [SessionPhase.RECEIVED]: 0
  };
  const amounts = { ...counters };
  let outOfCycle = 0;

  for (const item of classifiedSessions) {
    if (!item.phase) { outOfCycle += 1; continue; }
    counters[item.phase] += 1;
    amounts[item.phase] += item.value || 0;
  }

  const total = PHASE_ORDER.reduce((sum, phase) => sum + counters[phase], 0);
  const round = n => Math.round(n * 100) / 100;

  return {
    sessions: {
      total,
      pendingBilling: counters[SessionPhase.PENDING_BILLING],
      documentationSent: counters[SessionPhase.DOCUMENTATION_SENT],
      billed: counters[SessionPhase.BILLED],
      received: counters[SessionPhase.RECEIVED],
      outOfCycle
    },
    financialSummary: {
      pendingAmount: round(amounts[SessionPhase.PENDING_BILLING]),
      documentationSentAmount: round(amounts[SessionPhase.DOCUMENTATION_SENT]),
      billedAmount: round(amounts[SessionPhase.BILLED]),
      receivedAmount: round(amounts[SessionPhase.RECEIVED]),
      totalAmount: round(PHASE_ORDER.reduce((sum, phase) => sum + amounts[phase], 0))
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura composta
// ─────────────────────────────────────────────────────────────────────────────

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

function inRange(date, from, to) {
  if (!from && !to) return true;
  if (!date) return false;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/**
 * Escolhe o Payment que representa a sessão. Ignora cancelados e valor <= 0,
 * e prefere o mais avançado no ciclo quando há mais de um (histórico de
 * remarcação/split pode deixar mais de um Payment na mesma sessão).
 */
function pickPaymentForSession(payments) {
  const live = (payments || []).filter(p =>
    !CANCELED_PAYMENT_STATUSES.includes(p.status) && (p.amount || 0) > 0
  );
  if (live.length === 0) return null;
  const rank = { received: 3, billed: 2, pending_billing: 1 };
  return live.reduce((best, p) =>
    (rank[p.insurance?.status] || 0) > (rank[best.insurance?.status] || 0) ? p : best
  );
}

/**
 * Fonte de leitura da aba Convênios.
 *
 * INVARIANTE CENTRAL: sem filtros, toda InsuranceGuide do banco aparece na
 * resposta. Nenhum status, data ou ausência de sessão remove uma guia.
 *
 * @param {Object} filters
 * @param {string}  [filters.insurance]   - código do convênio
 * @param {string}  [filters.patientId]
 * @param {string}  [filters.guideStatus] - InsuranceGuide.status (ciclo de vida)
 * @param {string}  [filters.phase]       - 'pendingBilling'|'documentationSent'|'billed'|'received'|'all'
 * @param {Date|string} [filters.from]    - competência inicial, aplicada no eixo da fase
 * @param {Date|string} [filters.to]      - competência final, aplicada no eixo da fase
 * @param {number}  [filters.page=1]
 * @param {number}  [filters.limit=0]     - 0 = sem paginação (default: acumulado)
 * @returns {Promise<{guides: Array, orphanSessions: Array, totals: Object, pagination: Object}>}
 */
export async function getInsuranceGuidesView(filters = {}) {
  const {
    insurance, patientId, guideStatus, phase = 'all',
    from, to, page = 1, limit = 0
  } = filters;

  const periodFrom = from ? new Date(from) : null;
  const periodTo = to ? new Date(to) : null;

  const guideMatch = {};
  if (insurance) guideMatch.insurance = String(insurance).toLowerCase();
  if (guideStatus) guideMatch.status = guideStatus;
  const patientOid = toObjectId(patientId);
  if (patientOid) guideMatch.patientId = patientOid;

  // 1. Universo = as guias. Nunca derivado de sessão pendente.
  const guides = await InsuranceGuide.find(guideMatch)
    .populate('patientId', 'fullName phone')
    .sort({ createdAt: -1 })
    .lean();

  if (guides.length === 0) {
    logger.info('getInsuranceGuidesView: nenhuma guia para o filtro', { insurance, patientId, guideStatus });
    return {
      guides: [],
      orphanSessions: [],
      totals: composeGuideAggregates([]),
      pagination: { page: 1, limit, total: 0, pages: 0 }
    };
  }

  const guideIds = guides.map(g => g._id);

  // 2. Composição: sessões, payments, comunicações e lotes das guias listadas.
  const [sessions, communications] = await Promise.all([
    Session.find({ insuranceGuide: { $in: guideIds } })
      .select('_id insuranceGuide date status sessionValue specialty doctor appointmentId billingBatchId')
      .populate('doctor', 'fullName')
      .populate('appointmentId', 'time')
      .sort({ date: 1 })
      .lean(),
    InsuranceCommunication.find({ guideId: { $in: guideIds }, purpose: 'billing', status: 'sent' })
      .select('guideId invoiceNumber invoiceDate updatedAt')
      .sort({ updatedAt: -1 })
      .lean()
  ]);

  const sessionIds = sessions.map(s => s._id);

  // Payment é buscado pelos DOIS vínculos: session e insuranceGuide. Em prod há
  // 68 payments 'billed' e 16 'received' com insuranceGuide null, e 52
  // pending_billing sem session — buscar por um só vínculo perderia parte deles.
  const payments = await Payment.find({
    billingType: 'convenio',
    $or: [
      { session: { $in: sessionIds } },
      { insuranceGuide: { $in: guideIds } }
    ]
  })
    .select('_id session insuranceGuide amount status insurance')
    .lean();

  const batchIds = [...new Set(sessions.map(s => idOf(s.billingBatchId)).filter(Boolean))];
  const batches = batchIds.length
    ? await InsuranceBatch.find({ _id: { $in: batchIds } }).select('_id status createdAt').lean()
    : [];
  const batchById = new Map(batches.map(b => [idOf(b._id), b]));

  // Índices
  const paymentsBySession = new Map();
  for (const p of payments) {
    const sid = idOf(p.session);
    if (!sid) continue;
    if (!paymentsBySession.has(sid)) paymentsBySession.set(sid, []);
    paymentsBySession.get(sid).push(p);
  }

  const sessionsByGuide = new Map();
  for (const s of sessions) {
    const gid = idOf(s.insuranceGuide);
    if (!gid) continue;
    if (!sessionsByGuide.has(gid)) sessionsByGuide.set(gid, []);
    sessionsByGuide.get(gid).push(s);
  }

  // ⚠️ InsuranceCommunication NÃO tem campo `sentAt` (só timestamps + invoiceDate).
  // `updatedAt` é o proxy usado hoje pelo insuranceBatchGuideAdapter e é o melhor
  // disponível — mas ele se move a qualquer edição do registro, então é uma
  // aproximação da data de envio, não a data de envio. Ver limitação no doc.
  const documentationByGuide = new Map();
  for (const comm of communications) {
    const gid = idOf(comm.guideId);
    if (!gid || documentationByGuide.has(gid)) continue;
    documentationByGuide.set(gid, {
      sentAt: comm.invoiceDate || comm.updatedAt,
      sentAtIsProxy: !comm.invoiceDate,
      invoiceNumber: comm.invoiceNumber || null
    });
  }

  // 3. Classificação por sessão + agregação por guia
  const phaseFilterActive = phase && phase !== 'all';
  const enriched = [];

  for (const guide of guides) {
    const gid = idOf(guide._id);
    const guideSessions = sessionsByGuide.get(gid) || [];
    const documentation = documentationByGuide.get(gid) || null;

    const classified = guideSessions.map(session => {
      const payment = pickPaymentForSession(paymentsBySession.get(idOf(session._id)));
      const sessionPhase = deriveSessionPhase(session, payment, !!documentation);
      const batch = batchById.get(idOf(session.billingBatchId)) || null;
      return {
        sessionId: idOf(session._id),
        date: session.date,
        time: session.appointmentId?.time || null,
        doctorName: session.doctor?.fullName || null,
        specialty: session.specialty || null,
        status: session.status,
        phase: sessionPhase,
        value: sessionPhase ? resolveSessionValue(session, payment, guide) : 0,
        paymentId: idOf(payment?._id),
        paymentStatus: payment?.insurance?.status ?? null,
        batchId: idOf(session.billingBatchId),
        batchStatus: batch?.status || null,
        competenceDate: competenceDateFor(sessionPhase, {
          session, payment, documentationSentAt: documentation?.sentAt
        })
      };
    });

    // Filtro de competência: aplicado no eixo de data DA PRÓPRIA FASE.
    const inPeriod = (periodFrom || periodTo)
      ? classified.filter(s => !s.phase || inRange(s.competenceDate, periodFrom, periodTo))
      : classified;

    const scoped = phaseFilterActive
      ? inPeriod.filter(s => !s.phase || s.phase === phase)
      : inPeriod;

    const aggregates = composeGuideAggregates(scoped);
    const isClosed = !!guide.closedAt;
    const phaseCounters = {
      [SessionPhase.PENDING_BILLING]: aggregates.sessions.pendingBilling,
      [SessionPhase.DOCUMENTATION_SENT]: aggregates.sessions.documentationSent,
      [SessionPhase.BILLED]: aggregates.sessions.billed,
      [SessionPhase.RECEIVED]: aggregates.sessions.received
    };

    enriched.push({
      guideId: gid,
      number: guide.number,
      insurance: guide.insurance,
      specialty: guide.specialty,
      patient: guide.patientId,

      // Ciclo de vida da autorização — NUNCA faturamento.
      guideStatus: guide.status,
      expiresAt: guide.expiresAt,
      closedAt: guide.closedAt || null,

      billingMode: guide.billingMode || 'per_month',
      totalSessions: guide.totalSessions,
      usedSessions: guide.usedSessions,
      remaining: Math.max(0, (guide.totalSessions || 0) - (guide.usedSessions || 0)),
      sessionValue: guide.sessionValue,
      totalAuthorizedValue: guide.totalAuthorizedValue || null,

      // A verdade do ciclo financeiro vive aqui.
      sessions: aggregates.sessions,
      financialSummary: aggregates.financialSummary,

      // Rótulo visual apenas — a verdade está em `sessions`/`financialSummary`.
      billingState: deriveBillingLabel(phaseCounters, { isClosed }),
      hasMixedStates: hasMixedStates(phaseCounters),

      documentationSentAt: documentation?.sentAt || null,
      documentationSentAtIsProxy: documentation?.sentAtIsProxy ?? false,
      invoiceNumber: documentation?.invoiceNumber || null,

      sessionDetails: scoped
    });
  }

  // Semântica de BUCKET: com `phase` explícito a resposta é a aba daquela fase,
  // então guias sem conteúdo nela saem da lista. A mesma guia pode (e deve)
  // aparecer em vários buckets — 4 a faturar + 8 faturadas + 4 recebidas entra
  // nas três abas, cada uma exibindo só a SUA parcela, nunca o total da guia.
  //
  // Sem `phase` (default) a invariante de completude vale: toda guia aparece.
  const bucketed = phaseFilterActive
    ? enriched.filter(g => g.sessions[phase] > 0)
    : enriched;

  // 4. Sessões de convênio sem guia vinculada (rastreabilidade perdida na Session).
  const orphanSessions = await Session.find({
    status: 'completed',
    $or: [{ paymentMethod: 'convenio' }, { billingType: 'convenio' }],
    $and: [{ $or: [{ insuranceGuide: { $exists: false } }, { insuranceGuide: null }] }]
  })
    .select('_id date sessionValue specialty patient doctor billingBatchId')
    .populate('patient', 'fullName')
    .populate('doctor', 'fullName')
    .sort({ date: 1 })
    .lean();

  // 5. Totais da tela — somados no backend, nunca no front. Escopados ao mesmo
  // recorte devolvido (bucket da fase, se houver), para o card da aba mostrar a
  // parcela daquela fase e não o total da guia.
  const totals = composeGuideAggregates(
    bucketed.flatMap(g => g.sessionDetails)
  );

  const totalGuides = bucketed.length;
  const paged = limit > 0
    ? bucketed.slice((page - 1) * limit, page * limit)
    : bucketed;

  logger.info('getInsuranceGuidesView done', {
    guides: totalGuides,
    sessoes: totals.sessions.total,
    orfas: orphanSessions.length,
    phase,
    from: periodFrom,
    to: periodTo
  });

  return {
    guides: paged,
    orphanSessions: orphanSessions.map(s => ({
      sessionId: idOf(s._id),
      date: s.date,
      value: s.sessionValue || 0,
      specialty: s.specialty || null,
      patientName: s.patient?.fullName || null,
      doctorName: s.doctor?.fullName || null,
      batchId: idOf(s.billingBatchId)
    })),
    totals,
    pagination: {
      page: limit > 0 ? page : 1,
      limit,
      total: totalGuides,
      pages: limit > 0 ? Math.ceil(totalGuides / limit) : 1
    }
  };
}

export default {
  getInsuranceGuidesView,
  deriveSessionPhase,
  deriveBillingLabel,
  hasMixedStates,
  composeGuideAggregates,
  competenceDateFor,
  resolveSessionValue,
  SessionPhase,
  GuideBillingLabel
};
