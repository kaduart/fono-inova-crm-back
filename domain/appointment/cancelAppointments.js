// domain/appointment/cancelAppointments.js
import Appointment from '../../models/Appointment.js';

/**
 * Soft-cancel de appointments (marca operationalStatus='canceled', libera o slot).
 * Filtro é responsabilidade do chamador — este helper só sabe o campo/valor corretos
 * do lifecycle do Appointment (operationalStatus, não 'status' — esse campo não existe
 * no schema e era descartado silenciosamente pelo strict mode do Mongoose).
 *
 * @param {Object} filter - filtro Mongo completo (inclui _id, condição de status atual, etc)
 */
export async function cancelAppointments(filter) {
    return Appointment.updateMany(
        filter,
        { operationalStatus: 'canceled', updatedAt: new Date(), _fromWriteGateway: true }
    );
}
