// projections/paymentsProjection.js
/**
 * Handler de eventos para atualizar PaymentsView
 * Consumido pelo worker de projeções
 */

import PaymentsView from '../models/PaymentsView.js';
import Payment from '../models/Payment.js';

/**
 * Atualiza projection quando um pagamento é criado ou modificado
 */
export async function handlePaymentEvent(event) {
    const { type, payload, timestamp } = event;
    
    console.log(`[PaymentsProjection] Processando evento: ${type}`);
    
    try {
        switch (type) {
            case 'PAYMENT_CREATED':
            case 'PAYMENT_UPDATED':
            case 'PAYMENT_MARKED_AS_PAID':
                return await upsertPaymentProjection(payload.paymentId || payload._id);
                
            case 'PAYMENT_DELETED':
            case 'PAYMENT_CANCELED':
                return await softDeletePaymentProjection(payload.paymentId || payload._id);
                
            case 'APPOINTMENT_COMPLETED':
                // Se o agendamento tem pagamento, atualiza
                if (payload.paymentId) {
                    return await upsertPaymentProjection(payload.paymentId);
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
 * Busca o pagamento completo e atualiza a projection
 */
async function upsertPaymentProjection(paymentId) {
    const payment = await Payment.findById(paymentId)
        .populate('appointmentId', 'date time status')
        .populate('packageId', '_id name')
        .populate('sessionId', '_id date time')
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
export async function rebuildPaymentsProjection(clinicId = 'default') {
    console.log('[PaymentsProjection] Iniciando rebuild completo...');
    
    // Limpa projeções existentes
    await PaymentsView.deleteMany({ clinicId });
    
    // Busca todos os pagamentos ativos
    const payments = await Payment.find({
        status: { $nin: ['deleted', 'canceled'] },
        clinicId: clinicId === 'default' ? { $exists: false } : clinicId
    })
    .populate({ path: 'patient', select: 'fullName phone phoneNumber', strictPopulate: false })
    .populate({ path: 'doctor', select: 'fullName specialty', strictPopulate: false })
    .populate({ path: 'appointment', select: 'date time status', strictPopulate: false })
    .populate({ path: 'package', select: '_id name', strictPopulate: false })
    .populate({ path: 'session', select: '_id date time', strictPopulate: false })
    .lean();
    
    console.log(`[PaymentsProjection] Encontrados ${payments.length} pagamentos para reconstituir`);
    
    // Insere em batch
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
