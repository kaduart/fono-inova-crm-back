// domain/fiscal/validators/CancellationValidator.js
// Checagem de fatos para cancelamento — a máquina de estados (FiscalStateMachineService) é a
// única fonte de verdade sobre transição válida; este validator só traduz isso em uma resposta
// de negócio amigável antes de chegar lá, evitando I/O desnecessário em casos óbvios.

import { officialFiscalEventRepository } from '../../../infrastructure/persistence/OfficialFiscalEventRepository.js';
import { reconstructState, validateIncomingEvent } from '../stateMachine/FiscalStateMachineService.js';
import { TipoEvento } from '../../../constants/fiscalEvents.js';
import { FiscalInvoiceStatus } from '../../../constants/fiscalEnums.js';

/**
 * @param {Object} fiscalInvoice
 * @returns {Promise<{ eligible: boolean, reasons: string[] }>}
 */
export async function validateCancellation(fiscalInvoice) {
  const reasons = [];

  if (fiscalInvoice.status === FiscalInvoiceStatus.DRAFT || fiscalInvoice.status === FiscalInvoiceStatus.PENDING_SUBMISSION) {
    reasons.push('FISCAL_INVOICE_AINDA_NAO_AUTORIZADA');
    return { eligible: false, reasons };
  }

  const events = await officialFiscalEventRepository.findByFiscalInvoice(fiscalInvoice._id);
  const currentState = reconstructState(events);

  const check = validateIncomingEvent(currentState, { tipoEvento: TipoEvento.CANCELAMENTO });
  if (!check.allowed) reasons.push(check.reason);

  return { eligible: reasons.length === 0, reasons };
}
