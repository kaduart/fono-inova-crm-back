// infrastructure/persistence/CertificateRepository.js
// Repository Pattern - Abstrai persistência de Certificate.
// Nenhuma lógica de assinatura/validação de senha aqui — isso é do CertificateManager (Fase 3,
// fora do escopo do PR1). Aqui só CRUD estrutural.

import Certificate from '../../models/Certificate.js';
import Logger from '../../services/utils/Logger.js';

const logger = new Logger('CertificateRepository');

export class CertificateRepository {
  async findById(certificateId) {
    try {
      return await Certificate.findById(certificateId);
    } catch (error) {
      logger.error('FIND_BY_ID_ERROR', { certificateId, error: error.message });
      throw error;
    }
  }

  async findExpiringBefore(date) {
    try {
      return await Certificate.find({ expiresAt: { $lte: date } });
    } catch (error) {
      logger.error('FIND_EXPIRING_BEFORE_ERROR', { date, error: error.message });
      throw error;
    }
  }

  async findByStatus(status) {
    try {
      return await Certificate.find({ status });
    } catch (error) {
      logger.error('FIND_BY_STATUS_ERROR', { status, error: error.message });
      throw error;
    }
  }

  async create(data) {
    try {
      const certificate = new Certificate(data);
      await certificate.save();
      logger.info('CERTIFICATE_CREATED', { certificateId: certificate._id.toString(), type: certificate.type });
      return certificate;
    } catch (error) {
      logger.error('CREATE_ERROR', { error: error.message });
      throw error;
    }
  }

  async updateStatus(certificateId, status) {
    try {
      const result = await Certificate.findByIdAndUpdate(certificateId, { $set: { status } }, { new: true });
      logger.info('CERTIFICATE_STATUS_UPDATED', { certificateId, status });
      return result;
    } catch (error) {
      logger.error('UPDATE_STATUS_ERROR', { certificateId, status, error: error.message });
      throw error;
    }
  }
}

export const certificateRepository = new CertificateRepository();
