// infrastructure/persistence/FiscalProfileRepository.js
// Repository Pattern - Abstrai persistência de FiscalProfile.
// Nenhuma lógica de resolução de provider aqui — isso é do FiscalProviderResolver (PR3).

import FiscalProfile from '../../models/FiscalProfile.js';
import Logger from '../../services/utils/Logger.js';

const logger = new Logger('FiscalProfileRepository');

export class FiscalProfileRepository {
  async findById(fiscalProfileId) {
    try {
      return await FiscalProfile.findById(fiscalProfileId);
    } catch (error) {
      logger.error('FIND_BY_ID_ERROR', { fiscalProfileId, error: error.message });
      throw error;
    }
  }

  async findActiveByCnpj(cnpj) {
    try {
      return await FiscalProfile.findOne({ cnpj, ativo: true });
    } catch (error) {
      logger.error('FIND_ACTIVE_BY_CNPJ_ERROR', { cnpj, error: error.message });
      throw error;
    }
  }

  async findActiveByMunicipio(municipioIBGE) {
    try {
      return await FiscalProfile.find({ municipioIBGE, ativo: true });
    } catch (error) {
      logger.error('FIND_ACTIVE_BY_MUNICIPIO_ERROR', { municipioIBGE, error: error.message });
      throw error;
    }
  }

  async create(data) {
    try {
      const profile = new FiscalProfile(data);
      await profile.save();
      logger.info('FISCAL_PROFILE_CREATED', {
        fiscalProfileId: profile._id.toString(),
        cnpj: profile.cnpj,
        municipioIBGE: profile.municipioIBGE
      });
      return profile;
    } catch (error) {
      logger.error('CREATE_ERROR', { error: error.message });
      throw error;
    }
  }

  async updateFields(fiscalProfileId, fields) {
    try {
      const result = await FiscalProfile.findByIdAndUpdate(fiscalProfileId, { $set: fields }, { new: true });
      logger.info('FISCAL_PROFILE_UPDATED', { fiscalProfileId, fields: Object.keys(fields) });
      return result;
    } catch (error) {
      logger.error('UPDATE_FIELDS_ERROR', { fiscalProfileId, error: error.message });
      throw error;
    }
  }
}

export const fiscalProfileRepository = new FiscalProfileRepository();
