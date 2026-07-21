// domain/fiscal/services/FiscalSubmissionService.js
// Aggregate do Outbox do módulo fiscal (Fase 2 v3, Seção 2.6). Responsável só pelo ciclo de vida
// da TENTATIVA — abrir, numerar, snapshotar, finalizar. NÃO faz HTTP, não conhece provider, não
// cria ProviderTransaction (isso só existe quando uma chamada HTTP real acontece — PR3).

import { fiscalSubmissionRepository } from '../../../infrastructure/persistence/FiscalSubmissionRepository.js';
import { buildSnapshot } from './FiscalSnapshotBuilder.js';
import { publishFiscalDomainEvent } from '../events/publishFiscalDomainEvent.js';
import { FiscalDomainEventTypes } from '../events/fiscalDomainEventTypes.js';
import { FiscalSubmissionOutcome } from '../../../constants/fiscalEnums.js';

/**
 * Abre uma nova tentativa de emissão para uma FiscalInvoice já em DRAFT/PENDING_SUBMISSION.
 * Sempre cria um FiscalSnapshot novo — nunca reutiliza o de uma tentativa anterior.
 */
export async function startAttempt(fiscalInvoice, { session, correlationId } = {}) {
  const previousAttempts = await fiscalSubmissionRepository.findByFiscalInvoice(fiscalInvoice._id);
  const attemptNumber = previousAttempts.length + 1;

  const submission = await fiscalSubmissionRepository.create(
    {
      fiscalInvoice: fiscalInvoice._id,
      attemptNumber,
      outcome: FiscalSubmissionOutcome.PENDING
    },
    { session }
  );

  const snapshot = await buildSnapshot(fiscalInvoice, submission._id, { session });

  await publishFiscalDomainEvent(
    FiscalDomainEventTypes.FISCAL_SUBMISSION_STARTED,
    { fiscalInvoiceId: String(fiscalInvoice._id), fiscalSubmissionId: String(submission._id), attemptNumber },
    { aggregateId: fiscalInvoice._id, correlationId, session }
  );

  return { submission, snapshot };
}

/**
 * Fecha a tentativa com o outcome definitivo. Quem decide o outcome é a camada que realmente
 * fez a chamada (PR3) — este service só registra e publica o evento correspondente.
 */
export async function finalizeAttempt(fiscalSubmission, { outcome, errorCode, providerSnapshot }, { session, correlationId } = {}) {
  const updated = await fiscalSubmissionRepository.finalize(
    fiscalSubmission._id,
    { outcome, errorCode, providerSnapshot },
    { session }
  );

  const eventType = outcome === FiscalSubmissionOutcome.SUCCESS
    ? FiscalDomainEventTypes.FISCAL_SUBMISSION_SUCCEEDED
    : FiscalDomainEventTypes.FISCAL_SUBMISSION_FAILED;

  await publishFiscalDomainEvent(
    eventType,
    { fiscalSubmissionId: String(fiscalSubmission._id), outcome, errorCode },
    { aggregateId: fiscalSubmission.fiscalInvoice, correlationId, session }
  );

  return updated;
}
