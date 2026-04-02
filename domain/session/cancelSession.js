// domain/session/cancelSession.js
import Session from '../../models/Session.js';

/**
 * Cancela uma sessão preservando histórico financeiro
 * 
 * Regras do legado (appointment.js:1472-1526):
 * - Preserva dados em 'original*' se estava paga
 * - Marca status como 'canceled'
 * - NÃO estorna sessionConsumed (isso é no complete)
 * 
 * @param {Object} session - Documento Session do Mongoose
 * @param {Object} options - Opções
 * @param {String} options.reason - Motivo do cancelamento
 * @param {Boolean} options.confirmedAbsence - Confirmação de falta
 * @param {ObjectId} options.userId - ID do usuário que cancelou
 * @returns {Object} Session atualizada
 */
export async function cancelSession(session, options = {}) {
    const { reason = '', confirmedAbsence = false, userId = null } = options;

    // 🛡️ IDEMPOTÊNCIA
    if (session.status === 'canceled') {
        console.log(`[cancelSession] Sessão ${session._id} já cancelada`);
        return { session, alreadyCanceled: true };
    }

    // 🔍 Verifica se sessão estava paga (para preservar)
    const wasSessionPaid = 
        session.paymentStatus === 'paid' ||
        session.isPaid === true ||
        (session.partialAmount && session.partialAmount > 0);

    // 💾 PRESERVA DADOS FINANCEIROS (regra crítica do legado)
    if (wasSessionPaid) {
        session.originalPartialAmount = session.partialAmount;
        session.originalPaymentStatus = session.paymentStatus;
        session.originalPaymentMethod = session.paymentMethod;
        session.originalIsPaid = session.isPaid;
        
        console.log(`[cancelSession] Preservando dados financeiros:`, {
            sessionId: session._id,
            originalPartialAmount: session.originalPartialAmount,
            originalPaymentStatus: session.originalPaymentStatus
        });
    }

    // ❌ CANCELA SESSÃO
    session.status = 'canceled';
    session.paymentStatus = 'canceled';
    session.visualFlag = 'blocked';
    session.confirmedAbsence = confirmedAbsence;
    session.canceledAt = new Date();
    session.updatedAt = new Date();

    // 📝 Histórico
    if (!session.history) session.history = [];
    session.history.push({
        action: 'cancelamento',
        changedBy: userId,
        timestamp: new Date(),
        details: {
            reason,
            confirmedAbsence,
            hadPayment: wasSessionPaid,
            preservedData: wasSessionPaid
        }
    });

    await session.save({ validateBeforeSave: false });

    console.log(`[cancelSession] Sessão ${session._id} cancelada`, {
        wasPaid: wasSessionPaid,
        preserved: wasSessionPaid
    });

    return {
        session,
        wasSessionPaid,
        preserved: wasSessionPaid,
        alreadyCanceled: false
    };
}

/**
 * Busca sessão cancelada com crédito reaproveitável
 * 
 * Regras do legado (appointment.js:289-300):
 * - Busca por packageId
 * - Status 'canceled'
 * - Tem originalPaymentStatus OU originalIsPaid OU originalPartialAmount > 0
 * - Ordena por canceledAt DESC (mais recente primeiro)
 * 
 * @param {ObjectId} packageId - ID do pacote
 * @returns {Object|null} Sessão encontrada ou null
 */
export async function findReusableCanceledSession(packageId) {
    const session = await Session.findOne({
        package: packageId,
        status: 'canceled',
        $or: [
            { originalPaymentStatus: { $exists: true } },
            { originalIsPaid: true },
            { originalPartialAmount: { $exists: true, $gt: 0 } }
        ]
    })
    .sort({ canceledAt: -1 }) // Mais recente primeiro
    .lean();

    return session;
}

/**
 * Consome crédito de sessão cancelada
 * 
 * Regras do legado (appointment.js:308-328):
 * - Pega os dados originais
 * - Zera os campos 'original*' (evita reuso duplo)
 * - Retorna dados para nova sessão
 * 
 * @param {Object} canceledSession - Sessão cancelada com crédito
 * @returns {Object} Dados do crédito reaproveitado
 */
export async function consumeCanceledSessionCredit(canceledSession) {
    // Extrai crédito
    const credit = {
        isPaid: true,
        paymentStatus: 'paid',
        visualFlag: 'ok',
        partialAmount: Number(canceledSession.originalPartialAmount) || 0,
        paymentMethod: canceledSession.originalPaymentMethod || 'dinheiro',
        originalSessionId: canceledSession._id
    };

    // 🔒 ZERA para evitar reaproveitamento duplo (CRÍTICO!)
    await Session.findByIdAndUpdate(canceledSession._id, {
        originalPartialAmount: 0,
        originalPaymentStatus: null,
        originalIsPaid: false,
        originalPaymentMethod: null
    });

    console.log(`[consumeCanceledSessionCredit] Crédito consumido:`, {
        sessionId: canceledSession._id,
        partialAmount: credit.partialAmount,
        paymentMethod: credit.paymentMethod
    });

    return credit;
}
