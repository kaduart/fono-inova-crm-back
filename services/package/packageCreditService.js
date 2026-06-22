// back/services/package/packageCreditService.js
/**
 * Package Credit Service
 *
 * Responsabilidade única: gerenciar crédito reaproveitável de sessões de pacote canceladas.
 *
 * Regra:
 * - Uma sessão de pacote cancelada que estava paga pode ter seu crédito reutilizado
 *   em uma nova sessão do mesmo pacote.
 * - O crédito é consumido (zerado) quando reutilizado.
 */

import Session from '../../models/Session.js';

/**
 * Busca uma sessão cancelada do pacote que tenha crédito reaproveitável.
 *
 * @param {string} packageId - ID do pacote
 * @param {mongoose.ClientSession|null} mongoSession
 * @returns {Promise<Object|null>} - Sessão com crédito ou null
 */
export async function findReusableCredit(packageId, mongoSession = null) {
  if (!packageId) return null;

  const query = Session.findOne({
    package: packageId,
    status: 'canceled',
    $or: [
      { originalPaymentStatus: { $exists: true } },
      { originalIsPaid: true },
      { originalPartialAmount: { $exists: true, $gt: 0 } },
    ],
  }).sort({ canceledAt: -1 });

  if (mongoSession) {
    query.session(mongoSession);
  }

  return query;
}

/**
 * Verifica se uma sessão tem crédito reaproveitável.
 */
export function hasReusableCredit(session) {
  if (!session) return false;
  return session.originalPartialAmount > 0;
}

/**
 * Consome o crédito de uma sessão cancelada, zerando seus campos originais.
 *
 * @param {Object} session - Sessão cancelada com crédito
 * @param {mongoose.ClientSession|null} mongoSession
 * @returns {Promise<Object>} - Sessão atualizada
 */
export async function consumeCredit(session, mongoSession = null) {
  if (!session) return null;

  session.originalPartialAmount = 0;
  session.originalPaymentStatus = null;
  session.originalIsPaid = false;
  session.originalPaymentMethod = null;

  await session.save({
    session: mongoSession,
    validateBeforeSave: false,
  });

  return session;
}

/**
 * Aplica crédito reutilizável em uma nova sessão.
 * Retorna os campos que devem ser setados na nova sessão.
 *
 * @param {Object} canceledSession - Sessão cancelada com crédito
 * @param {Object} packageDoc - Documento do pacote (opcional)
 * @param {string} fallbackPaymentMethod - Método de pagamento fallback
 * @returns {Object} - { isPaid, paymentStatus, visualFlag, paymentMethod, partialAmount }
 */
export function buildCreditApplication(
  canceledSession,
  packageDoc = null,
  fallbackPaymentMethod = 'dinheiro'
) {
  return {
    isPaid: true,
    paymentStatus: 'paid',
    visualFlag: 'ok',
    paymentMethod:
      canceledSession.originalPaymentMethod ||
      packageDoc?.paymentMethod ||
      fallbackPaymentMethod,
    partialAmount: Number(canceledSession.originalPartialAmount) || 0,
  };
}

/**
 * Busca e consome atomicamente um crédito reaproveitável de sessão cancelada.
 *
 * ✅ Resolve:
 * - Race condition entre agendamentos concorrentes
 * - Perda de crédito em retry de transação
 *
 * @param {string} packageId - ID do pacote
 * @param {mongoose.ClientSession|null} mongoSession
 * @returns {Promise<Object|null>} - Dados do crédito consumido ou null
 */
export async function claimReusableCredit(packageId, mongoSession = null) {
  if (!packageId) return null;

  const query = Session.findOneAndUpdate(
    {
      package: packageId,
      status: 'canceled',
      originalPartialAmount: { $gt: 0 },
    },
    {
      $set: {
        originalPartialAmount: 0,
        originalPaymentStatus: null,
        originalIsPaid: false,
        originalPaymentMethod: null,
      },
    },
    {
      new: false, // retorna documento ANTES da atualização
      sort: { canceledAt: -1 },
    }
  );

  if (mongoSession) {
    query.session(mongoSession);
  }

  const consumedSession = await query;
  if (!consumedSession || !(consumedSession.originalPartialAmount > 0)) {
    return null;
  }

  return {
    partialAmount: Number(consumedSession.originalPartialAmount),
    paymentMethod: consumedSession.originalPaymentMethod,
    paymentStatus: consumedSession.originalPaymentStatus,
    isPaid: consumedSession.originalIsPaid,
    sourceSessionId: consumedSession._id.toString(),
  };
}

export default {
  findReusableCredit,
  hasReusableCredit,
  consumeCredit,
  buildCreditApplication,
  claimReusableCredit,
};
