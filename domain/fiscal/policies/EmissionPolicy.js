// domain/fiscal/policies/EmissionPolicy.js
// Decisão de emissão = elegibilidade estrutural (Specification) + regra de liminar quando
// aplicável. FiscalInvoiceService consulta só esta policy, nunca a Specification diretamente.

import { CanIssueFiscalInvoiceSpecification } from '../specifications/CanIssueFiscalInvoiceSpecification.js';
import { decideLiminarFlow } from './LiminarPolicy.js';
import { LiminarFlow } from '../../../constants/fiscalEnums.js';

/**
 * @param {Object} draft - dados da FiscalInvoice ainda não persistida
 * @returns {Promise<{ proceed: boolean, reasons: string[] }>}
 */
export async function decideEmission(draft) {
  const spec = new CanIssueFiscalInvoiceSpecification();
  const eligible = await spec.isSatisfiedBy(draft);

  if (!eligible) {
    return { proceed: false, reasons: spec.lastReasons };
  }

  if (draft.liminarFlow && draft.liminarFlow !== LiminarFlow.NONE) {
    const liminarDecision = decideLiminarFlow({
      liminarFlow: draft.liminarFlow,
      hasMunicipalAuthorization: draft.hasMunicipalAuthorization
    });
    if (!liminarDecision.proceed) {
      return { proceed: false, reasons: liminarDecision.reasons };
    }
  }

  return { proceed: true, reasons: [] };
}
