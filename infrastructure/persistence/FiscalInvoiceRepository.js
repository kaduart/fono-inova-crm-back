// infrastructure/persistence/FiscalInvoiceRepository.js
// Repository Pattern - Abstrai persistência de FiscalInvoice (Fiscal Domain)
// Responsabilidade: CRUD + Queries estruturais. Nenhuma regra de negócio aqui — mudança de
// status é responsabilidade exclusiva do FiscalStateMachineService (PR2), nunca deste repository.

import FiscalInvoice from '../../models/FiscalInvoice.js';
import Logger from '../../services/utils/Logger.js';

const logger = new Logger('FiscalInvoiceRepository');

export class FiscalInvoiceRepository {
  async findById(fiscalInvoiceId) {
    try {
      return await FiscalInvoice.findById(fiscalInvoiceId);
    } catch (error) {
      logger.error('FIND_BY_ID_ERROR', { fiscalInvoiceId, error: error.message });
      throw error;
    }
  }

  async findByChaveAcesso(chaveAcesso) {
    try {
      return await FiscalInvoice.findOne({ chaveAcesso });
    } catch (error) {
      logger.error('FIND_BY_CHAVE_ACESSO_ERROR', { chaveAcesso, error: error.message });
      throw error;
    }
  }

  async findByOrigin(originType, originId) {
    try {
      return await FiscalInvoice.find({ 'origin.type': originType, 'origin.id': originId });
    } catch (error) {
      logger.error('FIND_BY_ORIGIN_ERROR', { originType, originId, error: error.message });
      throw error;
    }
  }

  async findByPatient(patientId, { limit = 50 } = {}) {
    try {
      return await FiscalInvoice.find({ patient: patientId })
        .sort({ createdAt: -1 })
        .limit(limit);
    } catch (error) {
      logger.error('FIND_BY_PATIENT_ERROR', { patientId, error: error.message });
      throw error;
    }
  }

  async findByStatus(status, { limit = 100 } = {}) {
    try {
      return await FiscalInvoice.find({ status })
        .sort({ createdAt: -1 })
        .limit(limit);
    } catch (error) {
      logger.error('FIND_BY_STATUS_ERROR', { status, error: error.message });
      throw error;
    }
  }

  async create(data, { session } = {}) {
    try {
      const [fiscalInvoice] = await FiscalInvoice.create([data], { session });
      logger.info('FISCAL_INVOICE_CREATED', {
        fiscalInvoiceId: fiscalInvoice._id.toString(),
        origin: fiscalInvoice.origin
      });
      return fiscalInvoice;
    } catch (error) {
      logger.error('CREATE_ERROR', { error: error.message });
      throw error;
    }
  }

  /**
   * Update estrutural genérico (campos que não são `status` — mudança de status é exclusiva
   * do FiscalStateMachineService, PR2). Lança erro se o chamador tentar setar `status` aqui.
   */
  async updateFields(fiscalInvoiceId, fields, { session } = {}) {
    if (Object.prototype.hasOwnProperty.call(fields, 'status')) {
      throw new Error('FiscalInvoiceRepository.updateFields não pode alterar `status` diretamente — use FiscalStateMachineService (PR2)');
    }
    try {
      const result = await FiscalInvoice.findByIdAndUpdate(
        fiscalInvoiceId,
        { $set: fields },
        { new: true, session }
      );
      logger.info('FISCAL_INVOICE_UPDATED', { fiscalInvoiceId, fields: Object.keys(fields) });
      return result;
    } catch (error) {
      logger.error('UPDATE_FIELDS_ERROR', { fiscalInvoiceId, error: error.message });
      throw error;
    }
  }

  /**
   * Único ponto autorizado a alterar `status` — chamado exclusivamente pelo
   * FiscalStateMachineService (domain/fiscal/stateMachine/FiscalStateMachineService.js).
   * Não é para ser chamado diretamente por outros services.
   */
  async _setStatus(fiscalInvoiceId, status, extraFields = {}, { session } = {}) {
    try {
      const result = await FiscalInvoice.findByIdAndUpdate(
        fiscalInvoiceId,
        { $set: { status, ...extraFields } },
        { new: true, session }
      );
      logger.info('FISCAL_INVOICE_STATUS_TRANSITIONED', { fiscalInvoiceId, status });
      return result;
    } catch (error) {
      logger.error('SET_STATUS_ERROR', { fiscalInvoiceId, status, error: error.message });
      throw error;
    }
  }
}

// Exporta instância singleton
export const fiscalInvoiceRepository = new FiscalInvoiceRepository();
