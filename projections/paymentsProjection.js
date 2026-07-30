// projections/paymentsProjection.js
/**
 * Handler de eventos para atualizar PaymentsView
 * Consumido pelo worker de projeções
 */

import PaymentsView from '../models/PaymentsView.js';
import Payment from '../models/Payment.js';
import mongoose from 'mongoose';

/**
 * Atualiza projection quando um pagamento é criado ou modificado,
 * ou quando uma entidade relacionada (appointment/session/patient/doctor) muda.
 */
export async function handlePaymentEvent(event) {
    const { type, payload, timestamp } = event;

    console.log(`[PaymentsProjection] Processando evento: ${type}`);

    try {
        switch (type) {
            case 'PAYMENT_CREATED':
            case 'PAYMENT_UPDATED':
            case 'PAYMENT_MARKED_AS_PAID':
            case 'PAYMENT_RECEIVED':
            case 'PAYMENT_STATUS_CHANGED':
                return await upsertPaymentProjection(payload.paymentId || payload._id);

            case 'PAYMENT_DELETED':
            case 'PAYMENT_CANCELED':
            case 'PAYMENT_CANCELLED':
                return await softDeletePaymentProjection(payload.paymentId || payload._id);

            case 'APPOINTMENT_UPDATED':
            case 'APPOINTMENT_RESCHEDULED':
            case 'APPOINTMENT_CANCELLED':
            case 'APPOINTMENT_RESTORED':
            case 'APPOINTMENT_COMPLETED':
                // Reprocessa todos os payments vinculados ao appointment
                if (payload.appointmentId) {
                    return await syncPaymentsByAppointment(payload.appointmentId);
                }
                break;

            case 'SESSION_COMPLETED':
            case 'SESSION_CANCELLED':
            case 'SESSION_CANCELED':
            case 'SESSION_UPDATED':
                if (payload.sessionId || payload.appointmentId) {
                    return await syncPaymentsBySessionOrAppointment(payload.sessionId, payload.appointmentId);
                }
                break;

            default:
                return { processed: false, reason: 'Evento não relevante' };
        }

        return { processed: true, timestamp };
    } catch (error) {
        console.error('[PaymentsProjection] Erro ao processar evento:', error);
        throw error;
    }
}

/**
 * Sincroniza a projection de um Payment específico.
 * Busca o payment mais atual do banco, popula relacionados e faz upsert na view.
 */
async function upsertPaymentProjection(paymentId) {
    if (!paymentId) {
        console.warn('[PaymentsProjection] upsert chamado sem paymentId');
        return { processed: false, reason: 'missing_payment_id' };
    }

    const payment = await Payment.findById(paymentId)
        .populate({ path: 'patient', select: 'fullName phone phoneNumber', strictPopulate: false })
        .populate({ path: 'doctor', select: 'fullName specialty', strictPopulate: false })
        .populate({ path: 'appointment', select: 'date time status serviceType sessionType specialty', strictPopulate: false })
        .populate({ path: 'package', select: '_id name', strictPopulate: false })
        .populate({ path: 'session', select: '_id date time status serviceType sessionType specialty', strictPopulate: false })
        .lean();

    if (!payment) {
        console.log(`[PaymentsProjection] Pagamento não encontrado: ${paymentId}`);
        return { processed: false, reason: 'Payment not found' };
    }

    const result = await PaymentsView.upsertFromPayment(payment);

    console.log(`[PaymentsProjection] Payment ${paymentId} atualizado na view`);

    return {
        processed: true,
        action: 'upsert',
        viewId: result._id
    };
}

/**
 * Reprocessa todos os Payments vinculados a um Appointment.
 * Usado quando o Appointment é editado/cancelado/reativado.
 */
async function syncPaymentsByAppointment(appointmentId) {
    if (!appointmentId) return { processed: false, reason: 'missing_appointment_id' };

    const payments = await Payment.find({
        $or: [
            { appointment: appointmentId },
            { appointmentId: appointmentId }
        ]
    }).select('_id').lean();

    const results = [];
    for (const p of payments) {
        results.push(await upsertPaymentProjection(p._id));
    }

    return {
        processed: true,
        action: 'sync_by_appointment',
        appointmentId,
        paymentsSynced: results.length
    };
}

/**
 * Reprocessa Payments vinculados a uma Session ou Appointment.
 */
async function syncPaymentsBySessionOrAppointment(sessionId, appointmentId) {
    const orFilter = [];
    if (sessionId) orFilter.push({ session: sessionId });
    if (appointmentId) {
        orFilter.push({ appointment: appointmentId });
        orFilter.push({ appointmentId: appointmentId });
    }

    if (orFilter.length === 0) return { processed: false, reason: 'missing_session_or_appointment' };

    const payments = await Payment.find({ $or: orFilter }).select('_id').lean();

    const results = [];
    for (const p of payments) {
        results.push(await upsertPaymentProjection(p._id));
    }

    return {
        processed: true,
        action: 'sync_by_session_or_appointment',
        sessionId,
        appointmentId,
        paymentsSynced: results.length
    };
}

/**
 * Soft delete na projection
 */
async function softDeletePaymentProjection(paymentId) {
    const result = await PaymentsView.findOneAndUpdate(
        { paymentId },
        {
            $set: {
                isDeleted: true,
                status: 'canceled',
                updatedAt: new Date()
            }
        },
        { new: true }
    );

    if (result) {
        console.log(`[PaymentsProjection] Payment ${paymentId} marcado como deletado`);
    }

    return {
        processed: !!result,
        action: 'softDelete'
    };
}

/**
 * Reconstroi a projection completa (para migration ou recovery)
 */
export async function rebuildPaymentsProjection(clinicId = 'all') {
    console.log('[PaymentsProjection] Iniciando rebuild completo...');

    const query = {
        status: { $nin: ['deleted'] },
    };
    if (clinicId === 'default') {
        query.clinicId = { $exists: false };
    } else if (clinicId && clinicId !== 'all') {
        query.clinicId = clinicId;
    }

    const payments = await Payment.find(query)
        .populate({ path: 'patient', select: 'fullName phone phoneNumber', strictPopulate: false })
        .populate({ path: 'doctor', select: 'fullName specialty', strictPopulate: false })
        .populate({ path: 'appointment', select: 'date time status serviceType sessionType specialty', strictPopulate: false })
        .populate({ path: 'package', select: '_id name', strictPopulate: false })
        .populate({ path: 'session', select: '_id date time status serviceType sessionType specialty', strictPopulate: false })
        .lean();

    console.log(`[PaymentsProjection] Encontrados ${payments.length} pagamentos para reconstituir`);

    const batchSize = 100;
    let processed = 0;

    for (let i = 0; i < payments.length; i += batchSize) {
        const batch = payments.slice(i, i + batchSize);

        const docs = await Promise.all(
            batch.map(p => PaymentsView.upsertFromPayment(p))
        );

        processed += docs.length;

        if (processed % 500 === 0) {
            console.log(`[PaymentsProjection] ${processed}/${payments.length} processados...`);
        }
    }

    console.log(`[PaymentsProjection] Rebuild completo: ${processed} pagamentos`);

    return { processed, total: payments.length };
}

export default {
    handlePaymentEvent,
    rebuildPaymentsProjection
};
