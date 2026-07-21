// domain/fiscal/specifications/CanCancelFiscalInvoiceSpecification.js
import { validateCancellation } from '../validators/CancellationValidator.js';

export class CanCancelFiscalInvoiceSpecification {
  constructor() {
    this.lastReasons = [];
  }

  async isSatisfiedBy(fiscalInvoice) {
    const { eligible, reasons } = await validateCancellation(fiscalInvoice);
    this.lastReasons = reasons;
    return eligible;
  }
}
