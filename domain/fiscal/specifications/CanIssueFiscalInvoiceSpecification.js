// domain/fiscal/specifications/CanIssueFiscalInvoiceSpecification.js
// Specification Pattern — encapsula a pergunta booleana "posso emitir?" para o Service não
// precisar acumular ifs. Guarda a última razão de rejeição para o chamador construir o erro.
import { validateEmissionEligibility } from '../validators/EmissionEligibilityValidator.js';

export class CanIssueFiscalInvoiceSpecification {
  constructor() {
    this.lastReasons = [];
  }

  async isSatisfiedBy(draft) {
    const { eligible, reasons } = await validateEmissionEligibility(draft);
    this.lastReasons = reasons;
    return eligible;
  }
}
