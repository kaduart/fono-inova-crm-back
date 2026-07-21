// infrastructure/persistence/FiscalAttachmentRepository.js
// Repository Pattern - Abstrai persistência de FiscalAttachment.
// Imutável por design (invariante #4): não expõe update — apenas create e find*.

import FiscalAttachment from '../../models/FiscalAttachment.js';
import Logger from '../../services/utils/Logger.js';

const logger = new Logger('FiscalAttachmentRepository');

export class FiscalAttachmentRepository {
  async findById(fiscalAttachmentId) {
    try {
      return await FiscalAttachment.findById(fiscalAttachmentId);
    } catch (error) {
      logger.error('FIND_BY_ID_ERROR', { fiscalAttachmentId, error: error.message });
      throw error;
    }
  }

  async findByFiscalInvoice(fiscalInvoiceId) {
    try {
      return await FiscalAttachment.find({ fiscalInvoice: fiscalInvoiceId }).sort({ generatedAt: 1 });
    } catch (error) {
      logger.error('FIND_BY_FISCAL_INVOICE_ERROR', { fiscalInvoiceId, error: error.message });
      throw error;
    }
  }

  async findByType(fiscalInvoiceId, type) {
    try {
      return await FiscalAttachment.find({ fiscalInvoice: fiscalInvoiceId, type });
    } catch (error) {
      logger.error('FIND_BY_TYPE_ERROR', { fiscalInvoiceId, type, error: error.message });
      throw error;
    }
  }

  async create(data, { session } = {}) {
    try {
      const [attachment] = await FiscalAttachment.create([data], { session });
      logger.info('FISCAL_ATTACHMENT_CREATED', {
        fiscalAttachmentId: attachment._id.toString(),
        fiscalInvoice: attachment.fiscalInvoice?.toString(),
        type: attachment.type
      });
      return attachment;
    } catch (error) {
      logger.error('CREATE_ERROR', { error: error.message });
      throw error;
    }
  }
}

export const fiscalAttachmentRepository = new FiscalAttachmentRepository();
