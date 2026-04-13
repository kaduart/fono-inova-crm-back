// dtos/completeSessionResponse.dto.js
// 🎯 DTO Padronizado para resposta de Complete Session V2

/**
 * Formata resposta de completação de sessão
 * 
 * @param {Object} params
 * @param {string} params.appointmentId
 * @param {string} params.sessionId
 * @param {string} params.packageId
 * @param {string} params.clinicalStatus
 * @param {string} params.operationalStatus
 * @param {string} params.paymentStatus
 * @param {number} params.balanceAmount
 * @param {number} params.sessionValue
 * @param {boolean} params.isPaid
 * @param {Date} params.completedAt
 * @param {string} params.correlationId
 * @param {boolean} params.idempotent
 * @returns {Object} DTO formatado
 */
export function createCompleteSessionResponse(params) {
  const {
    appointmentId,
    sessionId,
    packageId,
    clinicalStatus,
    operationalStatus,
    paymentStatus,
    balanceAmount,
    sessionValue,
    isPaid,
    completedAt,
    correlationId,
    idempotent = false
  } = params;

  return {
    success: true,
    idempotent,
    message: idempotent ? 'Sessão já estava completada' : 'Sessão completada com sucesso',
    data: {
      appointmentId,
      sessionId,
      packageId,
      clinicalStatus,
      operationalStatus,
      paymentStatus,
      balanceAmount,
      sessionValue,
      isPaid,
      completedAt: completedAt?.toISOString?.() || new Date().toISOString()
    },
    meta: {
      version: 'v2',
      correlationId,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * DTO de erro padronizado
 */
export function createErrorResponse(error) {
  return {
    success: false,
    error: {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message
    },
    meta: {
      version: 'v2',
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Mapeia billing type para payment status esperado
 */
export const BILLING_TO_PAYMENT_STATUS = {
  'particular': 'unpaid',
  'therapy': 'unpaid',
  'convenio': 'pending_receipt',
  'liminar': 'paid'
};

/**
 * Verifica se o estado é válido para completação
 */
export const VALID_COMPLETE_TRANSITIONS = {
  'scheduled': true,
  'confirmed': true,
  'canceled': false,  // ❌ Não pode completar canceled
  'completed': true   // 🔄 Idempotente
};

export default {
  createCompleteSessionResponse,
  createErrorResponse,
  BILLING_TO_PAYMENT_STATUS,
  VALID_COMPLETE_TRANSITIONS
};
