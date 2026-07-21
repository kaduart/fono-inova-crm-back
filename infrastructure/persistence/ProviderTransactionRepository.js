// infrastructure/persistence/ProviderTransactionRepository.js
// Repository Pattern - Abstrai persistência de ProviderTransaction (Provider Layer).
// Não criado no PR1/PR2 — só agora existe um consumidor real (os Adapters do PR3).

import ProviderTransaction from '../../models/ProviderTransaction.js';
import Logger from '../../services/utils/Logger.js';

const logger = new Logger('ProviderTransactionRepository');

export class ProviderTransactionRepository {
  async findById(providerTransactionId) {
    try {
      return await ProviderTransaction.findById(providerTransactionId);
    } catch (error) {
      logger.error('FIND_BY_ID_ERROR', { providerTransactionId, error: error.message });
      throw error;
    }
  }

  async findByFiscalSubmission(fiscalSubmissionId) {
    try {
      return await ProviderTransaction.find({ fiscalSubmission: fiscalSubmissionId }).sort({ createdAt: 1 });
    } catch (error) {
      logger.error('FIND_BY_FISCAL_SUBMISSION_ERROR', { fiscalSubmissionId, error: error.message });
      throw error;
    }
  }

  async findByTraceId(traceId) {
    try {
      return await ProviderTransaction.find({ traceId });
    } catch (error) {
      logger.error('FIND_BY_TRACE_ID_ERROR', { traceId, error: error.message });
      throw error;
    }
  }

  async create(data, { session } = {}) {
    try {
      const [transaction] = await ProviderTransaction.create([data], { session });
      logger.info('PROVIDER_TRANSACTION_CREATED', {
        providerTransactionId: transaction._id.toString(),
        fiscalSubmission: transaction.fiscalSubmission?.toString(),
        endpoint: transaction.endpoint,
        httpStatus: transaction.httpStatus
      });
      return transaction;
    } catch (error) {
      logger.error('CREATE_ERROR', { error: error.message });
      throw error;
    }
  }
}

export const providerTransactionRepository = new ProviderTransactionRepository();
