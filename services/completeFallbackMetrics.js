/**
 * Métricas de fallback do complete V1.
 *
 * Esse módulo existe apenas durante a transição V1 → V2 do complete.
 * Objetivo: dar visibilidade total de quantas vezes o caminho legado ainda
 * é acionado, para que possamos removê-lo com segurança.
 */

const metrics = {
  v1FallbackCount: 0,
  lastEvent: null,
  firstEventAt: null,
};

/**
 * Registra um uso do fallback V1 do complete.
 *
 * @param {Object} payload
 * @param {string} payload.appointmentId
 * @param {string} [payload.patientId]
 * @param {string} [payload.userId]
 * @param {string} [payload.reason] - 'flag_disabled' | 'emergency_rollback' | 'percentage_fallback'
 */
export function recordCompleteV1Fallback(payload = {}) {
  const now = new Date();

  metrics.v1FallbackCount += 1;
  metrics.lastEvent = {
    ...payload,
    timestamp: now.toISOString(),
  };

  if (!metrics.firstEventAt) {
    metrics.firstEventAt = now.toISOString();
  }

  // Log estruturado para fácil indexação em qualquer ferramenta de logs
  console.error('[COMPLETE_FALLBACK_V1_USED]', JSON.stringify({
    appointmentId: payload.appointmentId,
    patientId: payload.patientId,
    userId: payload.userId,
    reason: payload.reason,
    count: metrics.v1FallbackCount,
    timestamp: now.toISOString(),
  }));
}

/**
 * Retorna as métricas atuais de fallback V1.
 */
export function getCompleteV1FallbackMetrics() {
  return {
    v1FallbackCount: metrics.v1FallbackCount,
    lastEvent: metrics.lastEvent,
    firstEventAt: metrics.firstEventAt,
    since: metrics.firstEventAt || new Date().toISOString(),
    safeToRemove: metrics.v1FallbackCount === 0,
  };
}

/**
 * Reseta as métricas (útil para testes).
 */
export function resetCompleteV1FallbackMetrics() {
  metrics.v1FallbackCount = 0;
  metrics.lastEvent = null;
  metrics.firstEventAt = null;
}
