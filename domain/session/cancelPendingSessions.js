// domain/session/cancelPendingSessions.js
import Session from '../../models/Session.js';

/**
 * Cancela sessions pendentes que casam com o filtro (marca status='canceled').
 * Filtro é responsabilidade do chamador.
 *
 * @param {Object} filter - filtro Mongo completo
 * @param {mongoose.ClientSession} [mongoSession] - sessão Mongo ativa, para rodar dentro de uma transação
 */
export async function cancelPendingSessions(filter, mongoSession = null) {
    return Session.updateMany(
        filter,
        { status: 'canceled', updatedAt: new Date(), _fromWriteGateway: true },
        mongoSession ? { session: mongoSession } : undefined
    );
}
