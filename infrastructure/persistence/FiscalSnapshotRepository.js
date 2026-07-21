// infrastructure/persistence/FiscalSnapshotRepository.js
// Repository Pattern - Abstrai persistência de FiscalSnapshot.
// Não criado no PR1 — adicionado no PR2 porque só agora existe um consumidor real
// (FiscalSnapshotBuilder). Imutável por design: só create e find*, nunca update.

import FiscalSnapshot from '../../models/FiscalSnapshot.js';
import Logger from '../../services/utils/Logger.js';

const logger = new Logger('FiscalSnapshotRepository');

export class FiscalSnapshotRepository {
  async findById(fiscalSnapshotId) {
    try {
      return await FiscalSnapshot.findById(fiscalSnapshotId);
    } catch (error) {
      logger.error('FIND_BY_ID_ERROR', { fiscalSnapshotId, error: error.message });
      throw error;
    }
  }

  async findByFiscalSubmission(fiscalSubmissionId) {
    try {
      return await FiscalSnapshot.findOne({ fiscalSubmission: fiscalSubmissionId });
    } catch (error) {
      logger.error('FIND_BY_FISCAL_SUBMISSION_ERROR', { fiscalSubmissionId, error: error.message });
      throw error;
    }
  }

  async create(data, { session } = {}) {
    try {
      const [snapshot] = await FiscalSnapshot.create([data], { session });
      logger.info('FISCAL_SNAPSHOT_CREATED', {
        fiscalSnapshotId: snapshot._id.toString(),
        fiscalSubmission: snapshot.fiscalSubmission?.toString(),
        schemaVersion: snapshot.schemaVersion
      });
      return snapshot;
    } catch (error) {
      logger.error('CREATE_ERROR', { error: error.message });
      throw error;
    }
  }
}

export const fiscalSnapshotRepository = new FiscalSnapshotRepository();
