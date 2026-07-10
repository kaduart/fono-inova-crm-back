/**
 * 💰 CONSTANTES FINANCEIRAS CENTRALIZADAS
 *
 * REGRA DE OURO:
 *   Qualquer código que mencione 'package_receipt', 'session_payment',
 *   'convenio', 'liminar', etc., DEVE importar daqui.
 *
 * Isso elimina "string typing" espalhado e garante que renomeações
 * ou adições de categoria propaguem atomicamente.
 */

// ─── Payment.kind ───
export const PAYMENT_KIND = Object.freeze({
  PACKAGE_RECEIPT: 'package_receipt',
  REVENUE_RECOGNITION: 'revenue_recognition',
  SESSION_PAYMENT: 'session_payment',
  APPOINTMENT_PAYMENT: 'appointment_payment',
  PACKAGE_CONSUMED: 'package_consumed',
  MONTHLY_SETTLEMENT: 'monthly_settlement',
  DEBT_SETTLEMENT: 'debt_settlement',
});

// ─── Kinds que NUNCA devem somar como caixa/receita direta ───
// Motivo por kind:
//   PACKAGE_CONSUMED  → consumo de crédito já pago na compra, não é dinheiro novo
//   PACKAGE_RECEIPT   → a venda do pacote já é contada; sessões individuais não somam de novo
//   MONTHLY_SETTLEMENT/DEBT_SETTLEMENT → recibo agregado; os session_payment originais
//     que ele lista em `settledPaymentIds` já são contados individualmente — somar os
//     dois é dupla contagem (bug real encontrado em produção 2026-07-07, ver
//     back/docs/finance-integrity-audit/).
// Toda query que soma `Payment.amount WHERE status='paid'` DEVE excluir esses kinds.
//
// ⚠️ NÃO tocar nesta constante pra corrigir o caso "particularPaid zerado em pacote
// prepaid" (2026-07-10) — ela é usada por paymentSync.service.js com uma semântica
// própria (package_receipt nunca é reconciliado por edição de paymentForms, motivo
// diferente do "caixa"). O fix desse caso fica local em financialSummary.js, escopado
// por packageId — ver PARTICULAR_CASH_EXCLUDED_KINDS lá.
export const CASH_EXCLUDED_KINDS = Object.freeze([
  PAYMENT_KIND.PACKAGE_CONSUMED,
  PAYMENT_KIND.PACKAGE_RECEIPT,
  PAYMENT_KIND.MONTHLY_SETTLEMENT,
  PAYMENT_KIND.DEBT_SETTLEMENT,
]);

// ─── Payment.status ───
export const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  PARTIAL: 'partial',
  PAID: 'paid',
  CANCELED: 'canceled',
  REFUNDED: 'refunded',
  CONVERTED_TO_PACKAGE: 'converted_to_package',
  RECOGNIZED: 'recognized',
  CONSUMED: 'consumed',
});

// ─── Payment.billingType ───
export const BILLING_TYPE = Object.freeze({
  PARTICULAR: 'particular',
  CONVENIO: 'convenio',
  INSURANCE: 'insurance',
  LIMINAR: 'liminar',
});

// ─── Session.paymentStatus ───
export const SESSION_PAYMENT_STATUS = Object.freeze({
  PAID: 'paid',
  PARTIAL: 'partial',
  PENDING: 'pending',
  UNPAID: 'unpaid',
  PENDING_RECEIPT: 'pending_receipt',
  RECOGNIZED: 'recognized',
  PACKAGE_PAID: 'package_paid',
  PENDING_BALANCE: 'pending_balance',
});

// ─── Session.paymentOrigin ───
export const SESSION_PAYMENT_ORIGIN = Object.freeze({
  AUTO_PER_SESSION: 'auto_per_session',
  MANUAL_BALANCE: 'manual_balance',
  PACKAGE_PREPAID: 'package_prepaid',
  CONVENIO: 'convenio',
  LIMINAR: 'liminar',
  LIMINAR_CREDIT: 'liminar_credit',
  INDIVIDUAL: 'individual',
  UPDATED: 'updated',
  EXISTING: 'existing',
});

// ─── Session.status ───
export const SESSION_STATUS = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  CANCELED: 'canceled',
  SCHEDULED: 'scheduled',
});

// ─── Payment.method (canonical) ───
export const PAYMENT_METHOD = Object.freeze({
  PIX: 'pix',
  DINHEIRO: 'dinheiro',
  CARTAO: 'cartão',
  CONVENIO: 'convenio',
  LIMINAR_CREDIT: 'liminar_credit',
  CREDITO: 'credito',
  DEBITO: 'debito',
  CARTAO_CREDITO: 'cartao_credito',
  CARTAO_DEBITO: 'cartao_debito',
  TRANSFERENCIA: 'transferencia',
  TRANSFERENCIA_BANCARIA: 'transferencia_bancaria',
});

// ─── Tipo de pacote (usado em valuation e caixa) ───
export const PACKAGE_MODEL = Object.freeze({
  PREPAID: 'prepaid',       // dinheiro entra na compra; sessões = consumo
  PER_SESSION: 'per_session', // dinheiro entra na sessão
  FULL: 'full',             // sinônimo legado de prepaid
});

// ─── Categorias financeiras de Caixa ───
export const CAIXA_CATEGORY = Object.freeze({
  PARTICULAR: 'particular',
  PACOTE: 'pacote',
  CONVENIO: 'convenio',
  LIMINAR: 'liminar',
});

// ─── Métodos de caixa (para byMethod) ───
export const CAIXA_METHOD = Object.freeze({
  PIX: 'pix',
  DINHEIRO: 'dinheiro',
  CARTAO: 'cartao',
  OUTROS: 'outros',
});

// ─── Regras de data ───
export const DATE_RULE = Object.freeze({
  /** Caixa / DRE: quando o dinheiro entrou ou deve ser reconhecido */
  CASH: 'financialDate || paymentDate',
  /** Competência clínica: quando o serviço foi realizado */
  COMPETENCE: 'appointment.date || session.date',
  /** Auditoria operacional: quando foi quitado de fato */
  AUDIT_PAID: 'paidAt',
  /** Auditoria técnica: quando o documento foi criado */
  AUDIT_CREATED: 'createdAt',
});
