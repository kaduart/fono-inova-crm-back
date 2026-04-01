// insurance/workers/insuranceOrchestratorWorker.js
/**
 * Insurance Orchestrator Worker
 * 
 * Orquestra todo o fluxo de faturamento de convênios.
 * Recebe eventos, gerencia o lifecycle dos lotes e itens.
 * 
 * Lifecycle: PENDING → PROCESSING → SENT → PARTIAL_SUCCESS → COMPLETED
 */

import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../../../infrastructure/queue/queueConfig.js';
import { 
    eventExists, 
    processWithGuarantees, 
    appendEvent 
} from '../../../infrastructure/events/eventStoreService.js';
import EventStore from '../../../models/EventStore.js';
import { createContextLogger } from '../../../utils/logger.js';
import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';
import { saveToOutbox } from '../../../infrastructure/outbox/outboxPattern.js';
import mongoose from 'mongoose';

import InsuranceBatch from '../../../models/InsuranceBatch.js';
import InsuranceBatchView from '../../../models/InsuranceBatchView.js';
import { InsuranceEventTypes } from '../events/insuranceEvents.js';
import { processInsuranceBatch, sendBatchToProvider } from '../domain/insuranceDomain.js';

// ============================================
// VIEW PROJECTION HELPERS
// ============================================

/**
 * Atualiza a view de InsuranceBatch após mudanças no write model
 * Chamado após cada operação bem-sucedida
 */
async function updateInsuranceBatchView(batchId, correlationId, log) {
    try {
        const batch = await InsuranceBatch.findById(batchId)
            .populate('sessions.session', 'date status')
            .populate('sessions.appointment', 'date status')
            .lean();
        
        if (!batch) {
            log.warn('view_update', 'Batch not found for view update', { batchId });
            return null;
        }
        
        // Mapeia sessões para formato da view
        const sessionsView = batch.sessions?.map(s => ({
            sessionId: s.session?._id?.toString() || s.session?.toString(),
            appointmentId: s.appointment?._id?.toString() || s.appointment?.toString(),
            guideId: s.guide?.toString(),
            grossAmount: s.grossAmount || 0,
            netAmount: s.netAmount,
            returnAmount: s.returnAmount,
            glosaAmount: s.glosaAmount,
            status: s.status,
            glosaReason: s.glosaReason,
            protocolNumber: s.protocolNumber,
            sentAt: s.sentAt,
            processedAt: s.processedAt
        })) || [];
        
        // Dados da view
        const viewData = {
            batchId: batch._id.toString(),
            batchNumber: batch.batchNumber,
            insuranceProvider: batch.insuranceProvider,
            startDate: batch.startDate,
            endDate: batch.endDate,
            sentDate: batch.sentDate,
            sessions: sessionsView,
            totalSessions: batch.totalSessions || sessionsView.length,
            totalGross: batch.totalGross || 0,
            totalNet: batch.totalNet || 0,
            receivedAmount: batch.receivedAmount || 0,
            totalGlosa: batch.totalGlosa || 0,
            status: batch.status,
            xmlFile: batch.xmlFile,
            returnFile: batch.returnFile,
            processedAt: batch.processedAt,
            processedBy: batch.processedBy?.toString(),
            notes: batch.notes,
            correlationId: batch.correlationId,
            createdAt: batch.createdAt,
            updatedAt: batch.updatedAt,
            snapshot: {
                version: (batch.snapshot?.version || 0) + 1,
                lastRebuildAt: new Date()
            }
        };
        
        // Upsert na view
        const view = await InsuranceBatchView.findOneAndUpdate(
            { batchId: viewData.batchId },
            viewData,
            { upsert: true, new: true }
        );
        
        log.info('view_updated', 'InsuranceBatchView atualizada', { 
            batchId,
            viewVersion: view.snapshot?.version 
        });
        
        return view;
        
    } catch (error) {
        log.error('view_update_error', 'Erro ao atualizar view', { 
            batchId, 
            error: error.message 
        });
        // Não throw - view é eventual consistency
        return null;
    }
}

/**
 * Inicia o worker de orquestração de convênios
 */
export function startInsuranceOrchestratorWorker() {
    console.log('[InsuranceOrchestrator] 🏥 Worker iniciado');

    const worker = new Worker('insurance-orchestrator', async (job) => {
        const { eventType, eventId, correlationId, idempotencyKey, payload } = job.data;
        
        const log = createContextLogger(correlationId || eventId, 'insurance');
        
        log.info('start', 'Processando evento de insurance', {
            eventType,
            eventId,
            batchId: payload?.batchId
        });

        try {
            // 🛡️ IDEMPOTÊNCIA VIA EVENT STORE
            const existingEvent = await EventStore.findOne({ eventId });
            if (existingEvent?.status === 'processed') {
                log.info('idempotent', 'Evento já processado', { eventId });
                return { status: 'already_processed', idempotent: true };
            }

            // 🛡️ IDEMPOTÊNCIA GLOBAL
            if (idempotencyKey && await eventExists(idempotencyKey)) {
                const existingByKey = await EventStore.findOne({ idempotencyKey });
                if (existingByKey?.status === 'processed') {
                    log.info('idempotent', 'IdempotencyKey já processada', { idempotencyKey });
                    return { status: 'already_processed', idempotent: true };
                }
            }

            // Registra evento no Event Store
            const storedEvent = await appendEvent({
                eventId,
                eventType,
                aggregateType: 'insurance_batch',
                aggregateId: payload?.batchId || 'unknown',
                payload,
                metadata: { correlationId, idempotencyKey, source: 'insuranceOrchestratorWorker' },
                idempotencyKey: idempotencyKey || `${eventType}_${payload?.batchId}_${Date.now()}`
            });

            // Processa com garantias
            return await processWithGuarantees(storedEvent.eventId, async () => {
                return await handleInsuranceEvent(eventType, payload, { correlationId, log });
            });

        } catch (error) {
            log.error('error', 'Erro no processamento', { 
                error: error.message,
                eventType,
                batchId: payload?.batchId
            });
            
            if (job.attemptsMade >= 4) {
                await moveToDLQ(job, error);
            }
            
            throw error;
        }

    }, {
        connection: redisConnection,
        concurrency: 3,
        limiter: {
            max: 10,
            duration: 1000
        }
    });

    worker.on('completed', (job, result) => {
        console.log(`[InsuranceOrchestrator] Job ${job.id}: ${result?.status || 'completed'}`);
    });

    worker.on('failed', (job, error) => {
        console.error(`[InsuranceOrchestrator] Job ${job?.id} falhou:`, error.message);
    });

    console.log('[InsuranceOrchestrator] Worker registrado');
    return worker;
}

/**
 * Dispatcher de eventos - roteia para handler correto
 */
async function handleInsuranceEvent(eventType, payload, { correlationId, log }) {
    switch (eventType) {
        case InsuranceEventTypes.INSURANCE_BATCH_CREATED:
            return await handleBatchCreated(payload, correlationId, log);
            
        case InsuranceEventTypes.INSURANCE_BATCH_SEALED:
            return await handleBatchSealed(payload, correlationId, log);
            
        case InsuranceEventTypes.INSURANCE_BATCH_SENT:
            return await handleBatchSent(payload, correlationId, log);
            
        case InsuranceEventTypes.INSURANCE_ITEM_APPROVED:
            return await handleItemApproved(payload, correlationId, log);
            
        case InsuranceEventTypes.INSURANCE_ITEM_REJECTED:
            return await handleItemRejected(payload, correlationId, log);
            
        case InsuranceEventTypes.INSURANCE_PAYMENT_RECEIVED:
            return await handlePaymentReceived(payload, correlationId, log);
            
        case InsuranceEventTypes.INSURANCE_BATCH_REPROCESS_REQUESTED:
            return await handleReprocessRequested(payload, correlationId, log);
            
        default:
            log.warn('unknown_event', 'Tipo de evento não reconhecido', { eventType });
            return { status: 'ignored', reason: 'unknown_event_type' };
    }
}

/**
 * Handler: INSURANCE_BATCH_CREATED
 * Lote criado - prepara para processamento
 */
async function handleBatchCreated(payload, correlationId, log) {
    const { batchId } = payload;
    
    log.info('batch_created', 'Lote criado, preparando processamento', { batchId });
    
    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();
        
        // Busca o lote
        const batch = await InsuranceBatch.findById(batchId).session(mongoSession);
        
        if (!batch) {
            throw new Error(`BATCH_NOT_FOUND: ${batchId}`);
        }
        
        if (batch.status !== 'pending') {
            log.warn('invalid_status', 'Lote não está em status pending', { 
                batchId, 
                currentStatus: batch.status 
            });
            await mongoSession.abortTransaction();
            return { status: 'ignored', reason: 'invalid_status' };
        }
        
        // Atualiza status
        batch.status = 'processing';
        await batch.save({ session: mongoSession });
        
        // Publica evento de processamento iniciado
        await saveToOutbox({
            eventId: `IBP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            correlationId,
            eventType: InsuranceEventTypes.INSURANCE_BATCH_PROCESSING,
            payload: {
                batchId: batchId.toString(),
                batchNumber: batch.batchNumber,
                totalItems: batch.totalItems,
                totalGross: batch.totalGross
            },
            aggregateType: 'insurance_batch',
            aggregateId: batchId.toString()
        }, mongoSession);
        
        await mongoSession.commitTransaction();
        
        // Atualiza view (eventual consistency)
        await updateInsuranceBatchView(batchId, correlationId, log);
        
        log.info('batch_processing', 'Lote em processamento', { 
            batchId, 
            batchNumber: batch.batchNumber 
        });
        
        return { 
            status: 'processing_started', 
            batchId,
            batchNumber: batch.batchNumber 
        };
        
    } catch (error) {
        await mongoSession.abortTransaction();
        throw error;
    } finally {
        mongoSession.endSession();
    }
}

/**
 * Handler: INSURANCE_BATCH_SEALED
 * Lote fechado - enviar para operadora
 */
async function handleBatchSealed(payload, correlationId, log) {
    const { batchId, xmlContent } = payload;
    
    log.info('batch_sealed', 'Lote fechado, enviando para operadora', { batchId });
    
    const batch = await InsuranceBatch.findById(batchId);
    
    if (!batch) {
        throw new Error(`BATCH_NOT_FOUND: ${batchId}`);
    }
    
    // Envia para operadora (domain logic)
    const sendResult = await sendBatchToProvider(batch, xmlContent, { correlationId, log });
    
    if (!sendResult.success) {
        throw new Error(`SEND_FAILED: ${sendResult.error}`);
    }
    
    // Atualiza lote
    batch.markAsSent(payload.sentBy, sendResult.protocol);
    batch.xmlContent = xmlContent;
    await batch.save();
    
    // Publica evento de envio
    await publishEvent(
        InsuranceEventTypes.INSURANCE_BATCH_SENT,
        {
            batchId: batchId.toString(),
            batchNumber: batch.batchNumber,
            sentAt: batch.sentAt,
            protocol: sendResult.protocol,
            totalItems: batch.totalItems
        },
        { correlationId }
    );
    
    // Atualiza view
    await updateInsuranceBatchView(batchId, correlationId, log);
    
    log.info('batch_sent', 'Lote enviado para operadora', { 
        batchId, 
        protocol: sendResult.protocol 
    });
    
    return { 
        status: 'sent', 
        batchId,
        protocol: sendResult.protocol 
    };
}

/**
 * Handler: INSURANCE_BATCH_SENT
 * Lote enviado - aguardar processamento da operadora
 */
async function handleBatchSent(payload, correlationId, log) {
    const { batchId, protocol } = payload;
    
    log.info('batch_sent_handler', 'Lote enviado, monitorando', { batchId, protocol });
    
    // Aqui poderia iniciar um job de polling para verificar retorno
    // Por enquanto, apenas loga e aguarda webhook/evento externo
    
    return { 
        status: 'awaiting_response', 
        batchId,
        protocol,
        message: 'Aguardando processamento da operadora'
    };
}

/**
 * Handler: INSURANCE_ITEM_APPROVED
 * Item aprovado - atualizar batch
 */
async function handleItemApproved(payload, correlationId, log) {
    const { batchId, itemId, netAmount, returnCode } = payload;
    
    log.info('item_approved', 'Item aprovado pela operadora', { 
        batchId, 
        itemId,
        netAmount 
    });
    
    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();
        
        const batch = await InsuranceBatch.findById(batchId).session(mongoSession);
        
        if (!batch) {
            throw new Error(`BATCH_NOT_FOUND: ${batchId}`);
        }
        
        // Atualiza item
        batch.updateItemStatus(itemId, 'approved', {
            netAmount,
            returnCode,
            processedAt: new Date()
        });
        
        // Verifica se batch está completo
        const newBatchStatus = batch.calculateBatchStatus();
        
        if (newBatchStatus !== batch.status && ['completed', 'partial_success'].includes(newBatchStatus)) {
            batch.status = newBatchStatus;
            batch.processedAt = new Date();
            
            // Publica evento de finalização
            const completionEventType = newBatchStatus === 'completed' 
                ? InsuranceEventTypes.INSURANCE_BATCH_COMPLETED
                : InsuranceEventTypes.INSURANCE_BATCH_PARTIAL_SUCCESS;
            
            await saveToOutbox({
                eventId: `IBC_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                correlationId,
                eventType: completionEventType,
                payload: {
                    batchId: batchId.toString(),
                    status: newBatchStatus,
                    totalItems: batch.totalItems,
                    approvedCount: batch.approvedCount,
                    rejectedCount: batch.rejectedCount,
                    totalNet: batch.totalNet,
                    totalGlosa: batch.totalGlosa,
                    approvalRate: batch.approvalRate,
                    glosaRate: batch.glosaRate
                },
                aggregateType: 'insurance_batch',
                aggregateId: batchId.toString()
            }, mongoSession);
        }
        
        await batch.save({ session: mongoSession });
        await mongoSession.commitTransaction();
        
        // Atualiza view
        await updateInsuranceBatchView(batchId, correlationId, log);
        
        log.info('item_approved_processed', 'Item aprovado processado', {
            batchId,
            itemId,
            batchStatus: batch.status
        });
        
        return { 
            status: 'approved_processed', 
            batchId,
            itemId,
            batchStatus: batch.status
        };
        
    } catch (error) {
        await mongoSession.abortTransaction();
        throw error;
    } finally {
        mongoSession.endSession();
    }
}

/**
 * Handler: INSURANCE_ITEM_REJECTED
 * Item rejeitado - processar glosa
 */
async function handleItemRejected(payload, correlationId, log) {
    const { batchId, itemId, glosa, glosaAmount } = payload;
    
    log.info('item_rejected', 'Item rejeitado - glosa', { 
        batchId, 
        itemId,
        glosaCode: glosa?.code,
        glosaAmount 
    });
    
    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();
        
        const batch = await InsuranceBatch.findById(batchId).session(mongoSession);
        
        if (!batch) {
            throw new Error(`BATCH_NOT_FOUND: ${batchId}`);
        }
        
        // Determina se glosa é recuperável
        const isRecoverable = isGlosaRecoverable(glosa?.code);
        const suggestedAction = suggestGlosaAction(glosa?.code);
        
        // Atualiza item
        batch.updateItemStatus(itemId, 'rejected', {
            glosaAmount,
            glosa: {
                ...glosa,
                isRecoverable,
                suggestedAction
            },
            processedAt: new Date()
        });
        
        await batch.save({ session: mongoSession });
        
        // Se for recuperável, agenda retry automático
        if (isRecoverable && suggestedAction === 'retry') {
            await saveToOutbox({
                eventId: `IIR_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                correlationId,
                eventType: InsuranceEventTypes.INSURANCE_ITEM_RETRYING,
                payload: {
                    batchId: batchId.toString(),
                    itemId,
                    reason: 'automatic_retry_after_glosa',
                    retryAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // Retry em 24h
                },
                aggregateType: 'insurance_batch',
                aggregateId: batchId.toString()
            }, mongoSession);
        }
        
        await mongoSession.commitTransaction();
        
        // Atualiza view
        await updateInsuranceBatchView(batchId, correlationId, log);
        
        log.info('item_rejected_processed', 'Item rejeitado processado', {
            batchId,
            itemId,
            isRecoverable,
            suggestedAction
        });
        
        return { 
            status: 'rejected_processed', 
            batchId,
            itemId,
            isRecoverable,
            suggestedAction
        };
        
    } catch (error) {
        await mongoSession.abortTransaction();
        throw error;
    } finally {
        mongoSession.endSession();
    }
}

/**
 * Handler: INSURANCE_PAYMENT_RECEIVED
 * Pagamento recebido - conciliação
 */
async function handlePaymentReceived(payload, correlationId, log) {
    const { batchId, receivedAmount, bankReference } = payload;
    
    log.info('payment_received', 'Pagamento recebido do convênio', { 
        batchId, 
        receivedAmount,
        bankReference 
    });
    
    const batch = await InsuranceBatch.findById(batchId);
    
    if (!batch) {
        throw new Error(`BATCH_NOT_FOUND: ${batchId}`);
    }
    
    // Atualiza valores
    batch.receivedAmount = receivedAmount;
    
    // Conciliação
    const expectedAmount = batch.totalNet;
    const difference = receivedAmount - expectedAmount;
    
    if (Math.abs(difference) < 0.01) {
        batch.reconciliationStatus = 'completed';
        log.info('reconciliation_complete', 'Conciliação completa', { batchId });
    } else {
        batch.reconciliationStatus = 'partial';
        log.warn('reconciliation_partial', 'Diferença na conciliação', { 
            batchId,
            expected: expectedAmount,
            received: receivedAmount,
            difference
        });
    }
    
    batch.reconciledAt = new Date();
    await batch.save();
    
    // Atualiza view
    await updateInsuranceBatchView(batchId, correlationId, log);
    
    // Publica evento de conciliação
    await publishEvent(
        InsuranceEventTypes.INSURANCE_RECONCILIATION_COMPLETED,
        {
            batchId: batchId.toString(),
            expectedAmount,
            receivedAmount,
            difference,
            status: batch.reconciliationStatus,
            bankReference
        },
        { correlationId }
    );
    
    return { 
        status: 'payment_processed', 
        batchId,
        reconciliationStatus: batch.reconciliationStatus,
        difference
    };
}

/**
 * Handler: INSURANCE_BATCH_REPROCESS_REQUESTED
 * Reprocessamento solicitado
 */
async function handleReprocessRequested(payload, correlationId, log) {
    const { batchId, itemIds, reason, corrections } = payload;
    
    log.info('reprocess_requested', 'Reprocessamento solicitado', { 
        batchId, 
        itemCount: itemIds?.length || 'all',
        reason 
    });
    
    const batch = await InsuranceBatch.findById(batchId);
    
    if (!batch) {
        throw new Error(`BATCH_NOT_FOUND: ${batchId}`);
    }
    
    // Aplica correções se houver
    if (corrections) {
        for (const itemId of (itemIds || batch.items.map(i => i._id))) {
            const item = batch.items.id(itemId);
            if (item) {
                if (corrections.procedureCode) item.procedureCode = corrections.procedureCode;
                if (corrections.grossAmount) item.grossAmount = corrections.grossAmount;
                item.status = 'pending';
                item.attemptCount += 1;
            }
        }
    }
    
    batch.status = 'pending';
    batch.retryCount += 1;
    await batch.save();
    
    // Re-publica evento de criação para reiniciar fluxo
    await publishEvent(
        InsuranceEventTypes.INSURANCE_BATCH_CREATED,
        {
            batchId: batchId.toString(),
            batchNumber: batch.batchNumber,
            isReprocess: true,
            originalAttempt: batch.retryCount - 1
        },
        { correlationId }
    );
    
    return { 
        status: 'reprocess_initiated', 
        batchId,
        retryCount: batch.retryCount
    };
}

// ============================================
// HELPERS
// ============================================

/**
 * Determina se uma glosa é recuperável
 */
function isGlosaRecoverable(glosaCode) {
    if (!glosaCode) return false;
    
    // Códigos de glosa recuperáveis (exemplos TISS)
    const recoverableCodes = [
        '2010', // Dados incompletos
        '2020', // Erro de digitação
        '2030', // Data incorreta
        '3010', // Autorização pendente
        '3020', // Guia não encontrada (pode ser reenviada)
    ];
    
    return recoverableCodes.some(code => glosaCode.startsWith(code));
}

/**
 * Sugere ação para glosa
 */
function suggestGlosaAction(glosaCode) {
    if (!glosaCode) return 'write_off';
    
    const codePrefix = glosaCode.substring(0, 2);
    
    switch (codePrefix) {
        case '20': // Erros de dados
        case '30': // Problemas de autorização
            return 'retry';
        case '40': // Erros de procedimento
            return 'correct';
        case '50': // Recusa de cobertura
            return 'appeal';
        default:
            return 'write_off';
    }
}
