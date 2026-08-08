// back/services/insuranceGuide/reconcileLegacyInsuranceBatch.js
/**
 * Reconciliação de envio legado de convênio — registra uma NF antiga como lote.
 *
 * PROBLEMA QUE RESOLVE (auditoria 2026-08-07)
 * Antes do modelo por guia, uma única NF agrupava VÁRIAS guias do mesmo paciente
 * numa competência. Ex. real: NF R$ 1.411,06 de janeiro = guia 15655250 (6 sessões)
 * + 15655247 (7) + 15650230 (5), bruto R$ 1.440 menos 2,01% de ISS. O sistema só
 * sabe representar 1 NF por guia, então esses envios ficaram invisíveis e as
 * sessões seguem aparecendo como "a faturar" apesar de faturadas em papel.
 *
 * A relação é muitos-para-muitos e vive na SESSÃO: uma NF tem N guias, e a mesma
 * guia participa de NFs de meses diferentes. Por isso o agregado é o InsuranceBatch
 * (cada item já aponta para a sua guia), não um `invoiceNumber` na guia.
 *
 * POR QUE NÃO REUSAR sendBatch() NEM finalizeBillingSubmission()
 * Os dois carimbam `new Date()` e chamam `recordInsuranceBilled`, que grava no
 * FinancialLedger — **imutável**. `sendBatch` em sentDate/sentAt/billedAt;
 * `finalizeBillingSubmission` no `now` da linha 457 e no ledger da 528. Rodar
 * qualquer um deles num envio de janeiro criaria lançamento contábil com a data
 * de hoje, sem volta. Este comando aceita datas históricas e NÃO escreve ledger.
 *
 * RELAÇÃO COM A ARQUITETURA NOVA (ADR-002)
 * O lote legado nasce SEM `billingSubmissionId`, de propósito. A ADR-002 põe
 * "migração, backfill ou reconciliação de registros legados" fora de escopo e
 * define o corte: fluxo novo exige billingSubmissionId, legado não o possui.
 *
 * Também não daria para reusar `finalizeBillingSubmission`: ele exige NF
 * completa em toda alocação, incluindo `documentId` de um PatientDocument real
 * (BILLING_SUBMISSION_INVOICE_REQUIRED). NF antiga em papel não tem documento
 * digitalizado e seria rejeitada.
 *
 * O agrupamento "Faturamento reconciliado — <competência>" é reconstruído na
 * LEITURA a partir de patient + insuranceProvider + competência + origin, não
 * persistido como submission.
 *
 * O QUE ELE NÃO FAZ, POR DECISÃO
 *   - não escreve no FinancialLedger (a decisão sobre o ISS retroativo está aberta)
 *   - não emite eventos de faturamento
 *   - não altera `billingMode`, `sessionValue` nem valor de Payment
 *   - não sobrescreve Payment já `received`
 *   - não fatura a guia inteira: só as sessões explicitamente escolhidas
 *
 * `dryRun` é o padrão. Nada é gravado sem `dryRun: false` explícito.
 */

import mongoose from 'mongoose';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import { createContextLogger } from '../../utils/logger.js';

const logger = createContextLogger('ReconcileLegacyInsuranceBatch');

/** Status terminais de Payment: histórico, nunca o canônico. */
export const TERMINAL_PAYMENT_STATUSES = ['canceled', 'cancelled', 'refunded'];

/** Conflitos que impedem a gravação. */
export const BLOCKING = {
  NO_ACTIVE_PAYMENT: 'no_active_payment',
  MULTIPLE_ACTIVE_PAYMENTS: 'multiple_active_payments',
  SESSION_IN_OTHER_BATCH: 'session_already_in_batch',
  SESSION_NOT_COMPLETED: 'session_not_completed',
  WRONG_PATIENT: 'session_from_another_patient',
  NO_VALUE: 'no_resolvable_value',
  NO_APPOINTMENT: 'session_without_appointment'
};

/** Avisos que NÃO impedem a gravação. */
export const WARNING = {
  ALREADY_RECEIVED: 'payment_already_received',
  ALREADY_BILLED: 'payment_already_billed',
  VALUE_DIVERGES: 'value_diverges_from_payment'
};

const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const idOf = v => (v?._id || v)?.toString?.() || null;

/**
 * Payment canônico de uma sessão.
 *
 * Cada sessão pode ter vários Payments: os terminais são histórico e convivem
 * legitimamente com o vigente (em jan/fev de um paciente real são 72 payments
 * para 36 sessões). Indexar com `map.set(sessionId, payment)` faz o último
 * vencer e o resultado depender da ordem que o Mongo devolveu — é assim que se
 * lê o valor cancelado achando que é o vigente.
 *
 * @returns {{ payment: Object|null, conflict: string|null, actives: Array }}
 */
export function resolveCanonicalPayment(payments = []) {
  const actives = payments.filter(p => !TERMINAL_PAYMENT_STATUSES.includes(p.status));
  if (actives.length === 0) return { payment: null, conflict: BLOCKING.NO_ACTIVE_PAYMENT, actives };
  if (actives.length > 1) return { payment: null, conflict: BLOCKING.MULTIPLE_ACTIVE_PAYMENTS, actives };
  return { payment: actives[0], conflict: null, actives };
}

/**
 * Valor bruto de um item, com procedência explícita.
 *
 * O documento sempre vence: o valor da época pode divergir do Payment vigente
 * (reajuste de tabela, nota emitida com outro valor). Quando o documento não
 * discrimina por sessão, cai para o Payment canônico. `Session.sessionValue`
 * não entra: em parte do legado ele está zerado.
 */
export function resolveItemValue({ documentedValue, payment }) {
  const paymentGross = payment?.insurance?.grossAmount > 0
    ? payment.insurance.grossAmount
    : (payment?.amount > 0 ? payment.amount : null);

  if (documentedValue > 0) {
    return {
      grossAmount: round(documentedValue),
      valueSource: 'legacy_document',
      originalPaymentAmount: paymentGross,
      reconciliationDifference: paymentGross == null ? null : round(documentedValue - paymentGross)
    };
  }
  if (paymentGross == null) {
    return { grossAmount: null, valueSource: null, originalPaymentAmount: null, reconciliationDifference: null };
  }
  return {
    grossAmount: round(paymentGross),
    valueSource: payment?.insurance?.grossAmount > 0 ? 'canonical_payment' : 'payment_amount',
    originalPaymentAmount: paymentGross,
    reconciliationDifference: 0
  };
}

/**
 * Classifica a conferência do lote contra o documento.
 * Divergência nunca bloqueia — o documento prevalece e a diferença fica gravada.
 */
export function classifyReconciliation({ expectedGross, documentedGross, manualOverride = false }) {
  if (manualOverride) {
    return { status: 'manual_override', difference: documentedGross == null ? null : round(documentedGross - expectedGross) };
  }
  if (documentedGross == null) {
    return { status: 'divergent', difference: null, reason: 'bruto não documentado na nota' };
  }
  const difference = round(documentedGross - expectedGross);
  return difference === 0
    ? { status: 'matched', difference: 0 }
    : { status: 'divergent', difference, reason: `soma dos itens (${expectedGross}) difere do bruto documentado (${documentedGross})` };
}

/**
 * @param {Object} input
 * @param {string}  input.patientId
 * @param {string}  input.insuranceProvider  - código do convênio (ex: 'unimed-anapolis')
 * @param {string[]} input.sessionIds        - sessões EXATAS cobertas pela nota
 * @param {string}  input.invoiceNumber
 * @param {Date|string} input.invoiceDate    - data da NF (histórica)
 * @param {string}  [input.competenceMonth]  - 'YYYY-MM'
 * @param {number}  [input.documentedGross]  - bruto impresso; null = não documentado
 * @param {number}  [input.issRate]          - alíquota; null = não documentada
 * @param {number}  [input.issAmount]        - retenção; null = não documentada
 * @param {number}  [input.documentedNet]    - líquido impresso; null = não documentado
 * @param {Object}  [input.itemValues]       - { [sessionId]: valor } do documento
 * @param {string}  [input.documentReference]
 * @param {string}  [input.notes]
 * @param {boolean} [input.manualOverride=false]
 * @param {string}  input.userId
 * @param {boolean} [input.dryRun=true]
 */
export async function reconcileLegacyInsuranceBatch(input = {}) {
  const {
    patientId, insuranceProvider, sessionIds = [],
    invoiceNumber, invoiceDate, competenceMonth,
    documentedGross = null, issRate = null, issAmount = null, documentedNet = null,
    itemValues = {}, documentReference = null, notes = null,
    manualOverride = false, userId, dryRun = true
  } = input;

  if (!patientId) throw new Error('patientId é obrigatório');
  if (!insuranceProvider) throw new Error('insuranceProvider é obrigatório');
  if (!sessionIds.length) throw new Error('sessionIds é obrigatório — a nota cobre sessões explícitas');
  if (!invoiceNumber) throw new Error('invoiceNumber é obrigatório');
  if (!invoiceDate) throw new Error('invoiceDate é obrigatório — a data histórica da nota');

  const nfDate = new Date(invoiceDate);
  if (Number.isNaN(nfDate.getTime())) throw new Error('invoiceDate inválida');

  const oids = sessionIds.map(id => new mongoose.Types.ObjectId(id));

  const [sessions, payments] = await Promise.all([
    Session.find({ _id: { $in: oids } })
      // `appointmentId` é obrigatório no subdocumento do lote — sem ele a
      // validação do mongoose derruba a criação inteira.
      .select('_id date status patient insuranceGuide billingBatchId sessionValue specialty appointmentId')
      .lean(),
    Payment.find({ session: { $in: oids }, billingType: 'convenio' })
      .select('_id session status amount insurance').lean()
  ]);

  const guideIds = [...new Set(sessions.map(s => idOf(s.insuranceGuide)).filter(Boolean))];
  const guides = guideIds.length
    ? await InsuranceGuide.find({ _id: { $in: guideIds } }).select('_id number specialty insurance').lean()
    : [];
  const guideById = new Map(guides.map(g => [idOf(g._id), g]));

  const paysBySession = new Map();
  for (const p of payments) {
    const k = idOf(p.session);
    if (!paysBySession.has(k)) paysBySession.set(k, []);
    paysBySession.get(k).push(p);
  }

  const sessionById = new Map(sessions.map(s => [idOf(s._id), s]));
  const items = [];
  const conflicts = [];
  const warnings = [];

  for (const sid of sessionIds.map(String)) {
    const session = sessionById.get(sid);
    if (!session) {
      conflicts.push({ sessionId: sid, code: BLOCKING.SESSION_NOT_COMPLETED, detail: 'sessão não encontrada' });
      continue;
    }
    if (session.status !== 'completed') {
      conflicts.push({ sessionId: sid, code: BLOCKING.SESSION_NOT_COMPLETED, detail: `status=${session.status}` });
      continue;
    }
    if (idOf(session.patient) !== String(patientId)) {
      conflicts.push({ sessionId: sid, code: BLOCKING.WRONG_PATIENT, detail: `paciente=${idOf(session.patient)}` });
      continue;
    }
    if (session.billingBatchId) {
      conflicts.push({ sessionId: sid, code: BLOCKING.SESSION_IN_OTHER_BATCH, detail: `lote=${idOf(session.billingBatchId)}` });
      continue;
    }

    const { payment, conflict, actives } = resolveCanonicalPayment(paysBySession.get(sid) || []);
    if (conflict) {
      conflicts.push({ sessionId: sid, code: conflict, detail: `ativos=${actives.map(a => idOf(a._id)).join(',') || 'nenhum'}` });
      continue;
    }

    if (!session.appointmentId) {
      conflicts.push({ sessionId: sid, code: BLOCKING.NO_APPOINTMENT, detail: 'sessão sem appointment — obrigatório no item do lote' });
      continue;
    }

    const guide = guideById.get(idOf(session.insuranceGuide)) || null;
    const val = resolveItemValue({ documentedValue: itemValues[sid], payment });
    if (val.grossAmount == null) {
      conflicts.push({ sessionId: sid, code: BLOCKING.NO_VALUE, detail: 'sem valor no documento nem no Payment' });
      continue;
    }

    const paymentStatus = payment.insurance?.status ?? null;
    if (paymentStatus === 'received') warnings.push({ sessionId: sid, code: WARNING.ALREADY_RECEIVED, detail: 'recebimento preservado, não será alterado' });
    else if (paymentStatus === 'billed') warnings.push({ sessionId: sid, code: WARNING.ALREADY_BILLED, detail: 'já faturado, sem nova transição' });
    if (val.reconciliationDifference) warnings.push({ sessionId: sid, code: WARNING.VALUE_DIVERGES, detail: `documento ${val.grossAmount} vs payment ${val.originalPaymentAmount}` });

    items.push({
      session: session._id,
      appointment: session.appointmentId || session.appointment || null,
      guide: session.insuranceGuide || null,
      payment: payment._id,
      grossAmount: val.grossAmount,
      netAmount: null,
      status: 'sent',
      sessionDate: session.date,
      sentAt: nfDate,
      valueSource: val.valueSource,
      originalPaymentAmount: val.originalPaymentAmount,
      reconciliationDifference: val.reconciliationDifference,
      // contexto para a prévia; não persiste no subdocumento
      _guideNumber: guide?.number || null,
      _paymentStatus: paymentStatus
    });
  }

  const expectedGross = round(items.reduce((s, i) => s + i.grossAmount, 0));
  const rec = classifyReconciliation({ expectedGross, documentedGross, manualOverride });
  const dates = items.map(i => new Date(i.sessionDate)).sort((a, b) => a - b);

  const preview = {
    patient: patientId,
    insuranceProvider,
    invoiceNumber,
    invoiceDate: nfDate,
    competenceMonth: competenceMonth || (dates[0] ? dates[0].toISOString().slice(0, 7) : null),
    guides: [...new Set(items.map(i => i._guideNumber).filter(Boolean))],
    sessionCount: items.length,
    expectedGross,
    documentedGross,
    issRate,
    issAmount,
    documentedNet,
    reconciliation: rec,
    items: items.map(({ _guideNumber, _paymentStatus, ...rest }) => ({ ...rest, guideNumber: _guideNumber, paymentStatus: _paymentStatus })),
    conflicts,
    warnings,
    canWrite: conflicts.length === 0 && items.length > 0
  };

  if (dryRun) {
    logger.info('prévia (dryRun)', { invoiceNumber, itens: items.length, conflitos: conflicts.length });
    return { dryRun: true, written: false, ...preview };
  }

  if (!preview.canWrite) {
    const err = new Error(`Reconciliação bloqueada: ${conflicts.length} conflito(s)`);
    err.code = 'LEGACY_RECONCILIATION_BLOCKED';
    err.conflicts = conflicts;
    throw err;
  }

  // ── Gravação ──────────────────────────────────────────────────────────────
  const batch = await InsuranceBatch.create({
    // Prefixo histórico: nenhum relatório nem pessoa deve confundir isto com
    // faturamento executado pelo sistema.
    batchNumber: `LEGACY-NF-${invoiceNumber}-${Date.now()}`,
    insuranceProvider,
    patient: new mongoose.Types.ObjectId(patientId),
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    sentDate: nfDate,
    sessions: items.map(({ _guideNumber, _paymentStatus, ...i }) => i),
    totalGross: expectedGross,
    totalNet: documentedNet ?? (issAmount != null ? round(expectedGross - issAmount) : expectedGross),
    totalSessions: items.length,
    issRate,
    issAmount,
    invoiceNumber,
    invoiceDate: nfDate,
    status: 'sent',
    origin: 'legacy_reconciliation',
    reconciliation: {
      status: rec.status,
      reason: rec.reason ?? null,
      expectedGross,
      documentedGross,
      documentedNet,
      difference: rec.difference,
      documentReference
    },
    reconciledBy: userId ? new mongoose.Types.ObjectId(userId) : null,
    reconciledAt: new Date(),
    notes
  });

  await Session.updateMany({ _id: { $in: items.map(i => i.session) } }, { $set: { billingBatchId: batch._id } });

  // Só promove quem está pendente. `received` e `billed` ficam intactos —
  // ter a nota em papel não prova que o convênio pagou.
  const promover = items.filter(i => i._paymentStatus === 'pending_billing' || i._paymentStatus === 'pending' || i._paymentStatus == null);
  let promovidos = 0;
  if (promover.length) {
    const r = await Payment.updateMany(
      { _id: { $in: promover.map(i => i.payment) }, 'insurance.status': { $nin: ['received', 'billed'] } },
      {
        $set: {
          'insurance.status': 'billed',
          'insurance.billedAt': nfDate,               // data HISTÓRICA, não hoje
          'insurance.billedAtSource': 'legacy_reconciliation'
        }
      }
    );
    promovidos = r.modifiedCount ?? 0;
  }

  logger.info('lote legado criado', {
    batchNumber: batch.batchNumber, itens: items.length, promovidos, reconciliation: rec.status
  });

  return {
    dryRun: false,
    written: true,
    batchId: idOf(batch._id),
    batchNumber: batch.batchNumber,
    promotedPayments: promovidos,
    preservedPayments: items.length - promovidos,
    ...preview
  };
}

export default {
  reconcileLegacyInsuranceBatch,
  resolveCanonicalPayment,
  resolveItemValue,
  classifyReconciliation,
  TERMINAL_PAYMENT_STATUSES,
  BLOCKING,
  WARNING
};
