// workers/cancelOrchestratorWorker.v2.js
// 🚀 VERSÃO COM FINANCIAL GUARD - Transaction enxugada, financeiro centralizado

import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import { cancelSession } from '../domain/session/cancelSession.js';
import FinancialGuard from '../services/financialGuard/index.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import mongoose from 'mongoose';
import { 
    eventExists, 
    processWithGuarantees, 
    appendEvent 
} from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';
import { createContextLogger } from '../utils/logger.js';

let mongoConnected = false;
async function ensureMongoConnection() {
    if (mongoConnected && mongoose.connection.readyState === 1) return;
    
    const MONGO_URI = process.env.MONGO_URI;
    if (!MONGO_URI) throw new Error('MONGO_URI não configurada');
    
    await mongoose.connect(MONGO_URI, {
        maxPoolSize: 10,
        minPoolSize: 2,
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
    });
    mongoConnected = true;
    console.log('[CancelOrchestratorV2] 🟢 MongoDB conectado');
}

async function releaseAppointmentLock(appointmentId, reason = 'worker_failed') {
    if (!appointmentId) return;
    
    try {
        await ensureMongoConnection();
        
        const result = await Appointment.findOneAndUpdate(
            { _id: appointmentId, operationalStatus: 'processing_cancel' },
            {
                $set: { operationalStatus: 'scheduled', updatedAt: new Date() },
                $push: {
                    history: {
                        action: 'auto_release_cancel',
                        previousStatus: 'processing_cancel',
                        newStatus: 'scheduled',
                        timestamp: new Date(),
                        context: `Worker cancel falhou: ${reason}`
                    }
                }
            }
        );
        
        if (result) {
            console.log(`[CancelOrchestratorV2] 🔓 Lock liberado: ${appointmentId} → scheduled`);
        }
    } catch (err) {
        console.error(`[CancelOrchestratorV2] ❌ ERRO ao liberar lock:`, err.message);
    }
}

/**
 * Cancel Orchestrator Worker - VERSÃO COM FINANCIAL GUARD
 * 🎯 Transaction: só core (session + appointment + financial guard)
 * 🎯 Financeiro: centralizado no FinancialGuard por billingType
 */
export async function startCancelOrchestratorWorkerV2() {
    console.log('[CancelOrchestratorV2] 🚀 Iniciando worker (com Financial Guard)...');
    
    await ensureMongoConnection();
    
    const worker = new Worker('cancel-orchestrator', async (job) => {
        const { eventId, correlationId, idempotencyKey, payload } = job.data;
        const { appointmentId, reason, confirmedAbsence, userId } = payload;
        
        await ensureMongoConnection();
        
        console.log(`[CancelOrchestratorV2] Job ${job.id} - appointmentId: ${appointmentId}`);
        
        const log = createContextLogger(correlationId || appointmentId, 'cancel_v2');
        
        try {
            return await processCancelJobV2({
                job,
                eventId,
                correlationId,
                idempotencyKey,
                payload: { appointmentId, reason, confirmedAbsence, userId },
                log
            });
        } catch (error) {
            console.error(`[CancelOrchestratorV2] Job ${job.id} erro:`, error.message);
            await releaseAppointmentLock(appointmentId, error.message);
            throw error;
        }
    }, {
        connection: redisConnection,
        concurrency: 3,
        defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 50 }
        }
    });
    
    worker.on('failed', async (job, error) => {
        const appointmentId = job?.data?.payload?.appointmentId;
        if (job?.attemptsMade >= (job?.opts?.attempts || 1)) {
            await releaseAppointmentLock(appointmentId, `all_attempts_failed: ${error.message}`);
            try { await moveToDLQ('cancel-orchestrator', job, error); } catch {}
        }
    });
    
    worker.on('completed', (job, result) => {
        console.log(`[CancelOrchestratorV2] ✅ Job ${job.id} completado: ${result.status}`);
    });
    
    console.log('[CancelOrchestratorV2] ✅ Worker iniciado (v2.2 - Financial Guard)');
    return worker;
}

async function processCancelJobV2({ job, eventId, correlationId, idempotencyKey, payload, log }) {
    const { appointmentId, reason, confirmedAbsence, userId } = payload;
    
    // 🛡️ IDEMPOTÊNCIA
    const existingEvent = await EventStore.findOne({ eventId });
    if (existingEvent?.status === 'processed') {
        return { status: 'already_processed', appointmentId, eventId, idempotent: true };
    }

    if (idempotencyKey && await eventExists(idempotencyKey)) {
        const existingByKey = await EventStore.findOne({ idempotencyKey });
        if (existingByKey?.status === 'processed') {
            return { status: 'already_processed', appointmentId, idempotent: true };
        }
    }

    // Registra evento
    const storedEvent = await appendEvent({
        eventId,
        eventType: EventTypes.APPOINTMENT_CANCEL_REQUESTED,
        aggregateType: 'appointment',
        aggregateId: appointmentId,
        payload,
        metadata: { correlationId, idempotencyKey, source: 'cancelOrchestratorWorkerV2' },
        idempotencyKey: idempotencyKey || `cancel_${appointmentId}_${Date.now()}`
    });

    return await processWithGuarantees(storedEvent.eventId, async () => {
        
        // ============================================================
        // 🔥 TRANSACTION: Core + Financial Guard
        // ============================================================
        const mongoSession = await mongoose.startSession();
        let appointment;
        let financialResult = null;

        try {
            await mongoSession.startTransaction({
                readConcern: { level: 'local' },
                writeConcern: { w: 'majority' }
            });

            // 1. Busca appointment
            appointment = await Appointment.findById(appointmentId).session(mongoSession);
            
            if (!appointment) {
                throw new Error('APPOINTMENT_NOT_FOUND');
            }

            // Guard: já cancelado
            if (appointment.operationalStatus === 'canceled') {
                return { status: 'already_canceled', appointmentId, idempotent: true };
            }

            const sessionId = appointment.session;
            const packageId = appointment.package;
            const paymentId = appointment.payment;
            const billingType = appointment.billingType || 'particular';

            // 2. Cancela sessão (core)
            if (sessionId) {
                try {
                    await cancelSession(sessionId, { mongoSession, reason, confirmedAbsence });
                } catch (sessionErr) {
                    console.warn('[CancelOrchestratorV2] ⚠️ Erro ao cancelar sessão:', sessionErr.message);
                }
            }

            // 3. 🔥 FINANCIAL GUARD (centraliza todo financeiro por tipo)
            //    Isso substitui: restorePackageOnCancel + cancelPayment
            try {
                financialResult = await FinancialGuard.execute({
                    context: 'CANCEL_APPOINTMENT',
                    billingType: billingType,
                    payload: {
                        appointmentId: appointmentId.toString(),
                        packageId: packageId?.toString(),
                        paymentId: paymentId?.toString(),
                        appointmentStatus: appointment.operationalStatus,
                        paymentOrigin: appointment.paymentOrigin,
                        sessionValue: appointment.sessionValue || 0,
                        confirmedAbsence,
                        reason,
                        billingType: appointment?.billingType
                    },
                    session: mongoSession
                });

                if (financialResult?.handled) {
                    console.log('[CancelOrchestratorV2] 💰 Financial Guard executado:', {
                        billingType,
                        result: financialResult
                    });
                }
            } catch (financialErr) {
                // Se Financial Guard falhar, ABORTA TUDO!
                console.error('[CancelOrchestratorV2] ❌ ERRO CRÍTICO no Financial Guard:', financialErr.message);
                throw new Error(`FINANCIAL_GUARD_FAILED: ${financialErr.message}`);
            }

            // 4. Atualiza appointment para canceled
            await Appointment.findByIdAndUpdate(
                appointmentId,
                {
                    $set: {
                        operationalStatus: 'canceled',
                        canceledReason: reason,
                        confirmedAbsence: confirmedAbsence || false,
                        canceledAt: new Date(),
                        updatedAt: new Date()
                    },
                    $push: {
                        history: {
                            action: 'canceled',
                            newStatus: 'canceled',
                            changedBy: userId,
                            timestamp: new Date(),
                            context: `Motivo: ${reason}${confirmedAbsence ? ' (Falta confirmada)' : ''}`
                        }
                    }
                },
                { session: mongoSession }
            );

            await mongoSession.commitTransaction();
            console.log('[CancelOrchestratorV2] ✅ Transaction commitada (Financial Guard integrado)');

        } catch (error) {
            console.error('[CancelOrchestratorV2] ❌ ERRO na transaction:', error.message);
            await mongoSession.abortTransaction();
            throw error;
        } finally {
            mongoSession.endSession();
        }

        // ============================================================
        // 🎯 PÓS-COMMIT: Side Effects (não-críticos)
        // ============================================================
        
        // 🔄 REBUILD da view do pacote (se houver)
        if (appointment?.package) {
            try {
                const { buildPackageView } = await import('../domains/billing/services/PackageProjectionService.js');
                await buildPackageView(appointment.package.toString(), { correlationId: correlationId || `cancel_rebuild_${Date.now()}` });
                console.log(`[CancelOrchestratorV2] 🔄 View do pacote ${appointment.package} reconstruída após cancelamento`);
            } catch (viewErr) {
                console.warn('[CancelOrchestratorV2] ⚠️ Erro ao reconstruir view (não crítico):', viewErr.message);
            }
        }
        
        try {
            await publishEvent(
                EventTypes.APPOINTMENT_CANCELED,
                {
                    appointmentId: appointmentId.toString(),
                    patientId: appointment?.patient?.toString(),
                    packageId: appointment?.package?.toString(),
                    sessionId: appointment?.session?.toString(),
                    paymentId: appointment?.payment?.toString(),
                    billingType: appointment?.billingType,
                    reason,
                    confirmedAbsence,
                    financialResult,
                    _meta: {
                        version: '2.2-financial-guard',
                        transactionScope: 'core_plus_financial_guard',
                        billingType: appointment?.billingType
                    }
                },
                { correlationId }
            );
        } catch (evtErr) {
            console.warn('[CancelOrchestratorV2] ⚠️ Erro ao publicar evento (não crítico):', evtErr.message);
        }

        return {
            status: 'canceled',
            appointmentId,
            idempotent: false,
            financialResult
        };
    });
}

export default { startCancelOrchestratorWorkerV2 };
