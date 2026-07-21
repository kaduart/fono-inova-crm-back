// domain/fiscal/policies/SubstitutionPolicy.js
import { CanSubstituteFiscalInvoiceSpecification } from '../specifications/CanSubstituteFiscalInvoiceSpecification.js';
import { SubstitutionMotivo } from '../../../constants/fiscalEnums.js';

/**
 * @param {Object} fiscalInvoice
 * @param {{ cMotivo: number, xMotivo?: string }} substitutionRequest
 * @returns {Promise<{ proceed: boolean, reasons: string[] }>}
 */
export async function decideSubstitution(fiscalInvoice, substitutionRequest) {
  const reasons = [];

  if (!Object.values(SubstitutionMotivo).includes(substitutionRequest?.cMotivo)) {
    reasons.push('CMOTIVO_INVALIDO_OU_AUSENTE');
  }
  // xMotivo só é obrigatório quando cMotivo=99 (Anexo I, dps_field_matrix.md Seção 2.4)
  if (substitutionRequest?.cMotivo === SubstitutionMotivo.OUTROS && !substitutionRequest?.xMotivo) {
    reasons.push('XMOTIVO_OBRIGATORIO_QUANDO_CMOTIVO_OUTROS');
  }

  const spec = new CanSubstituteFiscalInvoiceSpecification();
  const eligible = await spec.isSatisfiedBy(fiscalInvoice);
  if (!eligible) reasons.push(...spec.lastReasons);

  return { proceed: reasons.length === 0, reasons };
}
