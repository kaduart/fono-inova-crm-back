// completeSession/shared/context.js
// Contrato de contexto passado a todos os handlers de complete.
// Imutável — handlers lêem, nunca escrevem aqui.

/**
 * @typedef {Object} CompleteContext
 * @property {Object}  appointment     - Appointment populado (patient, doctor, package, liminarContract)
 * @property {string}  appointmentId
 * @property {string}  sessionId       - _id da Session linkada (pode ser null em flows legados)
 * @property {Object}  sessionDoc      - Session document (pode ser null)
 * @property {string}  packageId
 * @property {Object}  packageData     - Package document (pode ser null)
 * @property {string}  billingType     - 'convenio' | 'liminar' | 'particular' | (package)
 * @property {number}  sessionValue
 * @property {Object}  mongoSession    - Mongoose ClientSession (transação ativa)
 * @property {string}  userId
 * @property {string}  correlationId
 * @property {boolean} isBalanceOrigin - Sessão vai para saldo do paciente em vez de pagamento imediato
 * @property {boolean} isPerSessionPkg - Package per-session (não pré-pago)
 * @property {boolean} addToBalance
 * @property {number}  balanceAmount
 */

/**
 * Constrói o contexto imutável passado aos handlers.
 *
 * @param {Object} params
 * @returns {CompleteContext}
 */
export function buildCompleteContext({
    appointment,
    appointmentId,
    sessionId,
    sessionDoc,
    packageId,
    packageData,
    billingType,
    sessionValue,
    mongoSession,
    userId,
    correlationId,
    isBalanceOrigin,
    isPerSessionPkg,
    addToBalance,
    balanceAmount,
    splitMethods
}) {
    return {
        appointment,
        appointmentId: appointmentId || appointment?._id,
        sessionId,
        sessionDoc,
        packageId,
        packageData,
        billingType,
        sessionValue,
        mongoSession,
        userId,
        correlationId,
        isBalanceOrigin: !!isBalanceOrigin,
        isPerSessionPkg: !!isPerSessionPkg,
        addToBalance:    !!addToBalance,
        balanceAmount:   balanceAmount || 0,
        splitMethods:    Array.isArray(splitMethods) && splitMethods.length >= 2 ? splitMethods : null
    };
}
