// domain/session/cancelSession.js
// Re-exporta do clinical domain service + stubs para compatibilidade

export { cancelSession } from '../../domains/clinical/services/sessionService.js';

/**
 * Stub para compatibilidade de API
 * Não utilizado ativamente no momento
 */
export async function findReusableCanceledSession(patientId, context = {}) {
  return null;
}

/**
 * Stub para compatibilidade de API
 * Não utilizado ativamente no momento
 */
export async function consumeCanceledSessionCredit(sessionId, context = {}) {
  return { consumed: false };
}
