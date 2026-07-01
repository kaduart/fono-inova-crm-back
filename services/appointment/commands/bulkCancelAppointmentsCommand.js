// back/services/appointment/commands/bulkCancelAppointmentsCommand.js
/**
 * Bulk Cancel Appointments Command
 *
 * Responsabilidade: cancelar múltiplos agendamentos de uma vez,
 * reusando cancelAppointmentCommand.executeWithSession dentro de uma
 * transação MongoDB existente.
 *
 * Usado por:
 * - generateLiminarSessions (reset)
 * - package.guard (pacote finalizado)
 * - insurancePlans.v2 (plano cancelado/resetado)
 * - provisionamentoService (liberar vagas em massa)
 */

import { executeWithSession as cancelAppointmentWithSession } from './cancelAppointmentCommand.js';

/**
 * Cancela uma lista de appointments dentro de uma session existente.
 *
 * @param {Array<string|ObjectId>} ids - IDs dos appointments
 * @param {Object} params
 * @param {string} params.reason - Motivo do cancelamento
 * @param {boolean} [params.confirmedAbsence=false] - Falta confirmada
 * @param {Object} [user] - Usuário/system
 * @param {mongoose.ClientSession} session - Session MongoDB ativa
 * @returns {Promise<{ canceled: number, errors: Array<{id, error}> }>}
 */
export async function executeWithSession(ids, { reason, confirmedAbsence = false }, user, session) {
  if (!reason) {
    throw new Error('O motivo do cancelamento é obrigatório');
  }

  const canceled = [];
  const errors = [];

  for (const id of ids) {
    try {
      const result = await cancelAppointmentWithSession(
        id,
        { reason, confirmedAbsence },
        user,
        session
      );
      if (result && result.operationalStatus === 'canceled') {
        canceled.push(id);
      }
    } catch (err) {
      errors.push({ id, error: err.message });
      console.error('[bulkCancelAppointmentsCommand] Erro ao cancelar', id, err.message);
    }
  }

  return {
    canceled: canceled.length,
    canceledIds: canceled,
    errors,
  };
}

export default { executeWithSession };
