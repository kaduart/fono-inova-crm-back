// infrastructure/persistence/OfficialFiscalEventRepository.js
// Repository Pattern - Abstrai persistência de OfficialFiscalEvent.
// ⚠️ APPEND-ONLY POR DESIGN (invariante #5, Fase 2 v3): este repository deliberadamente NÃO expõe
// nenhum método de update/delete. Se algum dia for necessário "corrigir" um evento oficial já
// registrado, a correção correta é inserir um novo OfficialFiscalEvent, nunca mutar o existente.

import OfficialFiscalEvent from '../../models/OfficialFiscalEvent.js';
import Logger from '../../services/utils/Logger.js';

const logger = new Logger('OfficialFiscalEventRepository');

export class OfficialFiscalEventRepository {
  async findById(officialFiscalEventId) {
    try {
      return await OfficialFiscalEvent.findById(officialFiscalEventId);
    } catch (error) {
      logger.error('FIND_BY_ID_ERROR', { officialFiscalEventId, error: error.message });
      throw error;
    }
  }

  async findByFiscalInvoice(fiscalInvoiceId) {
    try {
      return await OfficialFiscalEvent.find({ fiscalInvoice: fiscalInvoiceId }).sort({ occurredAt: 1 });
    } catch (error) {
      logger.error('FIND_BY_FISCAL_INVOICE_ERROR', { fiscalInvoiceId, error: error.message });
      throw error;
    }
  }

  async findByTipoEvento(fiscalInvoiceId, tipoEvento) {
    try {
      return await OfficialFiscalEvent.find({ fiscalInvoice: fiscalInvoiceId, tipoEvento }).sort({ occurredAt: 1 });
    } catch (error) {
      logger.error('FIND_BY_TIPO_EVENTO_ERROR', { fiscalInvoiceId, tipoEvento, error: error.message });
      throw error;
    }
  }

  async findByCorrelationId(correlationId) {
    try {
      return await OfficialFiscalEvent.find({ correlationId });
    } catch (error) {
      logger.error('FIND_BY_CORRELATION_ID_ERROR', { correlationId, error: error.message });
      throw error;
    }
  }

  /** Único método de escrita — insert puro, nunca update/delete. */
  async create(data, { session } = {}) {
    try {
      const [event] = await OfficialFiscalEvent.create([data], { session });
      logger.info('OFFICIAL_FISCAL_EVENT_RECORDED', {
        officialFiscalEventId: event._id.toString(),
        fiscalInvoice: event.fiscalInvoice?.toString(),
        tipoEvento: event.tipoEvento,
        source: event.source
      });
      return event;
    } catch (error) {
      logger.error('CREATE_ERROR', { error: error.message });
      throw error;
    }
  }
}

export const officialFiscalEventRepository = new OfficialFiscalEventRepository();
