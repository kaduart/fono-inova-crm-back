// domain/session/completeSession.js
import Session from '../../models/Session.js';

/**
 * Completa uma sessão
 * 
 * Regras do legado (appointment.js:1777-1810):
 * - Status: 'completed'
 * - isPaid: depende do cenário
 * - paymentStatus: paid | pending | pending_receipt
 * - visualFlag: ok | pending
 * - paymentOrigin: rastreabilidade
 * - Calcula comissão se houver
 * 
 * @param {ObjectId} sessionId - ID da sessão
 * @param {Object} options - Opções
 * @param {Boolean} options.addToBalance - Se é fiado
 * @param {String} options.paymentOrigin - Origem do pagamento
 * @param {String} options.correlationId - ID de correlação
 * @returns {Object} Resultado
 */
export async function completeSession(sessionId, options = {}) {
    const { 
        addToBalance = false, 
        paymentOrigin = null,  // Deixa null para evitar erro de enum
        correlationId = null 
    } = options;

    const session = await Session.findById(sessionId);
    
    if (!session) {
        throw new Error('SESSION_NOT_FOUND');
    }

    // 🛡️ IDEMPOTÊNCIA
    if (session.status === 'completed') {
        console.log(`[completeSession] Sessão ${sessionId} já completada`);
        return { session, alreadyCompleted: true };
    }

    // Determina atualizações baseado no cenário
    const updates = buildCompleteUpdate({
        addToBalance,
        paymentOrigin,
        correlationId,
        session
    });

    // Aplica atualizações
    Object.assign(session, updates);
    
    // Calcula comissão se aplicável
    if (session.commissionRate && session.sessionValue && !addToBalance) {
        session.commissionValue = session.sessionValue * session.commissionRate;
    }

    // Marca como consumida (para pacotes)
    session.sessionConsumed = true;

    // Data de reconhecimento de receita
    if (!session.revenueRecognizedAt) {
        session.revenueRecognizedAt = new Date();
    }

    await session.save();

    console.log(`[completeSession] Sessão ${sessionId} completada`, {
        paymentOrigin,
        isPaid: session.isPaid,
        addToBalance
    });

    return { session, alreadyCompleted: false };
}

function buildCompleteUpdate({ addToBalance, paymentOrigin, correlationId, session }) {
    const base = {
        status: 'completed',
        updatedAt: new Date(),
        paymentOrigin,
        correlationId
    };

    // FIADO (addToBalance)
    if (addToBalance) {
        return {
            ...base,
            isPaid: false,
            paymentStatus: 'pending',
            visualFlag: 'pending',
            addedToBalance: true
        };
    }

    // CONVÊNIO
    if (paymentOrigin === 'convenio') {
        return {
            ...base,
            isPaid: false,
            paymentStatus: 'pending_receipt',
            visualFlag: 'pending'
        };
    }

    // PACOTE PRÉ-PAGO, PER-SESSION, PARTICULAR, LIMINAR
    return {
        ...base,
        isPaid: true,
        paymentStatus: 'paid',
        visualFlag: 'ok',
        paidAt: new Date()
    };
}
