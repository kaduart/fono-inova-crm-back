/**
 * Métricas de fallback do complete V1.
 *
 * Esse módulo existe apenas durante a transição V1 → V2 do complete.
 * Objetivo: dar visibilidade total de quantas vezes o caminho legado ainda
 * é acionado, para que possamos removê-lo com segurança.
 *
 * O contador em memória zera a cada deploy — não serve pra provar "não foi
 * usado nas últimas 2-3 semanas". Por isso todo acionamento também grava um
 * AuditLog CRITICAL, que sobrevive a deploys/restart (TTL de 1 ano).
 */

import AuditLog from '../models/AuditLog.js';

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

  // Registro durável — best-effort, nunca deve derrubar o complete em si.
  // É a fonte usada por GET /api/v2/health/complete-fallback pra decidir
  // com segurança quando o V1 pode ser removido de vez.
  if (payload.appointmentId) {
    AuditLog.create({
      userId: payload.userId || null,
      action: 'complete_v1_fallback_used',
      entityType: 'Appointment',
      entityId: payload.appointmentId,
      source: 'appointment.v2.complete.fallback',
      correlationId: payload.correlationId || null,
      severity: 'CRITICAL',
      metadata: {
        patientId: payload.patientId || null,
        reason: payload.reason || null,
      },
    }).catch(err => {
      console.error('[COMPLETE_FALLBACK_V1_USED] Falha ao gravar AuditLog (não bloqueia):', err.message);
    });
  }
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
