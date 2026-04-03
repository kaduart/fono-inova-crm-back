/**
 * ============================================================================
 * FINANCIAL STATE MACHINE - V2
 * ============================================================================
 * 
 * Define transições válidas de status financeiro.
 * Qualquer transição fora dessa máquina = ERRO
 * 
 * Estados:
 * - pending_billing: Aguardando faturamento
 * - billed: Faturado, aguardando pagamento  
 * - paid: Pago, ciclo fechado
 * - cancelled: Cancelado (estado terminal)
 * 
 * Regras:
 * 1. Só pode avançar (não volta)
 * 2. Só pode ir para billed se estiver em pending_billing
 * 3. Só pode ir para paid se estiver em billed
 * 4. Cancelamento pode vir de qualquer estado (menos paid)
 * ============================================================================
 */

export const FINANCIAL_STATES = {
  PENDING_BILLING: 'pending_billing',
  BILLED: 'billed',
  PAID: 'paid',
  CANCELLED: 'cancelled'
};

export const VALID_TRANSITIONS = {
  [FINANCIAL_STATES.PENDING_BILLING]: [
    FINANCIAL_STATES.BILLED,
    FINANCIAL_STATES.CANCELLED
  ],
  [FINANCIAL_STATES.BILLED]: [
    FINANCIAL_STATES.PAID,
    FINANCIAL_STATES.CANCELLED
  ],
  [FINANCIAL_STATES.PAID]: [], // Terminal - não sai
  [FINANCIAL_STATES.CANCELLED]: [] // Terminal - não sai
};

/**
 * Valida se uma transição de status é permitida
 * @throws Error se transição for inválida
 */
export function validateTransition(currentStatus, newStatus, context = {}) {
  // Mesmo status = ok (idempotência)
  if (currentStatus === newStatus) {
    return { valid: true, reason: 'SAME_STATUS' };
  }
  
  const allowed = VALID_TRANSITIONS[currentStatus] || [];
  
  if (!allowed.includes(newStatus)) {
    const error = new Error(
      `Invalid financial transition: ${currentStatus} → ${newStatus}. ` +
      `Allowed from ${currentStatus}: [${allowed.join(', ')}]`
    );
    error.code = 'INVALID_FINANCIAL_TRANSITION';
    error.context = {
      currentStatus,
      newStatus,
      allowed,
      ...context
    };
    throw error;
  }
  
  return { valid: true };
}

/**
 * Verifica se pode faturar (billed)
 */
export function canBill(currentStatus) {
  return VALID_TRANSITIONS[currentStatus]?.includes(FINANCIAL_STATES.BILLED) || false;
}

/**
 * Verifica se pode receber (paid)
 */
export function canReceive(currentStatus) {
  return VALID_TRANSITIONS[currentStatus]?.includes(FINANCIAL_STATES.PAID) || false;
}

/**
 * Verifica se pode cancelar
 */
export function canCancel(currentStatus) {
  return currentStatus !== FINANCIAL_STATES.PAID && 
         currentStatus !== FINANCIAL_STATES.CANCELLED;
}

/**
 * Retorna próximos estados válidos
 */
export function getNextValidStates(currentStatus) {
  return VALID_TRANSITIONS[currentStatus] || [];
}

/**
 * Verifica se estado é terminal (não tem saída)
 */
export function isTerminalState(status) {
  return [FINANCIAL_STATES.PAID, FINANCIAL_STATES.CANCELLED].includes(status);
}
