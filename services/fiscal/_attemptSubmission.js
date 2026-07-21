// services/fiscal/_attemptSubmission.js
// Helper interno compartilhado por IssueFiscalInvoiceService e RetryFiscalSubmissionService —
// os dois precisam do mesmo passo "montar XML, assinar, chamar o provider, interpretar
// resultado". Não é chamado de fora deste diretório.

import { fiscalProfileRepository } from '../../infrastructure/persistence/FiscalProfileRepository.js';
import { certificateRepository } from '../../infrastructure/persistence/CertificateRepository.js';
import { resolveProviderName } from '../../fiscal-provider/FiscalProviderResolver.js';
import { buildDpsXml, extractFieldsFromNfseResponseXml } from '../../fiscal-provider/DpsBuilder.js';
import { recordProviderTransaction } from '../../fiscal-provider/recordProviderTransaction.js';
import { MockCertificateManager } from '../../fiscal-provider/CertificateManager.js';
import { MockAdapter } from '../../adapters/fiscal/MockAdapter.js';
import { SefinNacionalAdapter } from '../../adapters/fiscal/SefinNacionalAdapter.js';
import { AnapolisMunicipalAdapter } from '../../adapters/fiscal/AnapolisMunicipalAdapter.js';
import { FiscalProviderName } from '../../constants/fiscalProviders.js';
import { FiscalSubmissionOutcome } from '../../constants/fiscalEnums.js';
import * as FiscalInvoiceService from '../../domain/fiscal/services/FiscalInvoiceService.js';
import { fiscalInvoiceRepository } from '../../infrastructure/persistence/FiscalInvoiceRepository.js';

/**
 * Resolve o Adapter concreto a partir do nome já decidido pelo FiscalProviderResolver. Único
 * ponto do CRM que conhece a existência dos 3 Adapters — nem o domínio, nem o Resolver.
 */
function resolveAdapter(providerName) {
  switch (providerName) {
    case FiscalProviderName.SEFIN_NACIONAL:
      return new SefinNacionalAdapter({});
    case FiscalProviderName.ANAPOLIS_MUNICIPAL:
      return new AnapolisMunicipalAdapter();
    case FiscalProviderName.MOCK:
    default:
      return new MockAdapter();
  }
}

/**
 * Executa UMA tentativa completa (submission já aberta): resolve provider → monta XML → assina
 * (mock) → chama o adapter → grava ProviderTransaction → registra o resultado na FiscalInvoice
 * via FiscalInvoiceService (nunca escreve status diretamente aqui).
 *
 * @returns {Promise<{ fiscalInvoice: Object, outcome: string }>}
 */
export async function attemptSubmission(fiscalInvoice, submission, snapshot, { correlationId, overrideAdapter } = {}) {
  const fiscalProfile = await fiscalProfileRepository.findById(fiscalInvoice.fiscalProfileId);
  if (!fiscalProfile) throw new Error('FISCAL_PROFILE_NAO_ENCONTRADO');

  // `overrideAdapter` existe só para testes de integração (evita bater na Sefin Nacional real
  // ou exigir o endpoint de Anápolis) — em produção nunca é passado, o caminho normal sempre
  // resolve pelo FiscalProviderResolver.
  const providerName = resolveProviderName(fiscalProfile);
  const adapter = overrideAdapter || resolveAdapter(providerName);

  const xml = buildDpsXml(snapshot.json, fiscalInvoice, fiscalProfile);
  const certificate = fiscalProfile.certificateRef ? await certificateRepository.findById(fiscalProfile.certificateRef) : null;
  const certManager = new MockCertificateManager(); // trocar por implementação real quando A1/A3 estiver decidido
  const signedXml = await certManager.sign(xml, certificate);

  let result;
  try {
    result = await adapter.submitDps(signedXml);
  } catch (error) {
    await recordProviderTransaction(submission._id, error.diagnostics || { endpoint: providerName, response: error.message });
    const outcome = error.isTimeout ? FiscalSubmissionOutcome.TIMEOUT : FiscalSubmissionOutcome.NETWORK_ERROR;
    await FiscalInvoiceService.recordInfrastructureFailure(submission, { outcome, errorCode: error.message }, { correlationId });
    // Falha de infraestrutura NÃO muda o status (fica PENDING_SUBMISSION) — mas o `fiscalInvoice`
    // recebido como parâmetro é o mesmo objeto buscado ANTES de requestEmission() ter rodado, com
    // status ainda 'draft' em memória. Precisa reler do banco para devolver o estado real.
    const current = await fiscalInvoiceRepository.findById(fiscalInvoice._id);
    return { fiscalInvoice: current, outcome };
  }

  if (result.diagnostics) {
    await recordProviderTransaction(submission._id, result.diagnostics);
  }

  if (result.success) {
    const fields = result.fields || extractFieldsFromNfseResponseXml(result.xml);
    const updated = await FiscalInvoiceService.recordAuthorization(
      fiscalInvoice._id,
      submission,
      { ...fields, providerSnapshot: providerName, dhEmi: new Date(), dhProc: new Date() },
      { correlationId }
    );
    return { fiscalInvoice: updated, outcome: 'authorized' };
  }

  const updated = await FiscalInvoiceService.recordRejection(
    fiscalInvoice._id,
    submission,
    { errorCode: result.error?.code || String(result.error?.httpStatus || ''), rejectionReason: JSON.stringify(result.error) },
    { correlationId }
  );
  return { fiscalInvoice: updated, outcome: 'rejected' };
}
