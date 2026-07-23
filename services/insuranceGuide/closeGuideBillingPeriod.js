// back/services/insuranceGuide/closeGuideBillingPeriod.js
/**
 * Fechamento automático do período de faturamento de uma guia de convênio.
 *
 * Contexto: guias `billingMode='per_month'` autorizam N sessões para um período.
 * Cada InsuranceGuide já É o próprio período/ciclo (expiresAt fixo, usedSessions
 * monotônico, renovação = novo documento via supersede) — não existe "sub-ciclo"
 * dentro do mesmo documento. Quando a guia é faturada com sucesso, appointments
 * pendentes dela (que não serão mais realizados) devem ser cancelados para não
 * colidir com a agenda quando a próxima guia for criada.
 *
 * Escopo: só guias per_month. Guias per_guide (sem reset de período) são skip.
 * Cancela pendências de qualquer data (passada ou futura) — buildBatchFromGuides
 * não é period-scoped, então uma guia pode ser faturada bem depois do período
 * nominal dela; não faz sentido restringir por data aqui.
 */

import mongoose from 'mongoose';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Appointment from '../../models/Appointment.js';
import bulkCancelAppointmentsCommand from '../appointment/commands/bulkCancelAppointmentsCommand.js';
import { safeAbortTransaction } from '../../utils/safeAbortTransaction.js';

const PENDING_STATUSES = ['scheduled', 'pre_agendado', 'confirmed'];

/**
 * @param {string|ObjectId} guideId
 * @param {Object} [options]
 * @param {string} [options.userId]
 * @returns {Promise<{skipped: boolean, reason?: string, guideId?: string, canceled?: number, canceledIds?: Array, errors?: Array}>}
 */
export async function closeGuideBillingPeriod(guideId, { userId } = {}) {
  const guide = await InsuranceGuide.findById(guideId).lean();
  if (!guide) {
    return { skipped: true, reason: 'guide_not_found', guideId: String(guideId) };
  }
  if (guide.billingMode !== 'per_month') {
    return { skipped: true, reason: 'not_per_month', guideId: guide._id.toString() };
  }

  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.startTransaction();

    const pending = await Appointment.find({
      insuranceGuide: guide._id,
      operationalStatus: { $in: PENDING_STATUSES }
    }).session(mongoSession).select('_id').lean();

    let result = { canceled: 0, canceledIds: [], errors: [] };
    if (pending.length > 0) {
      result = await bulkCancelAppointmentsCommand.executeWithSession(
        pending.map((a) => a._id),
        { reason: 'guide_cycle_closed', cancelSource: 'guide_closure' },
        { _id: userId },
        mongoSession
      );
    }

    // Registra quem fechou e quando — esta ação é manual, não automática
    await InsuranceGuide.findByIdAndUpdate(
      guide._id,
      { $set: { status: 'closed', closedAt: new Date(), closedBy: userId || null } },
      { session: mongoSession }
    );

    await mongoSession.commitTransaction();
    return { skipped: false, guideId: guide._id.toString(), ...result };
  } catch (error) {
    await safeAbortTransaction(mongoSession);
    throw error;
  } finally {
    await mongoSession.endSession();
  }
}

export default { closeGuideBillingPeriod };
