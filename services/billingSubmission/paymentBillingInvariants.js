/**
 * @fileoverview Invariantes de Payment para a transição `→ billed` do faturamento
 * de convênio, extraídas dos hooks do Mongoose e executadas explicitamente.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE ESTE ARQUIVO EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * `finalizeBillingSubmission` escrevia cada Payment com `.save()`, o que custava
 * 4 round-trips por sessão e estourava o timeout do cliente em lotes grandes.
 * A escrita virou `Payment.bulkWrite()`, que é uma operação de driver: NÃO dispara
 * `pre('validate')`, `pre('save')` nem `post('save')`.
 *
 * Pular hook de modelo financeiro em silêncio é como o dinheiro some. Então cada
 * regra dos hooks foi auditada individualmente e classificada em três destinos:
 *
 *   REPLICADA  — a regra tem efeito nesta transição e é reproduzida aqui.
 *   ASSERÇÃO   — a regra não deveria poder disparar num Payment de convênio;
 *                em vez de reproduzir a correção silenciosa, falhamos alto. Se
 *                uma dessas disparar, o dado de entrada está corrompido e o
 *                rollback da transação é a resposta certa.
 *   N/A        — a regra é condicionada a um status que não é `billed`.
 *
 * A tabela abaixo é o contrato. Se algum hook de Payment.js mudar, esta tabela e
 * as funções deste arquivo precisam ser revisitadas junto — há teste de paridade
 * em tests/unit/paymentBillingInvariants.test.js justamente para forçar isso.
 *
 * ── Payment.pre('validate') ──────────────────────────────────────────────────
 *  V1  default de billingType ......................... ASSERÇÃO (deve ser convenio)
 *  V2  patientId := patient.toString() ................ REPLICADA
 *  V3  appointmentId := appointment.toString() ........ REPLICADA
 *  V4  financialDate p/ paid|completed|confirmed ...... N/A ('billed' fora da lista)
 *  V5  kind package_consumed ⇒ isFromPackage .......... ASSERÇÃO
 *  V6  isFromPackage ⇒ paidAt = null .................. ASSERÇÃO
 *  V7  enforcement de kind não-nulo ................... REPLICADA
 *
 * ── Payment.pre('save') ──────────────────────────────────────────────────────
 *  S1  captura de $locals.previousStatus .............. SUBSTITUÍDA (ver nota 1)
 *  S2  FinancialContext session|appointment ⇒ throw ... REPLICADA
 *  S3  pacote: paid→consumed / paidAt=null ............ ASSERÇÃO
 *  S4  status 'paid' sem paidAt ⇒ throw ............... N/A (status é 'billed')
 *  S5  financialDate p/ paid|completed|confirmed ...... N/A
 *  S6  isFromPackage && financialDate ⇒ throw ......... ASSERÇÃO
 *  S7  billingType 'prepaid' ⇒ throw .................. ASSERÇÃO
 *
 * ── Payment.post('save') ─────────────────────────────────────────────────────
 *  Nota 1: o safety-net do post-save publica PAYMENT_STATUS_CHANGED quando alguém
 *  troca status por fora do paymentStatusService. No fluxo atual ele já era
 *  suprimido por `__statusChangedEmitted = true`, com o evento indo pro Outbox
 *  dentro da transação. Continuamos escrevendo o mesmo evento no Outbox, com o
 *  mesmo eventId determinístico — o resultado observável é idêntico, e agora sem
 *  depender de um hook que roda fora da transação.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DIFERENÇAS DELIBERADAS EM RELAÇÃO AO .save()
 * ─────────────────────────────────────────────────────────────────────────────
 * a) `transitionPaymentStatus` faz `payment.billedAt = new Date()` para status
 *    'billed', mas `billedAt` NÃO existe no schema de Payment — o strict mode do
 *    Mongoose descarta a atribuição antes de chegar no driver. Confirmado no log
 *    de produção (o $set só carrega `insurance.billedAt`). Não recriamos o campo
 *    aqui: inventá-lo agora seria mudar o schema por acidente.
 *
 * b) NÃO há diferença na materialização de defaults. O `.save()` gravava os
 *    defaults do schema que faltavam no documento (`insurance.netAmount`,
 *    `receivedAmount`, `issRate`, `issAmount`, `splitMethods`) e o bulkWrite faz
 *    o mesmo — ver MATERIALIZED_DEFAULTS abaixo. Valores já existentes são
 *    preservados; o default só entra quando o campo está ausente, que é
 *    exatamente quando o Mongoose o aplicaria ao hidratar o documento.
 */

import { FinancialContext } from '../../utils/financialContext.js';
import { resolvePaymentKind } from '../../utils/resolvePaymentKind.js';
import { isPackageConsumptionPayment } from '../../utils/packageConsumptionPayment.js';

/** Status de origem aceitos para entrar em `billed` via faturamento. */
export const BILLABLE_SOURCE_STATUSES = Object.freeze(['pending', 'pending_billing']);

/**
 * Defaults do schema de Payment que o `.save()` materializava no documento.
 *
 * Quando o Mongoose hidrata um documento cujo caminho está ausente, ele aplica o
 * default; o `.save()` seguinte então persiste esse valor. O bulkWrite não passa
 * por hidratação, então a materialização é feita aqui para manter o documento
 * gravado idêntico ao do fluxo antigo.
 *
 * A chave é o caminho no `$set`; `read` localiza o valor atual no documento lean.
 * Só entra no update quando o valor atual é `undefined` — que é precisamente a
 * condição em que o Mongoose aplicaria o default. Um `null` gravado é valor, não
 * ausência, e é preservado como estava.
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

export class PaymentInvariantError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PaymentInvariantError';
    this.code = code;
    this.details = details;
  }
}

/**
 * S2 — replica a blindagem de contexto financeiro do pre('save').
 *
 * Chamada uma vez por transação (e não por Payment): o contexto é global ao
 * processo, então checar N vezes o mesmo valor não agrega nada.
 */
export function assertFinancialContextAllowsPaymentWrite() {
  const ctx = FinancialContext.get();
  if (ctx === 'session' || ctx === 'appointment') {
    console.error(`[SECURITY BLOCK] Tentativa de save em Payment por ${ctx} bloqueada`);
    throw new PaymentInvariantError(
      'PAYMENT_WRITE_FORBIDDEN_CONTEXT',
      `[SECURITY] ${ctx} não pode criar/atualizar Payment diretamente`
    );
  }
}

/**
 * Executa as ASSERÇÕES da tabela contra um Payment que está prestes a ser
 * faturado. Qualquer violação aborta a transação inteira — é dado corrompido
 * chegando no núcleo financeiro, não caso de uso.
 *
 * @param {Object} payment documento lean de Payment
 */
export function assertPaymentBillable(payment) {
  const id = payment?._id?.toString?.() || 'desconhecido';

  if (!payment) {
    throw new PaymentInvariantError('PAYMENT_MISSING', 'Payment ausente no escopo do faturamento');
  }

  // V1 — billingType precisa ser convenio; o default 'particular' do hook
  // mascararia um payment que nunca deveria estar num lote de convênio.
  if (payment.billingType !== 'convenio') {
    throw new PaymentInvariantError(
      'PAYMENT_BILLING_TYPE_INVALID',
      `Payment ${id} não é de convênio (billingType=${payment.billingType ?? 'null'})`,
      { paymentId: id, billingType: payment.billingType ?? null }
    );
  }

  // S7 — guarda legado: prepaid foi removido do domínio.
  if (payment.billingType === 'prepaid') {
    throw new PaymentInvariantError(
      'PREPAID_BILLING_TYPE_DEPRECATED',
      `[FINANCIAL_LOCK] billingType='prepaid' foi removido do domínio.`,
      { paymentId: id }
    );
  }

  // V5 / V6 / S3 — consumo de pacote não é recebível de convênio. Os hooks
  // "corrigiam" isso mudando status e zerando paidAt; aqui isso é sintoma de
  // dado errado entrando no lote, então falha. Checagem centralizada em
  // utils/packageConsumptionPayment.js — reutilizada também por
  // insuranceBatchService.js e paymentStatusService.js.
  if (isPackageConsumptionPayment(payment)) {
    throw new PaymentInvariantError(
      'PAYMENT_IS_PACKAGE_CONSUMPTION',
      `Payment ${id} é consumo de pacote e não pode ser faturado como convênio`,
      { paymentId: id, isFromPackage: !!payment.isFromPackage, kind: payment.kind ?? null }
    );
  }

  // S6 — redundante com a guarda acima enquanto isFromPackage for falso, mas
  // mantida porque é uma invariante independente no hook original.
  if (payment.isFromPackage && payment.financialDate) {
    throw new PaymentInvariantError(
      'PACKAGE_PAYMENT_CANNOT_HAVE_FINANCIAL_DATE',
      `[FINANCIAL_LOCK] Payment ${id} de consumo de pacote não pode ter financialDate`,
      { paymentId: id }
    );
  }

  // Pré-condição do próprio faturamento (já validada em validateSessionScope,
  // repetida aqui para que o módulo seja seguro isoladamente).
  if (!BILLABLE_SOURCE_STATUSES.includes(payment.status)) {
    throw new PaymentInvariantError(
      'PAYMENT_STATUS_NOT_BILLABLE',
      `Payment ${id} está em '${payment.status}' e não pode transicionar para 'billed'`,
      { paymentId: id, status: payment.status }
    );
  }
}

/**
 * Monta o `$set` da transição `→ billed` para um Payment, aplicando as regras
 * REPLICADAS da tabela.
 *
 * Não escreve nada: devolve o patch para o chamador agregar num bulkWrite.
 *
 * @param {Object} payment documento lean de Payment (já validado)
 * @param {{ now: Date }} ctx
 * @returns {{ set: Object, warnings: string[] }}
 */
export function buildBilledUpdate(payment, { now }) {
  const warnings = [];

  const set = {
    status: 'billed',
    'insurance.status': 'billed',
    updatedAt: now,
    // 🛡️ Contexto autorizado oficial do AppointmentWriteGuard para o fluxo de
    // convênio. Sem isto o guard registra hasAuthorizedFlag:false e, em modo
    // 'strict', bloquearia a finalização inteira.
    _fromInsuranceOrchestrator: true
  };

  // Espelha transitionPaymentStatus: billedAt/billedAtSource só são gravados na
  // primeira vez, preservando o carimbo original em reprocessamentos.
  if (!payment.insurance?.billedAt) {
    set['insurance.billedAt'] = now;
    set['insurance.billedAtSource'] = 'paymentStatusService';
  }

  // Paridade com o .save(): materializa os defaults do schema que estiverem
  // ausentes, sem tocar em nada que já tenha valor.
  for (const { path, read, value } of MATERIALIZED_DEFAULTS) {
    if (read(payment) === undefined) {
      set[path] = Array.isArray(value) ? [...value] : value;
    }
  }

  // V2 — backfill de patientId (compatibilidade V2).
  if (payment.patient && !payment.patientId) {
    set.patientId = payment.patient.toString();
    warnings.push(`patientId ausente reconstruído a partir de patient`);
  }

  // V3 — backfill de appointmentId (compatibilidade V2).
  if (payment.appointment && !payment.appointmentId) {
    set.appointmentId = payment.appointment.toString();
    warnings.push(`appointmentId ausente reconstruído a partir de appointment`);
  }

  // V7 — enforcement de kind. O hook infere e persiste quando kind está nulo;
  // documentos anteriores ao enforcement dependem disso. Se nem a inferência
  // resolver, o hook lançava — aqui também.
  if (!payment.kind) {
    const inferred = resolvePaymentKind(payment);
    if (inferred.kind === 'unknown_or_orphan' && inferred.confidence === 'low') {
      throw new PaymentInvariantError(
        'PAYMENT_KIND_UNKNOWN',
        `[PAYMENT_KIND_ENFORCEMENT] Não foi possível inferir kind para o payment ${payment._id}`,
        { paymentId: payment._id?.toString?.() }
      );
    }
    set.kind = inferred.kind;
    set.kindConfidence = inferred.confidence;
    set.kindSource = 'inferred_on_billing';
    warnings.push(`kind ausente inferido como '${inferred.kind}' (${inferred.confidence})`);
  }

  return { set, warnings };
}

export default {
  BILLABLE_SOURCE_STATUSES,
  PaymentInvariantError,
  assertFinancialContextAllowsPaymentWrite,
  assertPaymentBillable,
  buildBilledUpdate
};
