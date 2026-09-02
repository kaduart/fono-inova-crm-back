/**
 * @fileoverview Invariantes de Payment para a transição `→ paid` / `insurance.status
 * → 'received'` do recebimento de NF de convênio (baixa), extraídas dos hooks do
 * Mongoose e executadas explicitamente.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE ESTE ARQUIVO EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * Espelha exatamente o mesmo racional de
 * `services/billingSubmission/paymentBillingInvariants.js` (que cobre a transição
 * `→ billed`), mas para o lado do recebimento: `receiveInsuranceBatch()` escrevia
 * cada Payment com `transitionPaymentStatus()` + um SEGUNDO `.save()` no mesmo
 * documento — 6 round-trips Mongo por sessão (2 reads redundantes de
 * `Payment.findById`, 2 writes do mesmo Payment, 1 write de Outbox, 1 write de
 * Ledger), tudo sequencial dentro de uma única transação. Numa NF com 30 sessões
 * isso é ~185 round-trips sequenciais. A escrita virou `Payment.bulkWrite()`, que
 * é operação de driver: NÃO dispara `pre('validate')`, `pre('save')` nem
 * `post('save')`.
 *
 * Pular hook de modelo financeiro em silêncio é como o dinheiro some. Então cada
 * regra dos hooks foi auditada individualmente e classificada em três destinos:
 *
 *   REPLICADA  — a regra tem efeito nesta transição e é reproduzida aqui.
 *   ASSERÇÃO   — a regra não deveria poder disparar num Payment que chega no
 *                recebimento; em vez de reproduzir a correção silenciosa,
 *                falhamos alto. Se uma dessas disparar, o dado de entrada está
 *                corrompido e o rollback da transação é a resposta certa.
 *   N/A        — a regra é condicionada a algo que não se aplica aqui.
 *
 * A tabela abaixo é o contrato. Se algum hook de Payment.js mudar, esta tabela e
 * as funções deste arquivo precisam ser revisitadas junto — há teste de paridade
 * em tests/unit/paymentReceiptInvariants.test.js justamente para forçar isso.
 *
 * ── Payment.pre('validate') ──────────────────────────────────────────────────
 *  V1  default de billingType ......................... ASSERÇÃO (deve ser convenio)
 *  V2  patientId := patient.toString() ................ REPLICADA
 *  V3  appointmentId := appointment.toString() ........ REPLICADA
 *  V4  financialDate p/ paid|completed|confirmed ...... REPLICADA ('paid' está na lista,
 *                                                        diferente do lado 'billed')
 *  V5  kind package_consumed ⇒ isFromPackage .......... ASSERÇÃO
 *  V6  isFromPackage ⇒ paidAt = null .................. ASSERÇÃO
 *  V7  enforcement de kind não-nulo ................... REPLICADA
 *
 * ── Payment.pre('save') ──────────────────────────────────────────────────────
 *  S1  captura de $locals.previousStatus .............. SUBSTITUÍDA (ver nota 1)
 *  S2  FinancialContext session|appointment ⇒ throw ... REPLICADA (reaproveita a
 *                                                        mesma função de
 *                                                        paymentBillingInvariants.js —
 *                                                        não depende do status alvo)
 *  S3  pacote: paid→consumed / paidAt=null ............ ASSERÇÃO (o hook mascararia
 *                                                        silenciosamente um payment de
 *                                                        pacote entrando no recebimento
 *                                                        de convênio; aqui falha alto)
 *  S4  status 'paid' sem paidAt ⇒ throw ............... REPLICADA (guarda defensiva:
 *                                                        buildReceivedUpdate nunca deve
 *                                                        produzir status='paid' sem
 *                                                        paidAt no mesmo $set)
 *  S5  financialDate p/ paid|completed|confirmed ...... REPLICADA (mesmo efeito de V4;
 *                                                        um único campo no $set cobre as
 *                                                        duas origens do hook)
 *  S6  isFromPackage && financialDate ⇒ throw ......... ASSERÇÃO
 *  S7  billingType 'prepaid' ⇒ throw .................. ASSERÇÃO
 *
 * ── Payment.post('save') ─────────────────────────────────────────────────────
 *  Nota 1: o safety-net do post-save publica PAYMENT_STATUS_CHANGED quando alguém
 *  troca status por fora do paymentStatusService. No fluxo de recebimento o
 *  evento é escrito explicitamente no Outbox (1 por Payment, mesmo eventId
 *  determinístico de hoje) — o resultado observável é idêntico, sem depender de
 *  um hook que roda fora da transação.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DIFERENÇAS DELIBERADAS EM RELAÇÃO AO FLUXO ANTIGO (2x .save())
 * ─────────────────────────────────────────────────────────────────────────────
 * a) O fluxo antigo não tocava `insurance.netAmount` — só grossAmount, issRate,
 *    issAmount, receivedAmount, receivedAt. Este módulo preserva exatamente isso:
 *    netAmount entra só pela materialização de default (item b), nunca é setado
 *    com o valor rateado.
 *
 * b) NÃO há diferença na materialização de defaults. O primeiro `.save()` do
 *    fluxo antigo (dentro de transitionPaymentStatus) já materializava, ao
 *    hidratar o documento, os defaults do schema que estivessem ausentes
 *    (`insurance.netAmount`, `insurance.receivedAmount`, `insurance.issRate`,
 *    `insurance.issAmount`, `splitMethods`) — mesmo que o valor de negócio real só
 *    fosse escrito no segundo `.save()`. O bulkWrite não hidrata, então a
 *    materialização é feita aqui para manter o documento gravado idêntico ao do
 *    fluxo antigo. Valores já existentes são preservados; o default só entra
 *    quando o campo está ausente.
 *
 * c) `paymentMethod` é sobrescrito para 'convenio' incondicionalmente — replica
 *    o comportamento de transitionPaymentStatus (`if (paymentMethod) payment.
 *    paymentMethod = paymentMethod`), que `receiveInsuranceBatch` sempre chamava
 *    passando `paymentMethod: 'convenio'`.
 */

import { assertFinancialContextAllowsPaymentWrite } from '../billingSubmission/paymentBillingInvariants.js';
import { resolvePaymentKind } from '../../utils/resolvePaymentKind.js';
import { isPackageConsumptionPayment } from '../../utils/packageConsumptionPayment.js';

/** Reexportada por conveniência — mesma checagem, independente do status alvo. */
export { assertFinancialContextAllowsPaymentWrite };

/** Status de `insurance.status` aceitos para entrar em `received` via baixa de NF. */
export const RECEIVABLE_SOURCE_INSURANCE_STATUSES = Object.freeze(['billed']);

/**
 * Defaults do schema de Payment que o `.save()` materializava no documento
 * durante o recebimento. Mesma lista/racional de
 * `paymentBillingInvariants.js#MATERIALIZED_DEFAULTS` — duplicada aqui de
 * propósito porque as duas listas podem divergir no futuro (ex: um novo campo
 * relevante só numa das duas transições) e cada arquivo deve ficar auditável
 * isoladamente contra Payment.js.
 *
 * ⚠️ Precisa acompanhar os defaults declarados em models/Payment.js.
 */
const MATERIALIZED_DEFAULTS = Object.freeze([
  { path: 'insurance.netAmount', read: payment => payment.insurance?.netAmount, value: 0 },
  { path: 'insurance.receivedAmount', read: payment => payment.insurance?.receivedAmount, value: 0 },
  { path: 'insurance.issRate', read: payment => payment.insurance?.issRate, value: 0 },
  { path: 'insurance.issAmount', read: payment => payment.insurance?.issAmount, value: 0 },
  { path: 'splitMethods', read: payment => payment.splitMethods, value: [] }
]);

export class PaymentReceiptInvariantError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PaymentReceiptInvariantError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Executa as ASSERÇÕES da tabela contra um Payment que está prestes a ser
 * recebido (baixa de NF). Qualquer violação aborta a transação inteira — é
 * dado corrompido chegando no núcleo financeiro, não caso de uso.
 *
 * NÃO valida `insurance.status === 'billed'` — essa é uma precondição de
 * negócio específica de `receiveInsuranceBatch` (guia/NF ainda não recebida),
 * não uma regra derivada de hook de Payment.js, e continua sendo checada ali,
 * no mesmo lugar de hoje.
 *
 * @param {Object} payment documento lean de Payment
 */
export function assertPaymentReceivable(payment) {
  const id = payment?._id?.toString?.() || 'desconhecido';

  if (!payment) {
    throw new PaymentReceiptInvariantError('PAYMENT_MISSING', 'Payment ausente no escopo do recebimento');
  }

  // V1 — billingType precisa ser convenio; o default 'particular' do hook
  // mascararia um payment que nunca deveria estar numa baixa de convênio.
  if (payment.billingType !== 'convenio') {
    throw new PaymentReceiptInvariantError(
      'PAYMENT_BILLING_TYPE_INVALID',
      `Payment ${id} não é de convênio (billingType=${payment.billingType ?? 'null'})`,
      { paymentId: id, billingType: payment.billingType ?? null }
    );
  }

  // S7 — guarda legado: prepaid foi removido do domínio.
  if (payment.billingType === 'prepaid') {
    throw new PaymentReceiptInvariantError(
      'PREPAID_BILLING_TYPE_DEPRECATED',
      `[FINANCIAL_LOCK] billingType='prepaid' foi removido do domínio.`,
      { paymentId: id }
    );
  }

  // V5 / V6 / S3 — consumo de pacote não é recebível de convênio. Os hooks
  // "corrigiam" isso silenciosamente (paid→consumed, paidAt=null); aqui isso é
  // sintoma de dado errado entrando na baixa, então falha.
  if (isPackageConsumptionPayment(payment)) {
    throw new PaymentReceiptInvariantError(
      'PAYMENT_IS_PACKAGE_CONSUMPTION',
      `Payment ${id} é consumo de pacote e não pode ser recebido como convênio`,
      { paymentId: id, isFromPackage: !!payment.isFromPackage, kind: payment.kind ?? null }
    );
  }

  // S6 — redundante com a guarda acima enquanto isFromPackage for falso, mas
  // mantida porque é uma invariante independente no hook original.
  if (payment.isFromPackage && payment.financialDate) {
    throw new PaymentReceiptInvariantError(
      'PACKAGE_PAYMENT_CANNOT_HAVE_FINANCIAL_DATE',
      `[FINANCIAL_LOCK] Payment ${id} de consumo de pacote não pode ter financialDate`,
      { paymentId: id }
    );
  }
}

/**
 * Monta o `$set` da transição `→ paid` / `insurance.status → 'received'` para
 * um Payment, aplicando as regras REPLICADAS da tabela.
 *
 * Não escreve nada: devolve o patch para o chamador agregar num bulkWrite.
 * O filtro otimista (`_id` + `status` + `insurance.status` observados) é
 * responsabilidade do chamador, não deste módulo — mesma separação de
 * responsabilidade de `buildBilledUpdate`.
 *
 * @param {Object} payment documento lean de Payment (já validado por assertPaymentReceivable)
 * @param {Object} ctx
 * @param {Date}   ctx.now         data real do processamento (updatedAt)
 * @param {Date}   ctx.receivedAt  data histórica do recebimento (paidAt/financialDate/insurance.receivedAt)
 * @param {number} ctx.grossAmount valor bruto desta sessão na NF
 * @param {number} ctx.netAmount   valor líquido rateado desta sessão (ver allocateNetAmounts)
 * @param {number} ctx.issRate     alíquota de ISS aplicada ao lote
 * @returns {{ set: Object, warnings: string[] }}
 */
export function buildReceivedUpdate(payment, { now, receivedAt, grossAmount, netAmount, issRate }) {
  const warnings = [];

  const set = {
    status: 'paid',
    // V4/S5 — financialDate para status paid, só se ainda ausente (paridade
    // com !payment.financialDate no fluxo antigo).
    ...(payment.financialDate ? {} : { financialDate: receivedAt }),
    // paidAt só se ainda ausente — preserva timestamp original em reprocessamento.
    ...(payment.paidAt ? {} : { paidAt: receivedAt }),
    paymentMethod: 'convenio',
    'insurance.status': 'received',
    'insurance.grossAmount': grossAmount,
    'insurance.issRate': Number(issRate || 0),
    'insurance.issAmount': round(grossAmount - netAmount),
    'insurance.receivedAmount': netAmount,
    'insurance.receivedAt': receivedAt,
    updatedAt: now,
    // 🛡️ Autoriza esta escrita perante o AppointmentWriteGuard — mesma flag que
    // transitionPaymentStatus() usa via payment._fromPaymentStatusService=true
    // antes do .save(). Sem isto o guard registra hasAuthorizedFlag:false.
    _fromPaymentStatusService: true
  };

  // S4 — guarda defensiva: nunca produzir status='paid' sem paidAt resultante.
  if (!set.paidAt && !payment.paidAt) {
    throw new PaymentReceiptInvariantError(
      'MISSING_PAID_AT',
      `[FINANCIAL LOCK] paidAt é obrigatório quando status='paid' (Payment ${payment._id?.toString?.()})`,
      { paymentId: payment._id?.toString?.() }
    );
  }

  // Paridade com o .save(): materializa os defaults do schema que estiverem
  // ausentes, sem tocar em nada que já tenha valor. `path in set` é a guarda
  // crítica aqui — diferente de buildBilledUpdate, este $set já escreve valor
  // de negócio em insurance.receivedAmount/issRate/issAmount explicitamente
  // acima; sem essa guarda, a materialização re-zeraria esses três campos
  // sempre que o Payment ainda não os tivesse (o caso comum, primeira baixa).
  // Só insurance.netAmount e splitMethods nunca entram no $set de negócio
  // (nota "a" no cabeçalho), então só eles realmente passam por aqui na prática.
  for (const { path, read, value } of MATERIALIZED_DEFAULTS) {
    if (!(path in set) && read(payment) === undefined) {
      set[path] = Array.isArray(value) ? [...value] : value;
    }
  }

  // V2 — backfill de patientId (compatibilidade V2).
  if (payment.patient && !payment.patientId) {
    set.patientId = payment.patient.toString();
    warnings.push('patientId ausente reconstruído a partir de patient');
  }

  // V3 — backfill de appointmentId (compatibilidade V2).
  if (payment.appointment && !payment.appointmentId) {
    set.appointmentId = payment.appointment.toString();
    warnings.push('appointmentId ausente reconstruído a partir de appointment');
  }

  // V7 — enforcement de kind. O hook infere e persiste quando kind está nulo.
  if (!payment.kind) {
    const inferred = resolvePaymentKind(payment);
    if (inferred.kind === 'unknown_or_orphan' && inferred.confidence === 'low') {
      throw new PaymentReceiptInvariantError(
        'PAYMENT_KIND_UNKNOWN',
        `[PAYMENT_KIND_ENFORCEMENT] Não foi possível inferir kind para o payment ${payment._id}`,
        { paymentId: payment._id?.toString?.() }
      );
    }
    set.kind = inferred.kind;
    set.kindConfidence = inferred.confidence;
    set.kindSource = 'inferred_on_receipt';
    warnings.push(`kind ausente inferido como '${inferred.kind}' (${inferred.confidence})`);
  }

  return { set, warnings };
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export default {
  RECEIVABLE_SOURCE_INSURANCE_STATUSES,
  PaymentReceiptInvariantError,
  assertFinancialContextAllowsPaymentWrite,
  assertPaymentReceivable,
  buildReceivedUpdate
};
