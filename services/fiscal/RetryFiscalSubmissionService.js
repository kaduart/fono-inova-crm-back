/**
 * ============================================================================
 * RETRY FISCAL SUBMISSION SERVICE
 * ============================================================================
 *
 * Application Service — PR4. Reaproveita a mesma infraestrutura do
 * IssueFiscalInvoiceService (attemptSubmission) para uma FiscalInvoice que já está
 * PENDING_SUBMISSION (emissão anterior terminou em network_error/timeout — nunca em rejeição de
 * negócio, essa é terminal por design, ver domain/fiscal/stateMachine/FiscalStateMachineService.js
 * transitionToRejected).
 * ============================================================================
 */

import { v4 as uuidv4 } from 'uuid';
import { fiscalInvoiceRepository } from '../../infrastructure/persistence/FiscalInvoiceRepository.js';
import { startAttempt } from '../../domain/fiscal/services/FiscalSubmissionService.js';
import { attemptSubmission } from './_attemptSubmission.js';
import { FiscalInvoiceStatus } from '../../constants/fiscalEnums.js';

export class RetryFiscalSubmissionService {
  /**
   * @param {string} fiscalInvoiceId
   * @param {{ correlationId?: string }} [options]
   * @returns {Promise<{ fiscalInvoice: Object, outcome: string }>}
   */
  async retry(fiscalInvoiceId, options = {}) {
    const correlationId = options.correlationId || uuidv4();

    const fiscalInvoice = await fiscalInvoiceRepository.findById(fiscalInvoiceId);
    if (!fiscalInvoice) throw new Error('FISCAL_INVOICE_NAO_ENCONTRADA');

    if (fiscalInvoice.status !== FiscalInvoiceStatus.PENDING_SUBMISSION) {
      throw new Error(
        `FISCAL_INVOICE_STATUS_INVALIDO_PARA_RETRY: ${fiscalInvoice.status} — só é possível reenviar ` +
        `uma FiscalInvoice em PENDING_SUBMISSION (falha de infraestrutura). REJECTED é terminal: ` +
        `emitir de novo exige uma nova FiscalInvoice/DPS.`
      );
    }

    console.log('[RetryFiscalSubmissionService] Reabrindo tentativa', {
      fiscalInvoiceId: fiscalInvoice._id.toString(),
      correlationId
    });

    const { submission, snapshot } = await startAttempt(fiscalInvoice, { correlationId });

    console.log('[RetryFiscalSubmissionService] Nova tentativa aberta, chamando provider', {
      fiscalInvoiceId: fiscalInvoice._id.toString(),
      fiscalSubmissionId: submission._id.toString(),
      attemptNumber: submission.attemptNumber,
      correlationId
    });

    const { fiscalInvoice: updated, outcome } = await attemptSubmission(fiscalInvoice, submission, snapshot, {
      correlationId,
      overrideAdapter: options.overrideAdapter // só usado em testes de integração
    });

    console.log('[RetryFiscalSubmissionService] Retry concluído', {
      fiscalInvoiceId: fiscalInvoice._id.toString(),
      attemptNumber: submission.attemptNumber,
      outcome,
      correlationId
    });

    return { fiscalInvoice: updated, outcome };
  }
}

export const retryFiscalSubmissionService = new RetryFiscalSubmissionService();
