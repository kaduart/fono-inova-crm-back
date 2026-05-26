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
