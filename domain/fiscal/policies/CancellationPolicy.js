// domain/fiscal/policies/CancellationPolicy.js
import { CanCancelFiscalInvoiceSpecification } from '../specifications/CanCancelFiscalInvoiceSpecification.js';

/**
 * @returns {Promise<{ proceed: boolean, reasons: string[], triggersFinancialReversal: false }>}
 */
export async function decideCancellation(fiscalInvoice) {
  const spec = new CanCancelFiscalInvoiceSpecification();
  const eligible = await spec.isSatisfiedBy(fiscalInvoice);

  return {
    proceed: eligible,
    reasons: spec.lastReasons,
    // Invariante #3 (Fase 2): cancelamento fiscal NUNCA dispara estorno financeiro automático —
    // sempre false, decisão de estorno é ação separada e manual do usuário no Financeiro.
    triggersFinancialReversal: false
  };
}
