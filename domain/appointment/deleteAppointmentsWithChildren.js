// domain/appointment/deleteAppointmentsWithChildren.js
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';

/**
 * Deleta (hard delete) appointments que casam com o filtro, junto com Session/Payment
 * filhos vinculados a eles. Usado no fluxo de convênio, onde appointments futuros de
 * uma guia/plano cancelado são tratados como "nunca existiram" operacionalmente
 * (decisão de domínio já tomada — ver decisão de arquitetura de inativação, 2026-07-17).
 *
 * @param {Object} filter - filtro Mongo para encontrar os appointments a deletar
 * @returns {Promise<{deletedCount: number, appointmentIds: ObjectId[]}>}
 */
export async function deleteAppointmentsWithChildren(filter) {
    const appts = await Appointment.find(filter).select('_id').lean();
    const appointmentIds = appts.map(a => a._id);

    if (appointmentIds.length > 0) {
        await Session.deleteMany({ appointmentId: { $in: appointmentIds } });
        await Payment.deleteMany({ appointment: { $in: appointmentIds } });
    }

    const { deletedCount } = await Appointment.deleteMany({ _id: { $in: appointmentIds } });
    return { deletedCount, appointmentIds };
}
