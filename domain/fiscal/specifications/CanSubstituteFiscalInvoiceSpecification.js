// domain/fiscal/specifications/CanSubstituteFiscalInvoiceSpecification.js
import { validateSubstitution } from '../validators/SubstitutionValidator.js';

export class CanSubstituteFiscalInvoiceSpecification {
  constructor() {
    this.lastReasons = [];
  }

  async isSatisfiedBy(fiscalInvoice) {
    const { eligible, reasons } = await validateSubstitution(fiscalInvoice);
    this.lastReasons = reasons;
    return eligible;
  }
}
