// insurance/events/insuranceEvents.js
/**
 * Eventos do domínio Insurance/Convênio
 * 
 * Define todos os eventos relacionados a faturamento de convênios.
 */

// ============================================
// EVENT TYPES
// ============================================

export const InsuranceEventTypes = {
    // Criação
    INSURANCE_BATCH_CREATED: 'INSURANCE_BATCH_CREATED',
    INSURANCE_ITEM_ADDED: 'INSURANCE_ITEM_ADDED',
    INSURANCE_BATCH_SEALED: 'INSURANCE_BATCH_SEALED', // Lote fechado para envio
    
    // Processamento
    INSURANCE_BATCH_PROCESSING: 'INSURANCE_BATCH_PROCESSING',
    INSURANCE_BATCH_SENT: 'INSURANCE_BATCH_SENT',
    INSURANCE_BATCH_ACKNOWLEDGED: 'INSURANCE_BATCH_ACKNOWLEDGED',
    
    // Item-level
    INSURANCE_ITEM_SENT: 'INSURANCE_ITEM_SENT',
    INSURANCE_ITEM_APPROVED: 'INSURANCE_ITEM_APPROVED',
    INSURANCE_ITEM_REJECTED: 'INSURANCE_ITEM_REJECTED',
    INSURANCE_ITEM_PARTIAL: 'INSURANCE_ITEM_PARTIAL',
    
    // Glosa
    INSURANCE_GLOSA_RECEIVED: 'INSURANCE_GLOSA_RECEIVED',
    INSURANCE_ITEM_RETRYING: 'INSURANCE_ITEM_RETRYING',
    INSURANCE_ITEM_CORRECTED: 'INSURANCE_ITEM_CORRECTED',
    
    // Pagamento
    INSURANCE_PAYMENT_RECEIVED: 'INSURANCE_PAYMENT_RECEIVED',
    INSURANCE_PAYMENT_PARTIAL: 'INSURANCE_PAYMENT_PARTIAL',
    
    // Finalização
    INSURANCE_BATCH_COMPLETED: 'INSURANCE_BATCH_COMPLETED',
    INSURANCE_BATCH_PARTIAL_SUCCESS: 'INSURANCE_BATCH_PARTIAL_SUCCESS',
    INSURANCE_BATCH_FAILED: 'INSURANCE_BATCH_FAILED',
    INSURANCE_BATCH_CANCELLED: 'INSURANCE_BATCH_CANCELLED',
    
    // Reprocessamento
    INSURANCE_BATCH_REPROCESS_REQUESTED: 'INSURANCE_BATCH_REPROCESS_REQUESTED',
    INSURANCE_ITEM_REPROCESS_REQUESTED: 'INSURANCE_ITEM_REPROCESS_REQUESTED',
    
    // Conciliação
    INSURANCE_RECONCILIATION_STARTED: 'INSURANCE_RECONCILIATION_STARTED',
    INSURANCE_RECONCILIATION_COMPLETED: 'INSURANCE_RECONCILIATION_COMPLETED'
};

// ============================================
// EVENT CREATORS
// ============================================

/**
 * Cria evento de batch criado
 */
export function createBatchCreatedEvent(batchData, correlationId = null) {
    const eventId = `IBC_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    return {
        eventType: InsuranceEventTypes.INSURANCE_BATCH_CREATED,
        eventId,
        correlationId: correlationId || eventId,
        timestamp: new Date(),
        aggregateType: 'insurance_batch',
        aggregateId: batchData.batchId || batchData._id?.toString(),
        payload: {
            batchId: batchData.batchId || batchData._id?.toString(),
            batchNumber: batchData.batchNumber,
            insuranceProvider: batchData.insuranceProvider,
            startDate: batchData.startDate,
            endDate: batchData.endDate,
            totalItems: batchData.totalItems || 0,
            totalGross: batchData.totalGross || 0,
            createdBy: batchData.createdBy,
            metadata: batchData.metadata
        }
    };
}

/**
 * Cria evento de item adicionado
 */
export function createItemAddedEvent(batchId, itemData, correlationId) {
    return {
        eventType: InsuranceEventTypes.INSURANCE_ITEM_ADDED,
        eventId: `IIA_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        correlationId,
        timestamp: new Date(),
        aggregateType: 'insurance_batch',
        aggregateId: batchId,
        payload: {
            batchId,
            itemId: itemData._id?.toString(),
            sessionId: itemData.sessionId,
            appointmentId: itemData.appointmentId,
            patientId: itemData.patientId,
            procedureCode: itemData.procedureCode,
            grossAmount: itemData.grossAmount,
            sessionDate: itemData.sessionDate
        }
    };
}

/**
 * Cria evento de batch enviado
 */
export function createBatchSentEvent(batchId, sentData, correlationId) {
    return {
        eventType: InsuranceEventTypes.INSURANCE_BATCH_SENT,
        eventId: `IBS_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        correlationId,
        timestamp: new Date(),
        aggregateType: 'insurance_batch',
        aggregateId: batchId,
        payload: {
            batchId,
            sentAt: sentData.sentAt || new Date(),
            sentBy: sentData.sentBy,
            protocol: sentData.protocol,
            xmlFilePath: sentData.xmlFilePath,
            totalItems: sentData.totalItems
        }
    };
}

/**
 * Cria evento de item aprovado
 */
export function createItemApprovedEvent(batchId, itemId, approvalData, correlationId) {
    return {
        eventType: InsuranceEventTypes.INSURANCE_ITEM_APPROVED,
        eventId: `IIAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        correlationId,
        timestamp: new Date(),
        aggregateType: 'insurance_batch',
        aggregateId: batchId,
        payload: {
            batchId,
            itemId,
            netAmount: approvalData.netAmount,
            approvedAt: approvalData.approvedAt || new Date(),
            returnCode: approvalData.returnCode,
            returnMessage: approvalData.returnMessage
        }
    };
}

/**
 * Cria evento de item rejeitado (glosa)
 */
export function createItemRejectedEvent(batchId, itemId, rejectionData, correlationId) {
    return {
        eventType: InsuranceEventTypes.INSURANCE_ITEM_REJECTED,
        eventId: `IIR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        correlationId,
        timestamp: new Date(),
        aggregateType: 'insurance_batch',
        aggregateId: batchId,
        payload: {
            batchId,
            itemId,
            glosaAmount: rejectionData.glosaAmount,
            glosa: {
                code: rejectionData.glosa?.code,
                reason: rejectionData.glosa?.reason,
                detail: rejectionData.glosa?.detail,
                isRecoverable: rejectionData.glosa?.isRecoverable,
                suggestedAction: rejectionData.glosa?.suggestedAction
            },
            rejectedAt: rejectionData.rejectedAt || new Date(),
            returnCode: rejectionData.returnCode,
            returnMessage: rejectionData.returnMessage
        }
    };
}

/**
 * Cria evento de pagamento recebido
 */
export function createPaymentReceivedEvent(batchId, paymentData, correlationId) {
    return {
        eventType: InsuranceEventTypes.INSURANCE_PAYMENT_RECEIVED,
        eventId: `IPR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        correlationId,
        timestamp: new Date(),
        aggregateType: 'insurance_batch',
        aggregateId: batchId,
        payload: {
            batchId,
            receivedAmount: paymentData.receivedAmount,
            expectedAmount: paymentData.expectedAmount,
            paymentDate: paymentData.paymentDate,
            bankReference: paymentData.bankReference,
            receivedAt: paymentData.receivedAt || new Date()
        }
    };
}

/**
 * Cria evento de batch finalizado
 */
export function createBatchCompletedEvent(batchId, completionData, correlationId) {
    return {
        eventType: InsuranceEventTypes.INSURANCE_BATCH_COMPLETED,
        eventId: `IBCO_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        correlationId,
        timestamp: new Date(),
        aggregateType: 'insurance_batch',
        aggregateId: batchId,
        payload: {
            batchId,
            status: completionData.status, // completed, partial_success, failed
            totalItems: completionData.totalItems,
            approvedCount: completionData.approvedCount,
            rejectedCount: completionData.rejectedCount,
            totalGross: completionData.totalGross,
            totalNet: completionData.totalNet,
            totalGlosa: completionData.totalGlosa,
            completedAt: completionData.completedAt || new Date(),
            approvalRate: completionData.approvalRate,
            glosaRate: completionData.glosaRate
        }
    };
}

/**
 * Cria evento de reprocessamento solicitado
 */
export function createReprocessRequestedEvent(batchId, reprocessData, correlationId) {
    return {
        eventType: InsuranceEventTypes.INSURANCE_BATCH_REPROCESS_REQUESTED,
        eventId: `IBR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        correlationId,
        timestamp: new Date(),
        aggregateType: 'insurance_batch',
        aggregateId: batchId,
        payload: {
            batchId,
            itemIds: reprocessData.itemIds, // Se null, reprocessa todo o batch
            reason: reprocessData.reason,
            requestedBy: reprocessData.requestedBy,
            corrections: reprocessData.corrections // Correções a aplicar
        }
    };
}

// ============================================
// EVENT HANDLER MAP
// ============================================

/**
 * Mapeia eventos para handlers (para uso no orchestrator)
 */
export const insuranceEventHandlers = {
    [InsuranceEventTypes.INSURANCE_BATCH_CREATED]: 'handleBatchCreated',
    [InsuranceEventTypes.INSURANCE_BATCH_SENT]: 'handleBatchSent',
    [InsuranceEventTypes.INSURANCE_ITEM_APPROVED]: 'handleItemApproved',
    [InsuranceEventTypes.INSURANCE_ITEM_REJECTED]: 'handleItemRejected',
    [InsuranceEventTypes.INSURANCE_PAYMENT_RECEIVED]: 'handlePaymentReceived',
    [InsuranceEventTypes.INSURANCE_BATCH_REPROCESS_REQUESTED]: 'handleReprocessRequested'
};

// ============================================
// QUEUE MAPPING
// ============================================

/**
 * Mapeia eventos para filas BullMQ
 */
export const insuranceEventToQueueMap = {
    [InsuranceEventTypes.INSURANCE_BATCH_CREATED]: 'insurance-orchestrator',
    [InsuranceEventTypes.INSURANCE_BATCH_SEALED]: 'insurance-processing',
    [InsuranceEventTypes.INSURANCE_BATCH_SENT]: 'insurance-awaiting-response',
    [InsuranceEventTypes.INSURANCE_BATCH_ACKNOWLEDGED]: 'insurance-processing',
    [InsuranceEventTypes.INSURANCE_ITEM_APPROVED]: 'insurance-completed',
    [InsuranceEventTypes.INSURANCE_ITEM_REJECTED]: 'insurance-glosa-handling',
    [InsuranceEventTypes.INSURANCE_PAYMENT_RECEIVED]: 'insurance-reconciliation',
    [InsuranceEventTypes.INSURANCE_BATCH_REPROCESS_REQUESTED]: 'insurance-orchestrator'
};

export default InsuranceEventTypes;
