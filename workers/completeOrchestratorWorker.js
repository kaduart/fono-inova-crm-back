// workers/completeOrchestratorWorker.js
// 🚀 VERSÃO PRODUÇÃO - Robusta, com retry, liberação de lock e garantias

import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import { completeSession } from '../domain/session/completeSession.js';
import { consumePackageSession, updatePackageFinancials } from '../domain/package/consumePackageSession.js';
import { consumeInsuranceGuide, createInsurancePayment } from '../domain/insurance/consumeInsuranceGuide.js';
import { recognizeLiminarRevenue } from '../domain/liminar/recognizeRevenue.js';
import { createPaymentForComplete, confirmPayment } from '../domain/payment/cancelPayment.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import { withLock } from '../utils/redisLock.js';
import { createContextLogger } from '../utils/logger.js';
import mongoose from 'mongoose';
import { 
    eventExists, 
    processWithGuarantees, 
    appendEvent 
} from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';

// 🔴 GARANTE CONEXÃO MONGO NO WORKER (Problema #1)
let mongoConnected = false;
async function ensureMongoConnection() {
    if (mongoConnected && mongoose.connection.readyState === 1) {
        return;
    }
    
    const MONGO_URI = process.env.MONGO_URI;
    if (!MONGO_URI) {
        throw new Error('MONGO_URI não configurada');
    }
    
    try {
        await mongoose.connect(MONGO_URI, {
            maxPoolSize: 10,
            minPoolSize: 2,
            serverSelectionTimeoutMS: 30000,
            socketTimeoutMS: 45000,
        });
        mongoConnected = true;
        console.log('[CompleteOrchestrator] 🟢 MongoDB conectado');
    } catch (err) {
        console.error('[CompleteOrchestrator] ❌ Falha ao conectar MongoDB:', err.message);
        throw err;
    }
}

// 🔴 LIBERA APPOINTMENT EM CASO DE FALHA (Problema #2)
async function releaseAppointmentLock(appointmentId, reason = 'worker_failed') {
    if (!appointmentId) return;
    
    try {
        await ensureMongoConnection();
        
        // ✅ CORREÇÃO: Só libera se AINDA estiver em processing_complete
        const result = await Appointment.findOneAndUpdate(
            {
                _id: appointmentId,
                operationalStatus: 'processing_complete'
            },
            {
                $set: { 
                    operationalStatus: 'scheduled',
                    updatedAt: new Date()
                },
                $push: {
                    history: {
                        action: 'auto_release',
                        previousStatus: 'processing_complete',
                        newStatus: 'scheduled',
                        timestamp: new Date(),
                        context: `Worker falhou: ${reason}`
                    }
                }
            }
        );
        
        if (result) {
            console.log(`[CompleteOrchestrator] 🔓 Lock liberado: ${appointmentId} → scheduled`);
        } else {
            console.log(`[CompleteOrchestrator] ℹ️ Não liberado: ${appointmentId} já não está em processing_complete`);
        }
    } catch (err) {
        console.error(`[CompleteOrchestrator] ❌ ERRO CRÍTICO ao liberar lock:`, err.message);
        // Não relança - não queremos que o erro de liberação esconda o erro original
    }
}

/**
 * Complete Orchestrator Worker - VERSÃO PRODUÇÃO
 */
export async function startCompleteOrchestratorWorker() {
    console.log('[CompleteOrchestrator] 🚀 Iniciando worker...');
    
    // Garante conexão antes de criar o worker
    await ensureMongoConnection();
    
    const worker = new Worker('complete-orchestrator', async (job) => {
        const { eventId, correlationId, idempotencyKey, payload } = job.data;
        const { 
            appointmentId, 
            addToBalance = false,
            balanceAmount = 0,
            balanceDescription = '',
            userId 
        } = payload;
        
        // Garante conexão a cada job
        await ensureMongoConnection();
        
        console.log(`[CompleteOrchestrator] Job ${job.id} - appointmentId: ${appointmentId}, tentativa ${job.attemptsMade + 1}`);
        
        const log = createContextLogger(correlationId || appointmentId, 'complete');
        
        log.info('start', 'Iniciando complete', {
            appointmentId,
            attempt: job.attemptsMade + 1,
            maxAttempts: job.opts?.attempts || 1
        });
        
        try {
            return await withLock(`appointment:${appointmentId}:complete`, async () => {
                return await processCompleteJob({
                    job,
                    eventId,
                    correlationId,
                    idempotencyKey,
                    payload: { appointmentId, addToBalance, balanceAmount, balanceDescription, userId },
                    log
                });
            }, { ttl: 180 }); // 🔴 LOCK TTL AUMENTADO: 180s (Problema #5)
            
        } catch (error) {
            console.error(`[CompleteOrchestrator] Job ${job.id} erro:`, error.message);
            
            // 🔴 LIBERA LOCK EM CASO DE ERRO (Problema #2)
            await releaseAppointmentLock(appointmentId, error.message);
            
            throw error; // Relança para o BullMQ fazer retry
        }
    }, {
        connection: redisConnection,
        concurrency: 3,
        // 🔴 RETRY AUTOMÁTICO (Problema #6)
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 5000
            },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 50 }
        }
    });
    
    // 🔴 HANDLER DE FALHA - LIBERA LOCK (Problema #2)
    worker.on('failed', async (job, error) => {
        const appointmentId = job?.data?.payload?.appointmentId;
        console.error(`[CompleteOrchestrator] Job ${job?.id} falhou após ${job?.attemptsMade} tentativas:`, error.message);
        
        // Libera o lock se esgotou todas as tentativas
        if (job?.attemptsMade >= (job?.opts?.attempts || 1)) {
            await releaseAppointmentLock(appointmentId, `all_attempts_failed: ${error.message}`);
            
            // Move para DLQ (Dead Letter Queue) para análise posterior
            try {
                await moveToDLQ('complete-orchestrator', job, error);
            } catch (dlqErr) {
                console.error('[CompleteOrchestrator] Erro ao mover para DLQ:', dlqErr.message);
            }
        }
    });
    
    worker.on('completed', (job, result) => {
        console.log(`[CompleteOrchestrator] Job ${job.id} completado: ${result.status}`);
    });
    
    worker.on('error', (error) => {
        console.error('[CompleteOrchestrator] Worker error:', error.message);
    });
    
    console.log('[CompleteOrchestrator] ✅ Worker iniciado (v2.0 - Produção)');
    return worker;
}

// Processamento principal isolado para clareza
async function processCompleteJob({ job, eventId, correlationId, idempotencyKey, payload, log }) {
    const { appointmentId, addToBalance, balanceAmount, balanceDescription, userId } = payload;
    
    // 🛡️ IDEMPOTÊNCIA VIA EVENT STORE
    const existingEvent = await EventStore.findOne({ eventId });
    if (existingEvent) {
        if (existingEvent.status === 'processed') {
            log.info('idempotent', 'Evento já processado', { eventId });
            return { 
                status: 'already_processed', 
                appointmentId,
                eventId,
                idempotent: true
            };
        }
        if (existingEvent.status === 'processing') {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            if (existingEvent.updatedAt < fiveMinutesAgo) {
                log.warn('stale_processing', 'Evento travado em processing, reprocessando', { eventId });
            } else {
                log.info('concurrent', 'Evento em processamento por outro worker', { eventId });
                return { 
                    status: 'concurrent_processing', 
                    appointmentId,
                    eventId,
                    idempotent: true
                };
            }
        }
    }
    
    // 🛡️ IDEMPOTÊNCIA GLOBAL
    if (idempotencyKey && await eventExists(idempotencyKey)) {
        const existingByKey = await EventStore.findOne({ idempotencyKey });
        if (existingByKey?.status === 'processed') {
            log.info('idempotent', 'IdempotencyKey já processada', { idempotencyKey });
            return { 
                status: 'already_processed', 
                appointmentId,
                idempotent: true
            };
        }
    }
    
    // Cria/registra evento
    const storedEvent = await appendEvent({
        eventId,
        eventType: EventTypes.SESSION_COMPLETED,
        aggregateType: 'appointment',
        aggregateId: appointmentId,
        payload,
        metadata: { correlationId, idempotencyKey, source: 'completeOrchestratorWorker' },
        idempotencyKey: idempotencyKey || `complete_${appointmentId}_${Date.now()}`
    });
    
    return await processWithGuarantees(storedEvent, async () => {
        // Busca appointment
        const appointment = await Appointment.findById(appointmentId);
        
        if (!appointment) {
            throw new Error('APPOINTMENT_NOT_FOUND');
        }
        
        // Guards
        if (appointment.clinicalStatus === 'completed') {
            return { status: 'already_completed', appointmentId, idempotent: true };
        }
        
        if (appointment.operationalStatus === 'canceled') {
            throw new Error('CANNOT_COMPLETE_CANCELED');
        }
        
        // Busca dados do pacote
        const packageId = appointment.package?._id || appointment.package;
        let packageDoc = null;
        if (packageId) {
            const Package = (await import('../models/Package.js')).default;
            packageDoc = await Package.findById(packageId);
            if (packageDoc && packageDoc.sessionsDone >= packageDoc.totalSessions) {
                throw new Error('PACKAGE_EXHAUSTED');
            }
        }
        
        const isPerSession = packageDoc?.paymentType === 'per-session';
        const isConvenio = packageDoc?.type === 'convenio';
        const isLiminar = packageDoc?.type === 'liminar';
        const isParticularSimple = !packageId && !isConvenio && !isLiminar;
        
        // Determina paymentOrigin
        let paymentOrigin = null;
        if (addToBalance) paymentOrigin = 'manual_balance';
        else if (isConvenio) paymentOrigin = 'convenio';
        else if (isLiminar) paymentOrigin = 'liminar';
        else if (isPerSession) paymentOrigin = 'auto_per_session';
        else if (packageId) paymentOrigin = 'package_prepaid';
        
        const sessionValue = appointment.sessionValue || 0;
        const sessionId = appointment.session?._id;
        const existingPayment = appointment.payment?._id || appointment.payment;
        
        // 🔴 TRANSAÇÃO PRINCIPAL (inclui payment se possível)
        const mongoSession = await mongoose.startSession();
        let perSessionPayment = null;
        
        try {
            await mongoSession.startTransaction({
                readConcern: { level: 'local' },
                writeConcern: { w: 'majority' }
            });
            
            // 1. CONSOME PACOTE
            if (packageId && appointment.clinicalStatus !== 'completed') {
                await consumePackageSession(packageId, { mongoSession });
            }
            
            // 🔴 CRIA PAYMENT DENTRO DA TRANSAÇÃO quando possível (Problema #4)
            // ✅ CORREÇÃO: Verifica idempotência por appointmentId para evitar duplicação em retry
            if (!addToBalance && !existingPayment && isPerSession && packageId) {
                // Busca se já existe payment para este appointment (idempotência)
                const existingPerSessionPayment = await Payment.findOne({ 
                    appointment: appointmentId,
                    paymentOrigin: 'auto_per_session'
                }).session(mongoSession);
                
                if (existingPerSessionPayment) {
                    console.log(`[CompleteOrchestrator] ⚠️ Payment per-session já existe (retry): ${existingPerSessionPayment._id}`);
                    perSessionPayment = existingPerSessionPayment;
                } else {
                    perSessionPayment = await createPaymentForComplete({
                        patientId: appointment.patient?._id,
                        doctorId: appointment.doctor?._id,
                        appointmentId,
                        sessionId,
                        packageId,
                        amount: packageDoc?.sessionValue || 0,
                        paymentOrigin: 'auto_per_session',
                        correlationId,
                        serviceDate: appointment.date ? new Date(appointment.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
                    });
                }
            } else if (!addToBalance && !existingPayment && isParticularSimple && sessionValue > 0) {
                // Busca se já existe payment para este appointment (idempotência)
                const existingParticularPayment = await Payment.findOne({ 
                    appointment: appointmentId,
                    paymentOrigin: 'particular_simple'
                }).session(mongoSession);
                
                if (existingParticularPayment) {
                    console.log(`[CompleteOrchestrator] ⚠️ Payment particular já existe (retry): ${existingParticularPayment._id}`);
                    perSessionPayment = existingParticularPayment;
                } else {
                    perSessionPayment = await createPaymentForComplete({
                        patientId: appointment.patient?._id,
                        doctorId: appointment.doctor?._id,
                        appointmentId,
                        sessionId,
                        amount: sessionValue,
                        paymentOrigin: 'particular_simple',
                        correlationId,
                        serviceDate: appointment.date ? new Date(appointment.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
                    });
                }
            }
            
            // 2. ATUALIZA PACKAGE FINANCEIRO
            if (perSessionPayment && packageId) {
                await updatePackageFinancials(packageId, perSessionPayment.amount, mongoSession, packageDoc);
            }
            
            // 3. ATUALIZA APPOINTMENT
            const appointmentUpdate = buildAppointmentUpdate({
                addToBalance,
                balanceAmount,
                balanceDescription,
                paymentOrigin,
                correlationId,
                userId,
                isConvenio,
                packageId
            });
            
            const finalPaymentId = perSessionPayment?._id || existingPayment;
            if (finalPaymentId) {
                appointmentUpdate.payment = finalPaymentId;
            }
            
            await Appointment.findByIdAndUpdate(
                appointmentId,
                appointmentUpdate,
                { session: mongoSession }
            );
            
            // 4. SALVA EVENTOS NO OUTBOX
            const completedEventId = `APPOINTMENT_COMPLETED_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            await saveToOutbox(
                {
                    eventId: completedEventId,
                    correlationId: correlationId || completedEventId,
                    eventType: EventTypes.APPOINTMENT_COMPLETED,
                    payload: {
                        appointmentId: appointmentId.toString(),
                        patientId: appointment.patient?.toString(),
                        doctorId: appointment.doctor?.toString(),
                        packageId: packageId?.toString(),
                        sessionId: sessionId?.toString(),
                        paymentOrigin,
                        addToBalance,
                        perSessionPaymentId: perSessionPayment?._id?.toString(),
                        previousStatus: 'processing_complete'
                    },
                    aggregateType: 'appointment',
                    aggregateId: appointmentId.toString()
                },
                mongoSession
            );
            
            await mongoSession.commitTransaction();
            console.log('[CompleteOrchestrator] ✅ Transação commitada');
            
        } catch (error) {
            console.error('[CompleteOrchestrator] ❌ ERRO na transação:', error.message);
            await mongoSession.abortTransaction();
            throw error;
        } finally {
            mongoSession.endSession();
        }
        
        // PÓS-COMMIT (não crítico - falhas aqui são toleradas)
        await executePostCommitOperations({
            appointmentId,
            sessionId,
            packageId,
            appointment,
            packageDoc,
            perSessionPayment,
            existingPayment,
            addToBalance,
            paymentOrigin,
            correlationId,
            userId,
            isConvenio,
            isLiminar,
            isPerSession
        });
        
        return {
            status: 'completed',
            appointmentId,
            paymentOrigin,
            addToBalance,
            perSessionPaymentId: perSessionPayment?._id,
            idempotencyKey
        };
    });
}

// Operações pós-commit (não críticas)
async function executePostCommitOperations({
    appointmentId, sessionId, packageId, appointment, packageDoc,
    perSessionPayment, existingPayment, addToBalance, paymentOrigin,
    correlationId, userId, isConvenio, isLiminar, isPerSession
}) {
    const finalPaymentId = perSessionPayment?._id || existingPayment;
    
    // 1. COMPLETA SESSÃO
    if (sessionId) {
        try {
            const sessionPaymentData = {};
            
            if (addToBalance) {
                sessionPaymentData.paymentStatus = 'pending_balance';
                sessionPaymentData.isPaid = false;
                sessionPaymentData.visualFlag = 'pending';
                if (finalPaymentId) sessionPaymentData.paymentId = finalPaymentId;
            } else if (packageId && !isPerSession && !isConvenio) {
                sessionPaymentData.paymentStatus = 'package_paid';
                sessionPaymentData.isPaid = true;
                sessionPaymentData.visualFlag = 'ok';
            } else if (isConvenio) {
                sessionPaymentData.paymentStatus = 'pending_receipt';
                sessionPaymentData.isPaid = false;
                sessionPaymentData.visualFlag = 'pending';
            } else {
                sessionPaymentData.paymentStatus = 'paid';
                sessionPaymentData.isPaid = true;
                sessionPaymentData.visualFlag = 'ok';
                if (finalPaymentId) sessionPaymentData.paymentId = finalPaymentId;
            }
            
            await completeSession(sessionId, sessionPaymentData, {
                addToBalance,
                paymentOrigin,
                correlationId,
                userId
            });
        } catch (sessionErr) {
            console.warn('[CompleteOrchestrator] ⚠️ Erro ao completar sessão (não crítico):', sessionErr.message);
            // Log para monitoramento mas não falha
        }
    }
    
    // 2. PUBLICA EVENTO PACKAGE_UPDATED
    if (packageId) {
        try {
            await publishEvent(
                EventTypes.PACKAGE_UPDATED,
                {
                    packageId: packageId.toString(),
                    patientId: appointment.patient?._id?.toString(),
                    appointmentId: appointmentId.toString(),
                    reason: 'appointment_completed'
                },
                { correlationId }
            );
        } catch (err) {
            console.warn('[CompleteOrchestrator] ⚠️ Erro ao publicar PACKAGE_UPDATED:', err.message);
        }
    }
    
    // 3. CONFIRMA PAYMENT
    if (finalPaymentId && !addToBalance) {
        try {
            await confirmPayment(finalPaymentId);
        } catch (confirmErr) {
            console.error('[CompleteOrchestrator] ⚠️ Falha ao confirmar payment:', confirmErr.message);
        }
    }
    
    // 4. CONVÊNIO
    if (isConvenio && packageDoc?.insuranceGuide) {
        try {
            await consumeInsuranceGuide(packageDoc.insuranceGuide, sessionId);
            await createInsurancePayment({
                patientId: appointment.patient?._id,
                doctorId: appointment.doctor?._id,
                appointmentId,
                sessionId,
                packageId,
                guideId: packageDoc.insuranceGuide,
                insuranceProvider: packageDoc.insuranceProvider,
                insuranceValue: packageDoc.insuranceGrossAmount || 0,
                correlationId
            });
        } catch (insuranceErr) {
            console.error('[CompleteOrchestrator] ⚠️ Erro convênio:', insuranceErr.message);
        }
    }
    
    // 5. LIMINAR
    if (isLiminar) {
        try {
            await recognizeLiminarRevenue(packageId, {
                sessionValue: appointment.sessionValue || packageDoc?.sessionValue || 0,
                appointmentId,
                sessionId,
                patientId: appointment.patient?._id,
                doctorId: appointment.doctor?._id,
                date: appointment.date,
                correlationId
            });
        } catch (liminarErr) {
            console.error('[CompleteOrchestrator] ⚠️ Erro liminar:', liminarErr.message);
        }
    }
    
    // 6. FIADO
    if (addToBalance) {
        try {
            await publishEvent(
                EventTypes.BALANCE_UPDATE_REQUESTED,
                {
                    patientId: appointment.patient?._id?.toString(),
                    amount: balanceAmount || appointment.sessionValue,
                    description: balanceDescription,
                    sessionId: sessionId?.toString(),
                    appointmentId: appointmentId.toString()
                },
                { correlationId }
            );
        } catch (err) {
            console.warn('[CompleteOrchestrator] ⚠️ Erro ao publicar BALANCE_UPDATE:', err.message);
        }
    }
    
    // 7. RECÁLCULO DE TOTAIS
    try {
        await publishEvent(
            EventTypes.TOTALS_RECALCULATE_REQUESTED,
            {
                clinicId: appointment.clinicId,
                date: new Date().toISOString().split('T')[0],
                period: 'month',
                reason: 'appointment_completed',
                triggeredBy: 'complete_orchestrator'
            },
            { correlationId }
        );
    } catch (err) {
        console.warn('[CompleteOrchestrator] ⚠️ Erro ao publicar TOTALS_RECALCULATE:', err.message);
    }
    
    // 8. DAILY CLOSING
    try {
        const appointmentDate = appointment.date 
            ? new Date(appointment.date).toISOString().split('T')[0]
            : new Date().toISOString().split('T')[0];
        
        await publishEvent(
            EventTypes.DAILY_CLOSING_REQUESTED,
            {
                clinicId: appointment.clinicId || 'default',
                date: appointmentDate,
                reason: 'appointment_completed',
                triggeredBy: 'complete_orchestrator',
                appointmentId: appointment._id.toString()
            },
            { correlationId }
        );
    } catch (err) {
        console.warn('[CompleteOrchestrator] ⚠️ Erro ao publicar DAILY_CLOSING:', err.message);
    }
}

function buildAppointmentUpdate({
    addToBalance,
    balanceAmount,
    balanceDescription,
    paymentOrigin,
    correlationId,
    userId,
    isConvenio,
    packageId
}) {
    const update = {
        $set: {
            operationalStatus: 'completed',
            clinicalStatus: 'completed',
            completedAt: new Date(),
            updatedAt: new Date(),
            paymentOrigin,
            correlationId
        },
        $push: {
            history: {
                action: addToBalance ? 'confirmed_with_balance' : 'confirmed',
                newStatus: 'confirmed',
                changedBy: userId,
                timestamp: new Date(),
                context: addToBalance ? `Saldo: ${balanceAmount}` : 'operacional'
            }
        }
    };
    
    if (addToBalance) {
        update.$set.paymentStatus = 'pending_balance';
        update.$set.visualFlag = 'pending';
        update.$set.addedToBalance = true;
        update.$set.balanceAmount = balanceAmount;
        update.$set.balanceDescription = balanceDescription || 'Sessão utilizada - pagamento pendente';
    } else if (packageId) {
        if (isConvenio) {
            update.$set.paymentStatus = 'pending_receipt';
            update.$set.visualFlag = 'pending';
        } else {
            update.$set.paymentStatus = 'package_paid';
            update.$set.visualFlag = 'ok';
        }
    } else {
        update.$set.paymentStatus = 'paid';
        update.$set.visualFlag = 'ok';
    }
    
    return update;
}
