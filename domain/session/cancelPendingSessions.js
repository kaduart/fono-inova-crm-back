// domain/session/cancelPendingSessions.js
import Session from '../../models/Session.js';

/**
 * Cancela sessions pendentes que casam com o filtro (marca status='canceled').
 * Filtro é responsabilidade do chamador.
 *
 * @param {Object} filter - filtro Mongo completo
 */
export async function cancelPendingSessions(filter) {
    return Session.updateMany(
        filter,
        { status: 'canceled', updatedAt: new Date(), _fromWriteGateway: true }
    );
}
