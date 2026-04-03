// workers/cancelOrchestratorWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import { cancelSession } from '../domain/session/cancelSession.js';
import { cancelPayment } from '../domain/payment/cancelPayment.js';
import { restorePackageOnCancel } from '../domain/package/restorePackageOnCancel.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import mongoose from 'mongoose';
import { 
    eventExists, 
    processWithGuarantees, 
    appendEvent 
} from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';
import { createContextLogger } from '../utils/logger.js';

/**
 * Cancel Orchestrator Worker
 * 
 * Orquestra o fluxo de cancelamento usando regras de domínio puras.
 * NÃO contém regra de negócio - só coordena.
 * Usa Event Store para idempotência persistente.
 */

export function startCancelOrchestratorWorker() {
    const worker = new Worker('cancel-orchestrator', async (job) => {
        const { eventId, correlationId, idempotencyKey, payload } = job.data;
        const { appointmentId, reason, confirmedAbsence, userId, forceCancel = false } = payload;

        const log = createContextLogger(correlationId || appointmentId, 'cancel');

        log.info('start', 'Iniciando cancelamento', {
            appointmentId,
            reason,
            eventId,
            idempotencyKey
        });

        // 🛡️ IDEMPOTÊNCIA VIA EVENT STORE
        const existingEvent = await EventStore.findOne({ eventId });
        if (existingEvent) {
            if (existingEvent.status === 'processed') {
                log.info('idempotent', 'Evento já processado', { eventId, status: 'processed' });
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

        // 🛡️ IDEMPOTÊNCIA GLOBAL: Verifica por idempotencyKey
        if (idempotencyKey && await eventExists(idempotencyKey)) {
            const existingByKey = await EventStore.findOne({ idempotencyKey });
            if (existingByKey?.status === 'processed') {
                log.info('idempotent', 'IdempotencyKey já processada', { idempotencyKey });
                return { 
                    status: 'already_processed', 
                    appointmentId,
                    idempotencyKey,
                    source: 'idempotency_key'
                };
            }
        }

        // Cria/registra evento no Event Store
        const storedEvent = await appendEvent({
            eventId,
            eventType: EventTypes.APPOINTMENT_CANCEL_REQUESTED,
            aggregateType: 'appointment',
            aggregateId: appointmentId,
            payload,
            metadata: { correlationId, idempotencyKey, source: 'cancelOrchestratorWorker' },
            idempotencyKey: idempotencyKey || `cancel_${appointmentId}_${Date.now()}`
        });

        // Processa com garantias de idempotência
        return await processWithGuarantees(storedEvent.eventId, async () => {

        const mongoSession = await mongoose.startSession();

        try {
            await mongoSession.startTransaction();

            // 1. Busca appointment (POPULADO para ter dados do payment)
            const appointment = await Appointment.findById(appointmentId)
                .populate('payment')
                .session(mongoSession);

            if (!appointment) {
                throw new Error('APPOINTMENT_NOT_FOUND');
            }

            // 🛡️ IDEMPOTÊNCIA: Já cancelado?
            if (appointment.operationalStatus === 'canceled') {
                await mongoSession.abortTransaction();
                return { status: 'already_canceled', appointmentId, idempotent: true };
            }

            // 🛡️ TRAVA DE SEGURANÇA: Não cancelar completed pago sem force
            // Sessão foi realizada E pagamento já foi confirmado = perigo de estorno indevido
            const wasCompleted = appointment.clinicalStatus === 'completed';
            const wasPaid = appointment.payment?.status === 'paid' || 
                           appointment.paymentStatus === 'package_paid';
            
            if (wasCompleted && wasPaid && !forceCancel) {
                await mongoSession.abortTransaction();
                log.warn('security_block', 'Tentativa de cancelar completed pago sem forceCancel', {
                    appointmentId,
                    clinicalStatus: appointment.clinicalStatus,
                    paymentStatus: appointment.payment?.status || appointment.paymentStatus
                });
                throw new Error('CANCEL_COMPLETED_PAID_REQUIRES_FORCE');
            }

            // 2. CANCELA SESSÃO (regra de domínio)
            let sessionResult = null;
            if (appointment.session) {
                const session = await Session.findById(appointment.session)
                    .session(mongoSession);

                if (session) {
                    sessionResult = await cancelSession(session, {
                        reason,
                        confirmedAbsence,
                        userId
                    });
                }
            }

            // 3. CANCELA PAYMENT (regra de domínio) - dentro da transação
            let paymentResult = null;
            if (appointment.payment) {
                paymentResult = await cancelPayment(appointment.payment, { 
                    reason,
                    mongoSession  // ← Passa sessão para atomicidade
                });
            }

            // 4. RESTAURA PACOTE (antes de alterar clinicalStatus!)
            // Precisamos do status original para saber se deve restaurar
            const originalClinicalStatus = appointment.clinicalStatus;
            
            // 5. ATUALIZA APPOINTMENT
            appointment.operationalStatus = 'canceled';
            appointment.clinicalStatus = confirmedAbsence ? 'missed' : 'pending';
            appointment.paymentStatus = 'canceled';
            appointment.visualFlag = 'blocked';
            appointment.canceledReason = reason;
            appointment.canceledAt = new Date();
            appointment.updatedAt = new Date();

            if (!appointment.history) appointment.history = [];
            appointment.history.push({
                action: 'cancelamento',
                newStatus: 'canceled',
                changedBy: userId,
                timestamp: new Date(),
                context: 'operacional',
                details: { 
                    reason, 
                    confirmedAbsence,
                    sessionPreserved: sessionResult?.preserved || false,
                    paymentCanceled: paymentResult?.canceled || false
                }
            });

            await appointment.save({ session: mongoSession });

            // 6. PACOTE: Restaura sessão e financeiro (se estava completed)
            if (appointment.package) {
                // Restaura sessionsDone e financeiro (per-session)
                // 🛡️ Usa originalClinicalStatus (antes de alterar para 'missed'/'pending')
                await restorePackageOnCancel(appointment.package, {
                    appointmentStatus: originalClinicalStatus,  // ← CRITICAL FIX
                    paymentOrigin: appointment.paymentOrigin,
                    sessionValue: appointment.sessionValue || 0,
                    mongoSession,
                    appointmentId: appointmentId.toString(),
                    alreadyCanceled: false  // Já verificamos que não estava cancelado
                });
                
                // Remove do array de appointments
                await Package.findByIdAndUpdate(
                    appointment.package,
                    {
                        $pull: { appointments: appointmentId }
                    },
                    { session: mongoSession }
                );
            }

            await mongoSession.commitTransaction();

            // Forca rebuild da projecao do pacote apos cancelamento
            if (appointment.package) {
                // Aguarda propagação do commit antes de notificar projection worker
                await new Promise(r => setTimeout(r, 50));
                await publishEvent(
                    EventTypes.PACKAGE_UPDATED,
                    {
                        packageId: appointment.package.toString(),
                        patientId: appointment.patient?._id?.toString(),
                        appointmentId: appointmentId.toString(),
                        reason: 'appointment_canceled'
                    },
                    { correlationId }
                );
                console.log('[CancelOrchestrator] Evento PACKAGE_UPDATED publicado');
            }

            log.info('completed', 'Cancelamento concluído', {
                appointmentId,
                sessionPreserved: sessionResult?.preserved || false,
                paymentCanceled: paymentResult?.canceled || false
            });

            // ✅ PUBLICA EVENTO DE RESULTADO: APPOINTMENT_CANCELED
            await publishEvent(
                EventTypes.APPOINTMENT_CANCELED,
                {
                    appointmentId: appointmentId.toString(),
                    patientId: appointment.patient?.toString(),
                    packageId: appointment.package?.toString(),
                    reason,
                    sessionPreserved: sessionResult?.preserved || false,
                    reusableCredit: sessionResult?.preserved || false,
                    previousStatus: 'processing_cancel'
                },
                { correlationId }
            );

            // ✅ SOLICITA RECÁLCULO DE TOTAIS (cancelamento afeta receita)
            await publishEvent(
                EventTypes.TOTALS_RECALCULATE_REQUESTED,
                {
                    clinicId: appointment.clinicId,
                    date: new Date().toISOString().split('T')[0],
                    period: 'month',
                    reason: 'appointment_canceled',
                    triggeredBy: 'cancel_orchestrator'
                },
                { correlationId }
            );

            return {
                status: 'canceled',
                appointmentId,
                sessionPreserved: sessionResult?.preserved || false,
                paymentCanceled: paymentResult?.canceled || false,
                paymentPreserved: paymentResult?.reason === 'PACKAGE_PAYMENT_PRESERVED',
                idempotencyKey
            };

        } catch (error) {
            await mongoSession.abortTransaction();
            log.error('error', 'Erro no cancelamento', { error: error.message });
            
            if (job.attemptsMade >= 4) {
                await moveToDLQ(job, error);
            }
            
            throw error;
        } finally {
            mongoSession.endSession();
        }

        }); // Fim do processWithGuarantees

    }, {
        connection: redisConnection,
        concurrency: 3
    });

    worker.on('completed', (job, result) => {
        console.log(`[CancelOrchestrator] Job ${job.id}: ${result.status}`);
    });

    worker.on('failed', (job, error) => {
        console.error(`[CancelOrchestrator] Job ${job?.id} falhou:`, error.message);
    });

    console.log('[CancelOrchestrator] Worker iniciado');
    return worker;
}
