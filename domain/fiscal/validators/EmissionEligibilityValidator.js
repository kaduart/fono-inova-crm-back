// domain/fiscal/validators/EmissionEligibilityValidator.js
// Checagem de FATOS (não decisão) — responde perguntas objetivas sobre se uma emissão pode
// prosseguir. A DECISÃO fica com EmissionPolicy (domain/fiscal/policies/EmissionPolicy.js).
// Nunca lança erro — sempre retorna { eligible, reasons[] } para o chamador decidir o que fazer.

import { CertificateStatus } from '../../../constants/fiscalEnums.js';
import { fiscalProfileRepository } from '../../../infrastructure/persistence/FiscalProfileRepository.js';
import { certificateRepository } from '../../../infrastructure/persistence/CertificateRepository.js';
import { fiscalInvoiceRepository } from '../../../infrastructure/persistence/FiscalInvoiceRepository.js';
import { hasSettledPayments } from '../projections/FiscalInvoicePaymentProjection.js';
import { FiscalInvoiceStatus } from '../../../constants/fiscalEnums.js';

const NON_BLOCKING_EXISTING_STATUSES = [FiscalInvoiceStatus.REJECTED, FiscalInvoiceStatus.CANCELLED, FiscalInvoiceStatus.CANCELLED_SUBSTITUTED];

/**
 * @param {{ fiscalProfileId: string, origin: {type:string, id:string}, patient: string, professional?: string }} draft
 * @returns {Promise<{ eligible: boolean, reasons: string[] }>}
 */
export async function validateEmissionEligibility(draft) {
  const reasons = [];

  if (!draft.patient) reasons.push('PATIENT_OBRIGATORIO');
  if (!draft.origin?.type || !draft.origin?.id) reasons.push('ORIGIN_OBRIGATORIA');

  const fiscalProfile = draft.fiscalProfileId
    ? await fiscalProfileRepository.findById(draft.fiscalProfileId)
    : null;

  if (!fiscalProfile) {
    reasons.push('FISCAL_PROFILE_NAO_ENCONTRADO');
  } else {
    if (!fiscalProfile.ativo) reasons.push('FISCAL_PROFILE_INATIVO');
    if (!fiscalProfile.municipioIBGE) reasons.push('MUNICIPIO_NAO_CONFIGURADO');

    if (!fiscalProfile.certificateRef) {
      reasons.push('CERTIFICADO_NAO_CONFIGURADO');
    } else {
      const certificate = await certificateRepository.findById(fiscalProfile.certificateRef);
      if (!certificate) {
        reasons.push('CERTIFICADO_NAO_ENCONTRADO');
      } else if (![CertificateStatus.ACTIVE, CertificateStatus.EXPIRING_SOON].includes(certificate.status)) {
        reasons.push(`CERTIFICADO_INVALIDO_STATUS_${certificate.status}`);
      }
    }
  }

  if (draft.origin?.type && draft.origin?.id) {
    const settled = await hasSettledPayments(draft.origin);
    if (!settled) reasons.push('NENHUM_PAYMENT_SETTLED_PARA_ORIGEM');

    const existing = await fiscalInvoiceRepository.findByOrigin(draft.origin.type, draft.origin.id);
    const blockingExisting = existing.filter((inv) => !NON_BLOCKING_EXISTING_STATUSES.includes(inv.status));
    if (blockingExisting.length > 0) reasons.push('FISCAL_INVOICE_JA_EXISTE_PARA_ORIGEM');
  }

  return { eligible: reasons.length === 0, reasons };
}
