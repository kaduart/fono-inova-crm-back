// back/services/insuranceBatch/insuranceBatchGuard.js
//
// Guarda de integridade entre Appointment/Session/Payment e InsuranceBatch.
//
// Um agendamento de convênio que já entrou em um lote de faturamento não pode
// ser deletado silenciosamente — isso deixa referências órfãs no lote e quebra
// rastreabilidade financeira.

import InsuranceBatch from '../../models/InsuranceBatch.js';

const PROTECTED_BATCH_STATUSES = ['ready', 'sent', 'billed', 'received', 'processing'];

/**
 * Verifica se uma Session ou Payment está vinculada a um InsuranceBatch cujo
 * status já entrou no ciclo financeiro.
 *
 * @param {Object} params
 * @param {string|ObjectId} [params.sessionId]
 * @param {string|ObjectId} [params.paymentId]
 * @param {Array<string>} [params.protectedStatuses]
 * @returns {Promise<InsuranceBatch|null>} O batch encontrado ou null
 */
export async function findActiveBatchLink({
  sessionId,
  paymentId,
  protectedStatuses = PROTECTED_BATCH_STATUSES
} = {}) {
  if (!sessionId && !paymentId) return null;

  const orConditions = [];
  if (sessionId) orConditions.push({ 'sessions.session': sessionId });
  if (paymentId) orConditions.push({ 'sessions.payment': paymentId });

  const batch = await InsuranceBatch.findOne({
    $or: orConditions,
    status: { $in: protectedStatuses }
  }).lean();

  return batch;
}

/**
 * Alias semântico para verificação antes de deleção.
 *
 * @returns {Promise<InsuranceBatch|null>}
 */
export async function assertNoActiveBatchLink({ sessionId, paymentId } = {}) {
  return findActiveBatchLink({ sessionId, paymentId });
}

export { PROTECTED_BATCH_STATUSES };
export default { findActiveBatchLink, assertNoActiveBatchLink };
