// domain/fiscal/services/FiscalInvoiceService.js
// Orquestra o Aggregate FiscalInvoice. NÃO faz HTTP, não escolhe provider, não monta XML, não
// conhece prefeitura — recebe os resultados dessas operações já prontos (PR3) e só decide o que
// isso significa para o estado do domínio.

import mongoose from 'mongoose';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { fiscalInvoiceRepository } from '../../../infrastructure/persistence/FiscalInvoiceRepository.js';
import { fiscalAttachmentRepository } from '../../../infrastructure/persistence/FiscalAttachmentRepository.js';
import { decideEmission } from '../policies/EmissionPolicy.js';
import { decideCancellation } from '../policies/CancellationPolicy.js';
import { decideSubstitution } from '../policies/SubstitutionPolicy.js';
import * as FiscalStateMachineService from '../stateMachine/FiscalStateMachineService.js';
import * as FiscalSubmissionService from './FiscalSubmissionService.js';
import { publishFiscalDomainEvent } from '../events/publishFiscalDomainEvent.js';
import { FiscalDomainEventTypes } from '../events/fiscalDomainEventTypes.js';
import { FiscalInvoiceStatus } from '../../../constants/fiscalEnums.js';
import { TipoEvento } from '../../../constants/fiscalEvents.js';

/**
 * Cria uma FiscalInvoice em DRAFT, validando elegibilidade antes de persistir.
 * @throws {Error} FISCAL_INVOICE_NOT_ELIGIBLE se a EmissionPolicy recusar
 */
export async function createDraft(draft) {
  const decision = await decideEmission(draft);
  if (!decision.proceed) {
    const error = new Error(`FISCAL_INVOICE_NOT_ELIGIBLE: ${decision.reasons.join(', ')}`);
    error.reasons = decision.reasons;
    throw error;
  }

  return fiscalInvoiceRepository.create({ ...draft, status: FiscalInvoiceStatus.DRAFT });
}

/**
 * DRAFT → PENDING_SUBMISSION + abre a primeira FiscalSubmission (tentativa 1).
 * Publica FISCAL_INVOICE_REQUESTED.
 */
export async function requestEmission(fiscalInvoiceId, { correlationId } = {}) {
  return runTransactionWithRetry(async (session) => {
    const fiscalInvoice = await fiscalInvoiceRepository.findById(fiscalInvoiceId);
    if (!fiscalInvoice) throw new Error('FISCAL_INVOICE_NAO_ENCONTRADA');
    if (fiscalInvoice.status !== FiscalInvoiceStatus.DRAFT) {
      throw new Error(`FISCAL_INVOICE_STATUS_INVALIDO_PARA_EMISSAO: ${fiscalInvoice.status}`);
    }

    await FiscalStateMachineService.transitionToPendingSubmission(fiscalInvoiceId, { session });

    const { submission, snapshot } = await FiscalSubmissionService.startAttempt(fiscalInvoice, { session, correlationId });

    await publishFiscalDomainEvent(
      FiscalDomainEventTypes.FISCAL_INVOICE_REQUESTED,
      { fiscalInvoiceId: String(fiscalInvoiceId), fiscalSubmissionId: String(submission._id) },
      { aggregateId: fiscalInvoiceId, correlationId, session }
    );

    return { submission, snapshot };
  });
}

/**
 * Registra o resultado de sucesso de uma tentativa (PR3 já chamou o provider e obteve os
 * campos oficiais). PENDING_SUBMISSION → AUTHORIZED.
 */
export async function recordAuthorization(fiscalInvoiceId, fiscalSubmission, officialFields, { correlationId } = {}) {
  return runTransactionWithRetry(async (session) => {
    await FiscalSubmissionService.finalizeAttempt(
      fiscalSubmission,
      { outcome: 'success', providerSnapshot: officialFields.providerSnapshot },
      { session, correlationId }
    );

    const updated = await FiscalStateMachineService.transitionToAuthorized(fiscalInvoiceId, officialFields, { session });

    await publishFiscalDomainEvent(
      FiscalDomainEventTypes.FISCAL_INVOICE_AUTHORIZED,
      { fiscalInvoiceId: String(fiscalInvoiceId), chaveAcesso: officialFields.chaveAcesso },
      { aggregateId: fiscalInvoiceId, correlationId, session }
    );

    return updated;
  });
}

/**
 * Registra REJEIÇÃO DE NEGÓCIO (não confundir com network_error/timeout — esses não chamam esta
 * função, só finalizam a FiscalSubmission e permitem nova tentativa na mesma FiscalInvoice).
 * Terminal para esta FiscalInvoice.
 */
export async function recordRejection(fiscalInvoiceId, fiscalSubmission, { errorCode, rejectionReason }, { correlationId } = {}) {
  return runTransactionWithRetry(async (session) => {
    await FiscalSubmissionService.finalizeAttempt(
      fiscalSubmission,
      { outcome: 'rejected', errorCode },
      { session, correlationId }
    );

    const updated = await FiscalStateMachineService.transitionToRejected(fiscalInvoiceId, { rejectionReason }, { session });

    await publishFiscalDomainEvent(
      FiscalDomainEventTypes.FISCAL_INVOICE_REJECTED,
      { fiscalInvoiceId: String(fiscalInvoiceId), errorCode, rejectionReason },
      { aggregateId: fiscalInvoiceId, correlationId, session }
    );

    return updated;
  });
}

/**
 * Registra uma FALHA DE INFRAESTRUTURA (network_error/timeout) — nunca muda o status da
 * FiscalInvoice, que permanece PENDING_SUBMISSION e aceita uma nova FiscalSubmission (retry).
 */
export async function recordInfrastructureFailure(fiscalSubmission, { outcome, errorCode }, { correlationId } = {}) {
  return FiscalSubmissionService.finalizeAttempt(fiscalSubmission, { outcome, errorCode }, { correlationId });
}

/**
 * Anexa um artefato imutável (XML/DANFSe) já obtido do provider (PR3). Nunca sobrescreve — uma
 * nova versão gera novo FiscalInvoice + novo FiscalAttachment.
 */
export async function attachAttachment(fiscalInvoiceId, attachmentData) {
  return fiscalAttachmentRepository.create({ ...attachmentData, fiscalInvoice: fiscalInvoiceId });
}

/**
 * Solicita cancelamento — delega inteiramente à máquina de estados via OfficialFiscalEvent
 * tipo Cancelamento. Nunca dispara estorno financeiro (CancellationPolicy.triggersFinancialReversal
 * é sempre false — decisão manual e separada do usuário no Financeiro).
 */
export async function requestCancellation(fiscalInvoiceId, { correlationId } = {}) {
  const fiscalInvoice = await fiscalInvoiceRepository.findById(fiscalInvoiceId);
  if (!fiscalInvoice) throw new Error('FISCAL_INVOICE_NAO_ENCONTRADA');

  const decision = await decideCancellation(fiscalInvoice);
  if (!decision.proceed) {
    const error = new Error(`FISCAL_INVOICE_CANCELLATION_NOT_ELIGIBLE: ${decision.reasons.join(', ')}`);
    error.reasons = decision.reasons;
    throw error;
  }

  return runTransactionWithRetry(async (session) => {
    const result = await FiscalStateMachineService.applyOfficialFiscalEvent(
      fiscalInvoiceId,
      { tipoEvento: TipoEvento.CANCELAMENTO, source: 'crm', correlationId },
      { session }
    );

    await publishFiscalDomainEvent(
      FiscalDomainEventTypes.FISCAL_INVOICE_CANCELLED,
      { fiscalInvoiceId: String(fiscalInvoiceId) },
      { aggregateId: fiscalInvoiceId, correlationId, session }
    );

    return result;
  });
}

/**
 * Substitui uma nota autorizada: cria uma nova FiscalInvoice (draft, vinculada via `substitutes`)
 * e aplica o evento oficial de Cancelamento por Substituição na original. A nova nota segue o
 * fluxo normal de requestEmission/recordAuthorization depois — este método só cria o vínculo.
 */
export async function substitute(fiscalInvoiceId, newDraft, substitutionRequest, { correlationId } = {}) {
  const original = await fiscalInvoiceRepository.findById(fiscalInvoiceId);
  if (!original) throw new Error('FISCAL_INVOICE_NAO_ENCONTRADA');

  const decision = await decideSubstitution(original, substitutionRequest);
  if (!decision.proceed) {
    const error = new Error(`FISCAL_INVOICE_SUBSTITUTION_NOT_ELIGIBLE: ${decision.reasons.join(', ')}`);
    error.reasons = decision.reasons;
    throw error;
  }

  return runTransactionWithRetry(async (session) => {
    const [newInvoice] = await mongoose.model('FiscalInvoice').create(
      [{ ...newDraft, status: FiscalInvoiceStatus.DRAFT, substitutes: fiscalInvoiceId }],
      { session }
    );

    await FiscalStateMachineService.applyOfficialFiscalEvent(
      fiscalInvoiceId,
      {
        tipoEvento: TipoEvento.CANCELAMENTO_POR_SUBSTITUICAO,
        source: 'crm',
        correlationId,
        payload: { cMotivo: substitutionRequest.cMotivo, xMotivo: substitutionRequest.xMotivo }
      },
      { session }
    );

    await fiscalInvoiceRepository.updateFields(fiscalInvoiceId, { substitutedBy: newInvoice._id }, { session });

    await publishFiscalDomainEvent(
      FiscalDomainEventTypes.FISCAL_INVOICE_SUBSTITUTED,
      { fiscalInvoiceId: String(fiscalInvoiceId), newFiscalInvoiceId: String(newInvoice._id) },
      { aggregateId: fiscalInvoiceId, correlationId, session }
    );

    return newInvoice;
  });
}
