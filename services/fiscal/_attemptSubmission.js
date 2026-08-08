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
import { buildCertificateContext } from '../../fiscal-provider/buildCertificateContext.js';
import { MockAdapter } from '../../adapters/fiscal/MockAdapter.js';
import { SefinNacionalAdapter } from '../../adapters/fiscal/SefinNacionalAdapter.js';
import { AnapolisMunicipalAdapter } from '../../adapters/fiscal/AnapolisMunicipalAdapter.js';
import { FiscalProviderName } from '../../constants/fiscalProviders.js';
import { FiscalSubmissionOutcome } from '../../constants/fiscalEnums.js';
import * as FiscalInvoiceService from '../../domain/fiscal/services/FiscalInvoiceService.js';
import { fiscalInvoiceRepository } from '../../infrastructure/persistence/FiscalInvoiceRepository.js';
import { ensureDpsIdentity } from './DpsIdentityService.js';

/**
 * Resolve o Adapter concreto a partir do nome já decidido pelo FiscalProviderResolver. Único
 * ponto do CRM que conhece a existência dos 3 Adapters — nem o domínio, nem o Resolver.
 * `ambiente`/`httpsAgent` são usados tanto pela Sefin quanto pela Nota Control (ambas exigem
 * mTLS); `fiscalProfile` também fornece CNPJ e IM para o lote municipal.
 */
function resolveAdapter(providerName, { ambiente, httpsAgent, fiscalProfile, certManager } = {}) {
  switch (providerName) {
    case FiscalProviderName.SEFIN_NACIONAL:
      return new SefinNacionalAdapter({ ambiente, httpsAgent });
    case FiscalProviderName.ANAPOLIS_MUNICIPAL:
      return new AnapolisMunicipalAdapter({ ambiente, httpsAgent, fiscalProfile, certManager });
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

  const certificate = fiscalProfile.certificateRef ? await certificateRepository.findById(fiscalProfile.certificateRef) : null;
  const { httpsAgent, certManager: realCertManager } = buildCertificateContext(certificate);

  // `overrideAdapter` existe só para testes de integração (evita bater na Sefin Nacional real
  // ou exigir o endpoint de Anápolis) — em produção nunca é passado, o caminho normal sempre
  // resolve pelo FiscalProviderResolver. `ambiente` vem do FiscalProfile (bug corrigido em
  // 2026-07-29 — antes o adapter sempre assumia Produção Restrita, ignorando esse campo).
  const providerName = resolveProviderName(fiscalProfile);
  const certManager = realCertManager || new MockCertificateManager();
  const adapter = overrideAdapter || resolveAdapter(providerName, { ambiente: fiscalProfile.ambiente, httpsAgent, fiscalProfile, certManager });

  // Garante identificação oficial antes de montar/assinar. Também recupera drafts antigos ou
  // tentativas pendentes criadas antes da implementação da numeração da DPS.
  const identifiedInvoice = await ensureDpsIdentity(fiscalInvoice, fiscalProfile);
  const xml = buildDpsXml(snapshot.json, identifiedInvoice, fiscalProfile);
  // Sem certificado real vinculado ainda (perfil incompleto ou ambiente de teste): cai no Mock,
  // mesmo comportamento de antes — nunca bloqueia o fluxo por falta de certificado aqui, quem
  // decide se a emissão pode prosseguir sem certificado é o domínio (EmissionEligibilityValidator).
  const signedXml = providerName === FiscalProviderName.ANAPOLIS_MUNICIPAL && realCertManager
    ? await realCertManager.signElement(xml, { id: identifiedInvoice.dpsId, rootLocalName: 'DPS', notaControl: true })
    : await certManager.sign(xml, certificate);

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
    if (result.xml) {
      await FiscalInvoiceService.attachAttachment(fiscalInvoice._id, {
        type: 'xml_nfse',
        storageRef: result.xml,
        mimeType: 'application/xml',
        size: Buffer.byteLength(result.xml, 'utf8'),
        generatedAt: new Date()
      });
    }
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
