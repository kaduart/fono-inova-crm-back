// services/fiscal/_attemptSubmission.js
// Helper interno compartilhado por IssueFiscalInvoiceService e RetryFiscalSubmissionService —
// os dois precisam do mesmo passo "montar XML, assinar, chamar o provider, interpretar
// resultado". Não é chamado de fora deste diretório.

import { fiscalProfileRepository } from '../../infrastructure/persistence/FiscalProfileRepository.js';
import { certificateRepository } from '../../infrastructure/persistence/CertificateRepository.js';
import { resolveProviderName } from '../../fiscal-provider/FiscalProviderResolver.js';
import { buildDpsXml, extractFieldsFromNfseResponseXml } from '../../fiscal-provider/DpsBuilder.js';
import { validateDpsStructure } from '../../fiscal-provider/DpsStructuralValidator.js';
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
import { fiscalSubmissionRepository } from '../../infrastructure/persistence/FiscalSubmissionRepository.js';
import { fiscalSnapshotRepository } from '../../infrastructure/persistence/FiscalSnapshotRepository.js';

/**
 * Identidade do prestador (CNPJ/IM) para a consulta de reconciliação — precisa reproduzir a
 * identidade usada na tentativa ORIGINAL, nunca a atual do FiscalProfile (que pode ter mudado
 * desde então — troca de inscrição municipal, correção de CNPJ etc.). `FiscalSnapshot` já
 * persiste `infDPS.prest.cnpj`/`.im` imutavelmente desde a montagem original da DPS
 * (domain/fiscal/services/FiscalSnapshotBuilder.js) — não duplicamos o dado em lugar nenhum novo,
 * só lemos de onde ele já vive. Sem snapshot localizável, a reconciliação não tem como confirmar
 * a identidade original: falha para `unknown` em vez de arriscar uma consulta com CNPJ/IM errados.
 */
async function loadOriginalSubmissionIdentity(submission) {
  if (!submission?._id) return { ok: false, reason: 'FISCAL_SUBMISSION_SEM_ID' };
  const snapshot = await fiscalSnapshotRepository.findByFiscalSubmission(submission._id);
  const prest = snapshot?.json?.infDPS?.prest;
  if (!prest?.cnpj || !prest?.im) return { ok: false, reason: 'FISCAL_SNAPSHOT_SEM_IDENTIDADE_PRESTADOR' };
  return { ok: true, cnpj: prest.cnpj, inscricaoMunicipal: prest.im };
}

export async function reconcileSubmission(fiscalInvoice, submission, { overrideAdapter } = {}) {
  // Não inferir provedor histórico pelo relógio atual: pode ter ocorrido migração.
  if (!submission?.providerSnapshot && !overrideAdapter) {
    return { status: 'unknown', reason: 'PREVIOUS_PROVIDER_UNKNOWN' };
  }
  const identity = await loadOriginalSubmissionIdentity(submission);
  if (!identity.ok && !overrideAdapter) return { status: 'unknown', reason: identity.reason };
  let adapter = overrideAdapter;
  if (!adapter) {
    const fiscalProfile = await fiscalProfileRepository.findById(fiscalInvoice.fiscalProfileId);
    if (!fiscalProfile) return { status: 'unknown', reason: 'FISCAL_PROFILE_NAO_ENCONTRADO' };
    // `ambiente`/httpsAgent/certManager são sobre conectividade AGORA (qual endpoint, qual
    // certificado usar para autenticar a chamada) — não são a identidade de negócio da consulta,
    // então usar o FiscalProfile atual aqui é correto e não é o que este comentário/tarefa
    // endurece. `identity.cnpj`/`identity.inscricaoMunicipal` abaixo são os únicos campos que
    // precisam vir do snapshot imutável, não do perfil atual.
    const certificate = fiscalProfile.certificateRef ? await certificateRepository.findById(fiscalProfile.certificateRef) : null;
    const { httpsAgent, certManager } = buildCertificateContext(certificate);
    adapter = resolveAdapter(submission.providerSnapshot, { ambiente: fiscalProfile.ambiente, httpsAgent, fiscalProfile, certManager });
  }
  if (!adapter.reconcileDps) return { status: 'unknown', reason: 'PROVIDER_RECONCILIATION_NOT_IMPLEMENTED' };
  const result = await adapter.reconcileDps({
    dpsId: fiscalInvoice.dpsId,
    nDPS: fiscalInvoice.nDPS,
    serie: fiscalInvoice.serie,
    submissionId: submission?._id,
    cnpj: identity.ok ? identity.cnpj : undefined,
    inscricaoMunicipal: identity.ok ? identity.inscricaoMunicipal : undefined
  });
  if (result?.diagnostics && submission) await recordProviderTransaction(submission._id, result.diagnostics);
  return result;
}

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
 * com certificado real (mock somente nos testes) → chama o adapter → grava ProviderTransaction → registra o resultado na FiscalInvoice
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

  // Pré-voo estrutural (item 4, homologação de Anápolis 2026-09-11) — mesmo padrão das demais
  // validações de DpsBuilder (FISCAL_TOTAL_TRIBUTOS_NAO_CONFIGURADO etc.): lança ANTES de assinar
  // ou chamar qualquer provider, nunca cria um FiscalSubmission/ProviderTransaction para uma
  // chamada HTTP que nunca aconteceu. Não é o .xsd oficial (bloqueado por 403 — ver
  // DpsStructuralValidator.js) — cobre a árvore mínima confirmada pelo Anexo I/manual.
  const structuralCheck = validateDpsStructure(xml);
  if (!structuralCheck.valid) {
    const details = structuralCheck.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join(' | ');
    throw new Error(`FISCAL_DPS_ESTRUTURA_INVALIDA (validação estrutural derivada de dps_field_matrix.md/Manual v1.01, não é o .xsd oficial): ${details}`);
  }

  // Sem certificado real vinculado ainda (perfil incompleto ou ambiente de teste): cai no Mock,
  // mesmo comportamento de antes — nunca bloqueia o fluxo por falta de certificado aqui, quem
  // decide se a emissão pode prosseguir sem certificado é o domínio (EmissionEligibilityValidator).
  const signedXml = providerName === FiscalProviderName.ANAPOLIS_MUNICIPAL && realCertManager
    ? await realCertManager.signElement(xml, { id: identifiedInvoice.dpsId, rootLocalName: 'DPS', notaControl: true })
    : await certManager.sign(xml, certificate);

  let result;
  // Gravar o provedor antes do primeiro envio, inclusive quando a resposta se perde.
  await fiscalSubmissionRepository.pinProvider(submission._id, providerName);
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

  const fields = result.fields || (result.xml ? extractFieldsFromNfseResponseXml(result.xml) : {});
  if (result.success && fields.chaveAcesso && fields.nNFSe && fields.cStat) {
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

  // HTTP 5xx, SOAP ilegível ou retorno sem rejeição de negócio não comprovam que nada foi emitido.
  if (result.success || result.error?.httpStatus >= 500 || result.error?.httpStatus === 408 ||
      (result.error?.httpStatus >= 200 && result.error?.httpStatus < 300) ||
      result.error?.code === 'NOTA_CONTROL_RESPOSTA_INESPERADA' || (!result.error?.code && !result.error?.httpStatus)) {
    await FiscalInvoiceService.recordInfrastructureFailure(submission, {
      outcome: FiscalSubmissionOutcome.NETWORK_ERROR, errorCode: 'RECONCILIATION_REQUIRED'
    }, { correlationId });
    return { fiscalInvoice: await fiscalInvoiceRepository.findById(fiscalInvoice._id), outcome: 'reconciliation_required' };
  }

  const updated = await FiscalInvoiceService.recordRejection(
    fiscalInvoice._id,
    submission,
    { errorCode: result.error?.code || String(result.error?.httpStatus || ''), rejectionReason: JSON.stringify(result.error) },
    { correlationId }
  );
  return { fiscalInvoice: updated, outcome: 'rejected' };
}
