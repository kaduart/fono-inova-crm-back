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
import BillingSubmission from '../../models/BillingSubmission.js';
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

const ACTIVE_PAYMENT_STATUSES = new Set([
  'pending', 'pending_billing', 'billed', 'received', 'paid', 'partial'
]);
const INSURANCE_CYCLE_STATUSES = new Set(['pending_billing', 'billed', 'received']);

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
 * Agrupa as sessões já classificadas pelas notas fiscais que as cobriram.
 *
 * A NF é do LOTE, e uma guia faturada mês a mês tem sessões em notas diferentes
 * — por isso o resumo é uma lista, não um campo único. Sessões ainda sem lote
 * ficam de fora: não há nota para elas.
 */
export function summarizeInvoices(classifiedSessions = []) {
  const porLote = new Map();
  for (const s of classifiedSessions) {
    if (!s.batchId) continue;
    if (!porLote.has(s.batchId)) {
      porLote.set(s.batchId, {
        batchId: s.batchId,
        invoiceNumber: s.batchInvoiceNumber || null,
        invoiceDate: s.batchInvoiceDate || null,
        origin: s.batchOrigin || null,
        batchStatus: s.batchStatus || null,
        sessions: 0,
        amount: 0
      });
    }
    const nf = porLote.get(s.batchId);
    nf.sessions += 1;
    nf.amount = Math.round((nf.amount + (s.value || 0)) * 100) / 100;
  }
  return [...porLote.values()];
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

/**
 * Decompõe somente sessões `pendingBilling` entre a competência corrente e o
 * backlog anterior. O eixo é sempre Session.date (materializado em `date` no
 * detalhe classificado); nenhuma outra fase participa deste indicador.
 *
 * A função é usada tanto por guia quanto no agregado da resposta, garantindo
 * que a UI não precise reconstruir competência nem recalcular valores.
 */
export function composePendingCompetenceBreakdown(classifiedSessions, referenceDate = new Date()) {
  const reference = new Date(referenceDate);
  // Preserva a semântica antiga: "mês atual" é o calendário local do
  // servidor, não o mês UTC (importante na virada do mês em São Paulo).
  const referenceMonth = `${reference.getFullYear()}-${String(reference.getMonth() + 1).padStart(2, '0')}`;
  let currentValue = 0;
  let currentSessions = 0;
  let previousValue = 0;
  let previousSessions = 0;
  let oldestCompetence = null;

  for (const session of classifiedSessions || []) {
    if (session?.phase !== SessionPhase.PENDING_BILLING || !session.date) continue;
    const date = new Date(session.date);
    if (Number.isNaN(date.getTime())) continue;
    const competence = date.toISOString().slice(0, 7);

    if (competence === referenceMonth) {
      currentValue += session.value || 0;
      currentSessions += 1;
    } else if (competence < referenceMonth) {
      previousValue += session.value || 0;
      previousSessions += 1;
      if (!oldestCompetence || competence < oldestCompetence) oldestCompetence = competence;
    }
  }

  const round = n => Math.round(n * 100) / 100;
  return {
    referenceMonth,
    current: { value: round(currentValue), sessions: currentSessions },
    previous: {
      value: round(previousValue),
      sessions: previousSessions,
      oldestCompetence
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

const ORPHAN_MATCH = {
  status: 'completed',
  $or: [{ paymentMethod: 'convenio' }, { billingType: 'convenio' }],
  $and: [{ $or: [{ insuranceGuide: { $exists: false } }, { insuranceGuide: null }] }]
};

async function loadOrphanSessions(match = ORPHAN_MATCH) {
  const sessions = await Session.find(match)
    .select('_id date time sessionValue specialty patient doctor billingBatchId insuranceProvider')
    .populate('patient', 'fullName')
    .populate('doctor', 'fullName')
    .sort({ date: 1 })
    .lean();
  return sessions.map(session => ({
    sessionId: idOf(session._id), date: session.date, time: session.time || null,
    value: session.sessionValue || 0, sessionValue: session.sessionValue || 0,
    specialty: session.specialty || null, patient: session.patient || null,
    patientName: session.patient?.fullName || null, doctorName: session.doctor?.fullName || null,
    insuranceProvider: session.insuranceProvider || null, batchId: idOf(session.billingBatchId)
  }));
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
 * Resolve o Payment canônico da sessão. Somente status ativos e estados de
 * convênio pertencentes ao ciclo financeiro são elegíveis. `void`, cancelados,
 * rejeitados e estados incompletos viram conflito explícito de leitura.
 */
export function resolvePaymentForSession(payments) {
  const eligible = (payments || []).filter(p =>
    ACTIVE_PAYMENT_STATUSES.has(p.status)
    && INSURANCE_CYCLE_STATUSES.has(p.insurance?.status)
    && (p.amount || 0) > 0
  );
  if (eligible.length === 0) {
    return { payment: null, activePayments: 0, integrityConflict: true };
  }
  const rank = { received: 3, billed: 2, pending_billing: 1 };
  const payment = eligible.reduce((best, p) =>
    (rank[p.insurance?.status] || 0) > (rank[best.insurance?.status] || 0) ? p : best
  );
  return {
    payment,
    activePayments: eligible.length,
    integrityConflict: eligible.length !== 1
  };
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
 * @param {string}  [filters.guideId]    - restringe detalhes lazy a uma guia
 * @param {string}  [filters.guideStatus] - InsuranceGuide.status (ciclo de vida)
 * @param {string}  [filters.phase]       - 'pendingBilling'|'documentationSent'|'billed'|'received'|'all'
 * @param {string}  [filters.phases]      - fases separadas por vírgula p/ retorno consolidado (ex: 'pendingBilling,documentationSent,billed,received')
 * @param {'full'|'summary'} [filters.detail='full'] - summary omite detalhes pesados
 * @param {Date|string} [filters.from]    - competência inicial, aplicada no eixo da fase
 * @param {Date|string} [filters.to]      - competência final, aplicada no eixo da fase
 * @param {number}  [filters.page=1]
 * @param {number}  [filters.limit=0]     - 0 = sem paginação (default: acumulado)
 * @returns {Promise<{guides: Array, orphanSessions: Array, totals: Object, pagination: Object, buckets: Object|undefined}>}
 */
export async function getInsuranceGuidesView(filters = {}) {
  const {
    insurance, patientId, guideId, guideIds: guideIdsFilter, guideStatus, phase = 'all', phases, detail = 'full',
    from, to, page = 1, limit = 0
  } = filters;
  const summaryOnly = detail === 'summary';
  if (detail === 'orphans') {
    const orphanSessions = await loadOrphanSessions();
    return { guides: [], orphanSessions, orphanSessionsCount: orphanSessions.length, paymentIntegrityConflicts: [], paymentIntegrityConflictCount: 0, totals: composeGuideAggregates([]), competenceBreakdown: composePendingCompetenceBreakdown([]), pagination: { page: 1, limit: 0, total: 0, pages: 0 } };
  }

  const phaseList = phases
    ? String(phases).split(',').map(p => p.trim()).filter(Boolean)
    : [];

  const periodFrom = from ? new Date(from) : null;
  const periodTo = to ? new Date(to) : null;

  const guideMatch = {};
  // 🚀 PERF (2026-09-02): drawer de paciente fazia 1 request por guia (N+1) —
  // clicar num paciente com 3-4 guias disparava 3-4 chamadas paralelas, cada
  // uma com 4+ round-trips ao banco, somando ~3s. `guideIds` permite buscar
  // várias guias na mesma chamada ($in) sem mudar o comportamento de `guideId`
  // (single) já existente.
  const guideIdsList = Array.isArray(guideIdsFilter)
    ? guideIdsFilter
    : (typeof guideIdsFilter === 'string' ? guideIdsFilter.split(',').map(s => s.trim()).filter(Boolean) : []);
  const guideOidsList = guideIdsList.map(toObjectId).filter(Boolean);
  const guideOid = toObjectId(guideId);
  if (guideOidsList.length > 0) {
    guideMatch._id = { $in: guideOidsList };
  } else if (guideOid) {
    guideMatch._id = guideOid;
  }
  if (insurance) guideMatch.insurance = String(insurance).toLowerCase();
  if (guideStatus) guideMatch.status = guideStatus;
  const patientOid = toObjectId(patientId);
  if (patientOid) guideMatch.patientId = patientOid;

  // 1. Universo = as guias. Nunca derivado de sessão pendente.
  const guides = await InsuranceGuide.find(guideMatch)
    .populate('patientId', summaryOnly ? 'fullName' : 'fullName phone')
    .sort({ createdAt: -1 })
    .lean();

  if (guides.length === 0) {
    logger.info('getInsuranceGuidesView: nenhuma guia para o filtro', { insurance, patientId, guideStatus });
    return {
      guides: [],
      orphanSessions: [],
      totals: composeGuideAggregates([]),
      competenceBreakdown: composePendingCompetenceBreakdown([]),
      paymentIntegrityConflicts: [],
      pagination: { page: 1, limit, total: 0, pages: 0 }
    };
  }

  const guideIds = guides.map(g => g._id);

  // 2. Composição: sessões, payments, comunicações e lotes das guias listadas.
  const [sessions, legacyCommunications] = await Promise.all([
    Session.find({ insuranceGuide: { $in: guideIds } })
      .select('_id insuranceGuide date status sessionValue specialty doctor appointmentId billingBatchId')
      .populate(summaryOnly ? [] : [
        { path: 'doctor', select: 'fullName' },
        { path: 'appointmentId', select: 'time' }
      ])
      .sort({ date: 1 })
      .lean(),
    InsuranceCommunication.find({
      purpose: 'billing',
      status: 'sent',
      guideId: { $in: guideIds }
    })
      .select('guideId billingSubmissionId invoiceNumber invoiceDate sentAt updatedAt')
      .sort({ updatedAt: -1 })
      .lean()
  ]);

  const sessionIds = sessions.map(s => s._id);
  const documentedSubmissions = sessionIds.length
    ? await BillingSubmission.find({ sessionIds: { $in: sessionIds } })
      .select('_id sessionIds')
      .lean()
    : [];
  const documentedSubmissionIds = documentedSubmissions.map(submission => submission._id);
  const submissionCommunications = documentedSubmissionIds.length
    ? await InsuranceCommunication.find({
      purpose: 'billing',
      status: 'sent',
      billingSubmissionId: { $in: documentedSubmissionIds }
    })
      .select('guideId billingSubmissionId invoiceNumber invoiceDate sentAt updatedAt')
      .sort({ updatedAt: -1 })
      .lean()
    : [];
  const communications = [...legacyCommunications, ...submissionCommunications];

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
  const batches = !summaryOnly && batchIds.length
    // A NF vive no LOTE (`invoiceNumber`), não na guia. Sem trazer esses campos
    // a tela mostra "Faturada" sem dizer por qual nota — e no legado não há
    // InsuranceCommunication de onde inferir. `origin` distingue reconciliação
    // de faturamento executado pelo sistema.
    ? await InsuranceBatch.find({ _id: { $in: batchIds } })
        .select('_id status createdAt invoiceNumber invoiceDate origin')
        .lean()
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

  // Registros novos têm sentAt explícito; invoiceDate/updatedAt permanecem somente
  // como fallback compatível para comunicações anteriores ao campo.
  // `updatedAt` é o proxy usado hoje pelo insuranceBatchGuideAdapter e é o melhor
  // disponível — mas ele se move a qualquer edição do registro, então é uma
  // aproximação da data de envio, não a data de envio. Ver limitação no doc.
  const documentationByGuide = new Map();
  for (const comm of communications) {
    const gid = idOf(comm.guideId);
    if (!gid || documentationByGuide.has(gid)) continue;
    documentationByGuide.set(gid, {
      sentAt: comm.sentAt || comm.invoiceDate || comm.updatedAt,
      sentAtIsProxy: !comm.sentAt,
      invoiceNumber: comm.invoiceNumber || null,
      communicationId: idOf(comm._id)
    });
  }

  // Novo fluxo: comunicação pertence ao submission e sua seleção exata de
  // sessões, não à primeira guia. A fase documental é aplicada somente às
  // sessões daquele submission.
  const submissionCommunicationById = new Map();
  for (const comm of communications) {
    const submissionId = idOf(comm.billingSubmissionId);
    if (submissionId && !submissionCommunicationById.has(submissionId)) {
      submissionCommunicationById.set(submissionId, {
        communicationId: idOf(comm._id),
        ...comm
      });
    }
  }
  const documentedSubmissionSessions = new Map();
  if (submissionCommunicationById.size) {
    for (const submission of documentedSubmissions) {
      const comm = submissionCommunicationById.get(idOf(submission._id));
      if (!comm) continue;
      const documentation = {
        sentAt: comm.sentAt || comm.invoiceDate || comm.updatedAt,
        sentAtIsProxy: !comm.sentAt,
        invoiceNumber: null,
        communicationId: comm.communicationId
      };
      for (const sessionId of submission.sessionIds || []) {
        if (!documentedSubmissionSessions.has(idOf(sessionId))) {
          documentedSubmissionSessions.set(idOf(sessionId), documentation);
        }
      }
    }
  }

  // 3. Classificação por sessão + agregação por guia
  const phaseFilterActive = phase && phase !== 'all' && phaseList.length === 0;
  const guideBases = [];
  const paymentIntegrityConflicts = [];
  let paymentIntegrityConflictCount = 0;

  for (const guide of guides) {
    const gid = idOf(guide._id);
    const guideSessions = sessionsByGuide.get(gid) || [];
    const guideDocumentation = documentationByGuide.get(gid) || null;

    const classified = guideSessions.map(session => {
      const paymentResolution = resolvePaymentForSession(paymentsBySession.get(idOf(session._id)));
      const payment = paymentResolution.payment;
      const documentation = documentedSubmissionSessions.get(idOf(session._id)) || guideDocumentation;
      const sessionPhase = paymentResolution.integrityConflict
        ? null
        : deriveSessionPhase(session, payment, !!documentation);
      const batch = batchById.get(idOf(session.billingBatchId)) || null;
      if (session.status === 'completed' && paymentResolution.integrityConflict) {
        paymentIntegrityConflictCount++;
        // Sempre populado (não só em detail:'full'): é um array de exceções
        // de integridade, por natureza pequeno (nunca cresce com o volume
        // normal de guias/sessões), então não pesa a resposta summary — e sem
        // ele o aviso na tela ("N sessões não foram listadas...") não tinha
        // como ser expandido pra mostrar quem/quando/motivo.
        const sessionPayments = paymentsBySession.get(idOf(session._id)) || [];
        const reason = sessionPayments.length === 0
          ? 'Nenhum Payment de convênio vinculado à sessão'
          : paymentResolution.activePayments === 0
            ? 'Payment(s) de convênio existente(s), mas nenhum com status ativo (cancelado/anulado)'
            : 'Mais de um Payment de convênio ativo para a mesma sessão (duplicidade)';
        paymentIntegrityConflicts.push({
          sessionId: idOf(session._id),
          sessionDate: session.date,
          guideId: gid,
          guideNumber: guide.number || null,
          guideInsurance: guide.insurance || null,
          patientId: idOf(guide.patientId),
          patientName: guide.patientId?.fullName || null,
          activePayments: paymentResolution.activePayments,
          reason,
          paymentStatuses: sessionPayments.map(item => ({
            paymentId: idOf(item._id),
            status: item.status,
            insuranceStatus: item.insurance?.status || null
          }))
        });
      }
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
        paymentIntegrityConflict: paymentResolution.integrityConflict,
        activePaymentCount: paymentResolution.activePayments,
        batchId: idOf(session.billingBatchId),
        batchStatus: batch?.status || null,
        // NF sob a qual ESTA sessão foi faturada. Uma guia pode ter sessões em
        // notas diferentes (faturamento mês a mês), então a nota é por sessão.
        batchInvoiceNumber: batch?.invoiceNumber || null,
        batchInvoiceDate: batch?.invoiceDate || null,
        batchOrigin: batch?.origin || null,
        competenceDate: competenceDateFor(sessionPhase, {
          session, payment, documentationSentAt: documentation?.sentAt
        })
      };
    });

    // Filtro de competência: aplicado no eixo de data DA PRÓPRIA FASE.
    const inPeriod = (periodFrom || periodTo)
      ? classified.filter(s => !s.phase || inRange(s.competenceDate, periodFrom, periodTo))
      : classified;

    guideBases.push({ guide, gid, classified, inPeriod });
  }

  function buildEnrichedGuide(guide, classified, inPeriod, scoped) {
    const gid = idOf(guide._id);
    const aggregates = composeGuideAggregates(scoped);
    const isClosed = !!guide.closedAt;
    const phaseCounters = {
      [SessionPhase.PENDING_BILLING]: aggregates.sessions.pendingBilling,
      [SessionPhase.DOCUMENTATION_SENT]: aggregates.sessions.documentationSent,
      [SessionPhase.BILLED]: aggregates.sessions.billed,
      [SessionPhase.RECEIVED]: aggregates.sessions.received
    };

    const result = {
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
      competenceBreakdown: composePendingCompetenceBreakdown(inPeriod),
      firstSessionDate: scoped[0]?.date || null,
      lastSessionDate: scoped[scoped.length - 1]?.date || null,

      // Rótulo visual apenas — a verdade está em `sessions`/`financialSummary`.
      billingState: deriveBillingLabel(phaseCounters, { isClosed }),
      hasMixedStates: hasMixedStates(phaseCounters),

      documentationSentAt: documentationByGuide.get(gid)?.sentAt
        || scoped.find(item => item.phase === SessionPhase.DOCUMENTATION_SENT)?.competenceDate
        || null,
      documentationSentAtIsProxy: documentationByGuide.get(gid)?.sentAtIsProxy
        ?? scoped.some(item => documentedSubmissionSessions.get(item.sessionId)?.sentAtIsProxy)
        ?? false,
      invoiceNumber: documentationByGuide.get(gid)?.invoiceNumber || null,
      communicationId: documentationByGuide.get(gid)?.communicationId
        || scoped.find(item => item.phase === SessionPhase.DOCUMENTATION_SENT)?.communicationId
        || scoped.find(item => item.phase === SessionPhase.BILLED)?.communicationId
        || null,

      // Notas fiscais que cobrem as sessões DESTA guia, com quantas sessões e
      // quanto cada uma levou. Uma guia faturada mês a mês aparece em várias
      // notas; sem isto a tela diz "Faturada" sem dizer por qual documento.
      ...(!summaryOnly ? {
        invoices: summarizeInvoices(scoped),
        sessionDetails: scoped
      } : {})
    };
    Object.defineProperty(result, '_scoped', { value: scoped, enumerable: false });
    return result;
  }

  const enriched = guideBases.map(({ guide, classified, inPeriod }) => {
    const scoped = phaseFilterActive
      ? inPeriod.filter(s => !s.phase || s.phase === phase)
      : inPeriod;
    return buildEnrichedGuide(guide, classified, inPeriod, scoped);
  });

  // 3.1 Buckets consolidados: várias fases em uma única execução.
  // Cada bucket replica o comportamento de `phase=X`, inclusive filtros,
  // agregações e paginação. `phase=X` continua funcionando isoladamente.
  let buckets;
  if (phaseList.length > 0) {
    buckets = {};
    for (const p of phaseList) {
      const bucketGuides = guideBases
        .map(({ guide, classified, inPeriod }) => {
          const scoped = inPeriod.filter(s => !s.phase || s.phase === p);
          return buildEnrichedGuide(guide, classified, inPeriod, scoped);
        })
        .filter(g => g.sessions[p] > 0);

      const totals = composeGuideAggregates(bucketGuides.flatMap(g => g._scoped));
      const competenceBreakdown = composePendingCompetenceBreakdown(bucketGuides.flatMap(g => g._scoped));
      const totalGuides = bucketGuides.length;
      const paged = limit > 0
        ? bucketGuides.slice((page - 1) * limit, page * limit)
        : bucketGuides;

      buckets[p] = {
        data: paged,
        totals,
        competenceBreakdown,
        pagination: {
          page: limit > 0 ? page : 1,
          limit,
          total: totalGuides,
          pages: limit > 0 ? Math.ceil(totalGuides / limit) : 1
        }
      };
    }
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
  const orphanMatch = ORPHAN_MATCH;
  const orphanSessions = summaryOnly || guideOid ? [] : await loadOrphanSessions(orphanMatch);
  const orphanSessionsCount = guideOid
    ? 0
    : summaryOnly
    ? await Session.countDocuments(orphanMatch)
    : orphanSessions.length;

  // 5. Totais da tela — somados no backend, nunca no front. Escopados ao mesmo
  // recorte devolvido (bucket da fase, se houver), para o card da aba mostrar a
  // parcela daquela fase e não o total da guia.
  const totals = composeGuideAggregates(
    bucketed.flatMap(g => g._scoped)
  );
  const competenceBreakdown = composePendingCompetenceBreakdown(
    bucketed.flatMap(g => g._scoped)
  );

  const totalGuides = bucketed.length;
  const paged = limit > 0
    ? bucketed.slice((page - 1) * limit, page * limit)
    : bucketed;

  logger.info('getInsuranceGuidesView done', {
    guides: totalGuides,
    sessoes: totals.sessions.total,
    orfas: orphanSessionsCount,
    phase,
    phases: phaseList,
    from: periodFrom,
    to: periodTo
  });

  return {
    guides: paged,
    orphanSessions,
    orphanSessionsCount,
    totals,
    competenceBreakdown,
    paymentIntegrityConflicts,
    paymentIntegrityConflictCount,
    pagination: {
      page: limit > 0 ? page : 1,
      limit,
      total: totalGuides,
      pages: limit > 0 ? Math.ceil(totalGuides / limit) : 1
    },
    buckets
  };
}

export default {
  getInsuranceGuidesView,
  deriveSessionPhase,
  deriveBillingLabel,
  hasMixedStates,
  composeGuideAggregates,
  composePendingCompetenceBreakdown,
  competenceDateFor,
  resolvePaymentForSession,
  resolveSessionValue,
  SessionPhase,
  GuideBillingLabel
};
