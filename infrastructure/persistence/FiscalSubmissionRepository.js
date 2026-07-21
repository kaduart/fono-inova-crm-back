// infrastructure/persistence/FiscalSubmissionRepository.js
// Repository Pattern - Abstrai persistência de FiscalSubmission (Aggregate próprio, Outbox do
// módulo fiscal). Nenhuma lógica de retry/resolução de provider aqui — isso é do PR3.

import FiscalSubmission from '../../models/FiscalSubmission.js';
import Logger from '../../services/utils/Logger.js';

const logger = new Logger('FiscalSubmissionRepository');

export class FiscalSubmissionRepository {
  async findById(fiscalSubmissionId) {
    try {
      return await FiscalSubmission.findById(fiscalSubmissionId);
    } catch (error) {
      logger.error('FIND_BY_ID_ERROR', { fiscalSubmissionId, error: error.message });
      throw error;
    }
  }

  async findByFiscalInvoice(fiscalInvoiceId) {
    try {
      return await FiscalSubmission.find({ fiscalInvoice: fiscalInvoiceId }).sort({ attemptNumber: 1 });
    } catch (error) {
      logger.error('FIND_BY_FISCAL_INVOICE_ERROR', { fiscalInvoiceId, error: error.message });
      throw error;
    }
  }

  async findLastAttempt(fiscalInvoiceId) {
    try {
      return await FiscalSubmission.findOne({ fiscalInvoice: fiscalInvoiceId }).sort({ attemptNumber: -1 });
    } catch (error) {
      logger.error('FIND_LAST_ATTEMPT_ERROR', { fiscalInvoiceId, error: error.message });
      throw error;
    }
  }

  async findByOutcome(outcome, { limit = 100 } = {}) {
    try {
      return await FiscalSubmission.find({ outcome }).sort({ createdAt: -1 }).limit(limit);
    } catch (error) {
      logger.error('FIND_BY_OUTCOME_ERROR', { outcome, error: error.message });
      throw error;
    }
  }

  async create(data, { session } = {}) {
    try {
      const [submission] = await FiscalSubmission.create([data], { session });
      logger.info('FISCAL_SUBMISSION_CREATED', {
        fiscalSubmissionId: submission._id.toString(),
        fiscalInvoice: submission.fiscalInvoice?.toString(),
        attemptNumber: submission.attemptNumber,
        outcome: submission.outcome
      });
      return submission;
    } catch (error) {
      logger.error('CREATE_ERROR', { error: error.message });
      throw error;
    }
  }

  /** Fecha uma tentativa aberta com o outcome final (nunca cria uma nova — outbox imutável por tentativa). */
  async finalize(fiscalSubmissionId, { outcome, errorCode, providerSnapshot }, { session } = {}) {
    try {
      const fields = { outcome, errorCode };
      if (providerSnapshot) fields.providerSnapshot = providerSnapshot;
      const result = await FiscalSubmission.findByIdAndUpdate(
        fiscalSubmissionId,
        { $set: fields },
        { new: true, session }
      );
      logger.info('FISCAL_SUBMISSION_FINALIZED', { fiscalSubmissionId, outcome, errorCode });
      return result;
    } catch (error) {
      logger.error('FINALIZE_ERROR', { fiscalSubmissionId, error: error.message });
      throw error;
    }
  }
}

export const fiscalSubmissionRepository = new FiscalSubmissionRepository();
