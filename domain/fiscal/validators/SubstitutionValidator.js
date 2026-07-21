// domain/fiscal/validators/SubstitutionValidator.js
// Substituição só é aceita sobre uma NFS-e AUTHORIZED (não rascunho, não já cancelada/substituída) —
// o mecanismo oficial de substituição gera automaticamente um Cancelamento por Substituição
// (event_matrix.md #2) vinculado à nota original, então a nota original precisa estar num estado
// que aceite esse evento.

import { officialFiscalEventRepository } from '../../../infrastructure/persistence/OfficialFiscalEventRepository.js';
import { reconstructState, validateIncomingEvent } from '../stateMachine/FiscalStateMachineService.js';
import { TipoEvento } from '../../../constants/fiscalEvents.js';
import { FiscalInvoiceStatus } from '../../../constants/fiscalEnums.js';

export async function validateSubstitution(fiscalInvoice) {
  const reasons = [];

  if (fiscalInvoice.substitutedBy) {
    reasons.push('FISCAL_INVOICE_JA_SUBSTITUIDA');
    return { eligible: false, reasons };
  }

  if (fiscalInvoice.status === FiscalInvoiceStatus.DRAFT || fiscalInvoice.status === FiscalInvoiceStatus.PENDING_SUBMISSION) {
    reasons.push('FISCAL_INVOICE_AINDA_NAO_AUTORIZADA');
    return { eligible: false, reasons };
  }

  const events = await officialFiscalEventRepository.findByFiscalInvoice(fiscalInvoice._id);
  const currentState = reconstructState(events);

  const check = validateIncomingEvent(currentState, { tipoEvento: TipoEvento.CANCELAMENTO_POR_SUBSTITUICAO });
  if (!check.allowed) reasons.push(check.reason);

  return { eligible: reasons.length === 0, reasons };
}
