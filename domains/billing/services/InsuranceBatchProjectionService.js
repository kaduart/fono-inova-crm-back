// back/domains/billing/services/InsuranceBatchProjectionService.js
/**
 * InsuranceBatch Projection Service
 * 
 * Responsabilidade: Construir/atualizar a view de lotes de convênio
 * a partir do modelo original (InsuranceBatch).
 * 
 * Princípios:
 * - SEMPRE busca do source of truth (InsuranceBatch)
 * - NUNCA assume que dados estão completos
 * - Rebuild completo = idempotente
 */

import InsuranceBatch from '../../../models/InsuranceBatch.js';
import InsuranceBatchView from '../../../models/InsuranceBatchView.js';
import { createContextLogger } from '../../../utils/logger.js';

const logger = createContextLogger('InsuranceBatchProjection');

/**
 * Build completo da view de um lote de convênio
 * @param {string} batchId - ID do lote
 * @param {Object} options - Opções
 * @returns {Promise<Object>} View construída
 */
export async function buildInsuranceBatchView(batchId, options = {}) {
  const { correlationId = `ibuild_${Date.now()}` } = options;
  
  const startTime = Date.now();
  logger.info(`[${correlationId}] 🏥 Building InsuranceBatch view`, { batchId });

  try {
    // 1. Busca o lote original (source of truth)
    const batch = await InsuranceBatch.findById(batchId)
      .populate('sessions.session', 'date status')
      .populate('sessions.appointment', 'date status')
      .lean();

    if (!batch) {
      logger.warn(`[${correlationId}] ⚠️ InsuranceBatch not found`, { batchId });
      return null;
    }

    // 2. Mapeia sessões para o formato da view
    const sessionsView = batch.sessions?.map(s => ({
      sessionId: s.session?._id?.toString() || s.session?.toString(),
      appointmentId: s.appointment?._id?.toString() || s.appointment?.toString(),
      guideId: s.guide?.toString(),
      grossAmount: s.grossAmount || 0,
      netAmount: s.netAmount,
      returnAmount: s.returnAmount,
      glosaAmount: s.glosaAmount,
      status: s.status,
      glosaReason: s.glosaReason,
      protocolNumber: s.protocolNumber,
      sentAt: s.sentAt,
      processedAt: s.processedAt
    })) || [];

    // 3. Constrói o documento da view
    const viewData = {
      batchId: batch._id.toString(),
      batchNumber: batch.batchNumber,
      insuranceProvider: batch.insuranceProvider,
      startDate: batch.startDate,
      endDate: batch.endDate,
      sentDate: batch.sentDate,
      sessions: sessionsView,
      totalSessions: batch.totalSessions || sessionsView.length,
      totalGross: batch.totalGross || 0,
      totalNet: batch.totalNet || 0,
      receivedAmount: batch.receivedAmount || 0,
      totalGlosa: batch.totalGlosa || 0,
      status: batch.status,
      xmlFile: batch.xmlFile,
      returnFile: batch.returnFile,
      processedAt: batch.processedAt,
      processedBy: batch.processedBy?.toString(),
      notes: batch.notes,
      correlationId: batch.correlationId,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      snapshot: {
        version: (batch.snapshot?.version || 0) + 1,
        lastRebuildAt: new Date()
      }
    };

    // 4. Upsert na view
    const view = await InsuranceBatchView.findOneAndUpdate(
      { batchId: viewData.batchId },
      viewData,
      { upsert: true, new: true }
    );

    const duration = Date.now() - startTime;
    logger.info(`[${correlationId}] ✅ InsuranceBatch view built`, {
      batchId,
      batchNumber: batch.batchNumber,
      sessionsCount: sessionsView.length,
      duration: `${duration}ms`
    });

    return {
      view,
      duration,
      correlationId
    };

  } catch (error) {
    logger.error(`[${correlationId}] ❌ Error building InsuranceBatch view`, {
      batchId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Deleta a view de um lote
 * @param {string} batchId - ID do lote
 */
export async function deleteInsuranceBatchView(batchId) {
  const result = await InsuranceBatchView.deleteOne({ batchId });
  logger.info(`🗑️ InsuranceBatch view deleted`, { batchId, deleted: result.deletedCount });
  return result;
}

/**
 * Rebuild em massa (para migração ou recuperação)
 * @param {Object} options - Opções de filtro
 */
export async function rebuildAllInsuranceBatchViews(options = {}) {
  const { status = null, limit = 100 } = options;
  
  logger.info(`🔄 Starting mass rebuild of InsuranceBatch views`, { status, limit });

  const query = status ? { status } : {};
  const batches = await InsuranceBatch.find(query)
    .limit(limit)
    .select('_id')
    .lean();

  const results = { succeeded: 0, failed: 0, errors: [] };

  for (const batch of batches) {
    try {
      await buildInsuranceBatchView(batch._id.toString());
      results.succeeded++;
    } catch (error) {
      results.failed++;
      results.errors.push({ batchId: batch._id.toString(), error: error.message });
    }
  }

  logger.info(`✅ Mass rebuild completed`, results);
  return results;
}

export default {
  buildInsuranceBatchView,
  deleteInsuranceBatchView,
  rebuildAllInsuranceBatchViews
};
