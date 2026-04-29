/**
 * 💵 FinancialGuardError
 *
 * Erro padronizado para todas as falhas do FinancialGuard.
 * Permite código consistente, log estruturado e debug facilitado.
 */

export default class FinancialGuardError extends Error {
  constructor(code, meta = {}) {
    const message = FinancialGuardError.MESSAGES[code] || `FinancialGuard: ${code}`;
    super(message);
    this.name = 'FinancialGuardError';
    this.code = code;
    this.meta = meta;
    this.handled = true; // sinaliza que o guard já processou
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      meta: this.meta
    };
  }

  static MESSAGES = {
    NO_PAYMENT_DATA: 'Nenhum dado de pagamento fornecido (paymentIds ou payment)',
    NO_PAYMENTS_FOUND: 'Nenhum payment encontrado para os IDs fornecidos',
    CONTEXT_NOT_SUPPORTED: 'Contexto não suportado pelo guard',
    PAYMENT_FLOW_BLOCKED: 'Quitação manual bloqueada para este billingType',
    PACKAGE_LINK_INVALID: 'Vínculo entre payment e pacote é inválido',
    PAYMENT_PACKAGE_MISMATCH: 'Payment pertence a outro pacote',
    APPOINTMENT_PACKAGE_MISMATCH: 'Appointment vinculado a outro pacote',
    BILLING_TYPE_NOT_MAPPED: 'Tipo de faturamento não possui guard configurado'
  };
}
