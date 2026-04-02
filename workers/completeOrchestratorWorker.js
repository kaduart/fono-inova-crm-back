// workers/completeOrchestratorWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Appointment from '../models/Appointment.js';
import Payment from '../models/Payment.js';
import { completeSession } from '../domain/session/completeSession.js';
import { consumePackageSession, updatePackageFinancials } from '../domain/package/consumePackageSession.js';
import { consumeInsuranceGuide, createInsurancePayment } from '../domain/insurance/consumeInsuranceGuide.js';
import { recognizeLiminarRevenue } from '../domain/liminar/recognizeRevenue.js';
import { createPaymentForComplete, confirmPayment } from '../domain/payment/cancelPayment.js';
import { createPerSessionInvoice } from '../domain/invoice/index.js';
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

/**
 * Complete Orchestrator Worker
 * 
 * Orquestra o fluxo de complete usando regras de domínio puras.
 * Usa Event Store para idempotência persistente.
 */

export function startCompleteOrchestratorWorker() {
    console.log('[CompleteOrchestrator] 🚀 Worker iniciado');
    
    const worker = new Worker('complete-orchestrator', async (job) => {
        console.log(`[CompleteOrchestrator] Job ${job.id} iniciando processamento`);
        
        try {
        const { eventId, correlationId, idempotencyKey, payload } = job.data;
        const { 
            appointmentId, 
            addToBalance = false,
            balanceAmount = 0,
            balanceDescription = '',
            userId 
        } = payload;

        console.log(`[CompleteOrchestrator] Job ${job.id} - appointmentId: ${appointmentId}`);

        // Logger estruturado
        const log = createContextLogger(correlationId || appointmentId, 'complete');

        log.info('start', 'Iniciando complete', {
            appointmentId,
            addToBalance,
            eventId,
            idempotencyKey,
            attempt: job.attemptsMade + 1
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
                // Verifica se não está travado há muito tempo (mais de 5 minutos)
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
        
        // 🛡️ LOCK: Evita complete concorrente
        return await withLock(`appointment:${appointmentId}:complete`, async () => {

        // 🛡️ IDEMPOTÊNCIA GLOBAL VIA EVENT STORE
        if (idempotencyKey && await eventExists(idempotencyKey)) {
            const existingByKey = await EventStore.findOne({ idempotencyKey });
            if (existingByKey?.status === 'processed') {
                log.info('idempotent', 'IdempotencyKey já processada', { idempotencyKey });
                return { 
                    status: 'already_processed', 
                    appointmentId,
                    idempotencyKey,
                    idempotent: true
                };
            }
        }

        // Cria/registra evento no Event Store
        const storedEvent = await appendEvent({
            eventId,
            eventType: EventTypes.SESSION_COMPLETED,
            aggregateType: 'appointment',
            aggregateId: appointmentId,
            payload,
            metadata: { correlationId, idempotencyKey, source: 'completeOrchestratorWorker' },
            idempotencyKey: idempotencyKey || `complete_${appointmentId}_${Date.now()}`
        });

        // Processa com garantias de idempotência
        return await processWithGuarantees(storedEvent.eventId, async () => {

        // Busca dados
        console.log(`[CompleteOrchestrator] Buscando appointment: ${appointmentId}`);
        console.log(`[CompleteOrchestrator] MongoDB readyState: ${mongoose.connection.readyState}`);
        
        // Verifica se o ID é válido
        if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
            console.error(`[CompleteOrchestrator] ID inválido: ${appointmentId}`);
            throw new Error('APPOINTMENT_ID_INVALID');
        }
        
        // Busca sem populate primeiro (mais rápido)
        console.log(`[CompleteOrchestrator] Executando Appointment.findById...`);
        const appointment = await Appointment.findById(appointmentId);
        console.log(`[CompleteOrchestrator] Appointment encontrado: ${appointment ? 'SIM' : 'NÃO'}`);
        
        if (appointment) {
            console.log(`[CompleteOrchestrator] Appointment status: ${appointment.clinicalStatus}, operacional: ${appointment.operationalStatus}`);
        }

        if (!appointment) {
            // Tenta buscar sem populate para ver se existe
            const raw = await mongoose.connection.db.collection('appointments').findOne({ 
                _id: new mongoose.Types.ObjectId(appointmentId) 
            });
            console.error(`[CompleteOrchestrator] Appointment não encontrado: ${appointmentId}`);
            console.error(`[CompleteOrchestrator] Raw query result: ${raw ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}`);
            console.error(`[CompleteOrchestrator] Database: ${mongoose.connection.db.databaseName}`);
            throw new Error('APPOINTMENT_NOT_FOUND');
        }

        // 🛡️ GUARD 1: Não completar duas vezes
        if (appointment.clinicalStatus === 'completed') {
            console.log(`[CompleteOrchestrator] ⚠️ Agendamento já completado: ${appointmentId}`);
            return { status: 'already_completed', appointmentId, idempotent: true };
        }
        
        // 🛡️ GUARD 2: Não completar se cancelado
        if (appointment.operationalStatus === 'canceled') {
            console.log(`[CompleteOrchestrator] ❌ Agendamento cancelado: ${appointmentId}`);
            throw new Error('CANNOT_COMPLETE_CANCELED');
        }
        
        // 🛡️ GUARD 3: Busca pacote e verifica saldo
        const packageId = appointment.package?._id || appointment.package;
        let packageDoc = null;
        if (packageId) {
            const Package = (await import('../models/Package.js')).default;
            console.log(`[CompleteOrchestrator] Buscando package: ${packageId}`);
            packageDoc = await Package.findById(packageId);
            console.log(`[CompleteOrchestrator] Package encontrado: ${packageDoc ? 'SIM' : 'NÃO'}`);
            if (packageDoc && packageDoc.sessionsDone >= packageDoc.totalSessions) {
                console.log(`[CompleteOrchestrator] ❌ Pacote sem saldo: ${packageDoc._id}`);
                throw new Error('PACKAGE_EXHAUSTED');
            }
        }

        const sessionId = appointment.session?._id;
        // packageId já definido acima
        // packageDoc já declarado acima no GUARD 3
        console.log(`[CompleteOrchestrator] packageDoc: ${packageDoc ? 'encontrado' : 'null'}, paymentType: ${packageDoc?.paymentType}`);
        const isPerSession = packageDoc?.paymentType === 'per-session';
        const isConvenio = packageDoc?.type === 'convenio' || 
                          appointment.billingType === 'convenio' || 
                          appointment.insuranceGuide != null;
        const isLiminar = packageDoc?.type === 'liminar' || 
                         appointment.billingType === 'liminar' ||
                         appointment.paymentOrigin === 'liminar';
        console.log(`[CompleteOrchestrator] isPerSession: ${isPerSession}, isConvenio: ${isConvenio}, isLiminar: ${isLiminar}`);

        // Determina paymentOrigin (null para particular simples)
        let paymentOrigin = null;  // Evita erro de enum no Mongoose
        if (addToBalance) paymentOrigin = 'manual_balance';
        else if (isConvenio) paymentOrigin = 'convenio';
        else if (isLiminar) paymentOrigin = 'liminar';
        else if (isPerSession) paymentOrigin = 'auto_per_session';
        else if (packageId) paymentOrigin = 'package_prepaid';
        console.log(`[CompleteOrchestrator] paymentOrigin definido: ${paymentOrigin}`);

        // 1. CRIA PAYMENT FORA DA TRANSAÇÃO (evita write conflict e aborted transaction)
        let perSessionPayment = null;
        if (!addToBalance && !appointment.payment && isPerSession && packageId) {
            try {
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
                console.log('[CompleteOrchestrator] Payment criado FORA da transação:', perSessionPayment._id);
            } catch (innerErr) {
                console.error('[CompleteOrchestrator] ERRO na criação do payment:', innerErr.message);
                throw innerErr;
            }
        }

        // TRANSAÇÃO PRINCIPAL - apenas operações atômicas essenciais
        const mongoSession = await mongoose.startSession();

        try {
            await mongoSession.startTransaction({
                readConcern: { level: 'local' },
                writeConcern: { w: 'majority' }
            });

            // 1. CONSOME PACOTE (se houver e não for completed ainda)
            if (packageId && appointment.clinicalStatus !== 'completed') {
                await consumePackageSession(packageId, { mongoSession });
            }

            // 2. ATUALIZA PACKAGE FINANCEIRO (per-session)
            if (perSessionPayment && packageId) {
                console.log('[CompleteOrchestrator] Atualizando package financeiro...');
                await updatePackageFinancials(packageId, perSessionPayment.amount, mongoSession, packageDoc);
                console.log('[CompleteOrchestrator] Package atualizado');
            }

            // 3. ATUALIZA APPOINTMENT (única operação - inclui payment se houver)
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
            
            // Se temos payment per-session, inclui no update
            if (perSessionPayment) {
                appointmentUpdate.payment = perSessionPayment._id;
            }

            await Appointment.findByIdAndUpdate(
                appointmentId,
                appointmentUpdate,
                { session: mongoSession }
            );
            console.log('[CompleteOrchestrator] Appointment atualizado');

            // ✅ SALVA NO OUTBOX: APPOINTMENT_COMPLETED (dentro da transação)
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
            console.log('[CompleteOrchestrator] Evento APPOINTMENT_COMPLETED salvo no outbox');

            // ✅ SALVA NO OUTBOX: INVOICE_PER_SESSION_CREATE (dentro da transação - garante atomicidade)
            if (isPerSession && !isConvenio && !isLiminar && packageId) {
                const invoiceEventId = `INVOICE_PER_SESSION_CREATE_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                await saveToOutbox(
                    {
                        eventId: invoiceEventId,
                        correlationId: correlationId || invoiceEventId,
                        eventType: EventTypes.INVOICE_PER_SESSION_CREATE,
                        payload: {
                            patientId: appointment.patient?.toString(),
                            appointmentId: appointmentId.toString(),
                            sessionValue: packageDoc?.sessionValue || 0
                        },
                        aggregateType: 'invoice',
                        aggregateId: appointmentId.toString()
                    },
                    mongoSession
                );
                console.log('[CompleteOrchestrator] Evento INVOICE_PER_SESSION_CREATE salvo no outbox');
            }

            console.log('[CompleteOrchestrator] Commitando transação...');
            await mongoSession.commitTransaction();
            console.log('[CompleteOrchestrator] Transação commitada!');

        } catch (error) {
            console.error('[CompleteOrchestrator] ERRO na transação:', error.message);
            await mongoSession.abortTransaction();
            throw error;
        } finally {
            mongoSession.endSession();
        }
        
        // 4. COMPLETA SESSÃO FORA DA TRANSAÇÃO (não crítico)
        if (sessionId) {
            try {
                await completeSession(sessionId, {
                    addToBalance,
                    paymentOrigin,
                    correlationId
                });
            } catch (sessionErr) {
                console.warn('[CompleteOrchestrator] Erro ao completar sessão (não crítico):', sessionErr.message);
            }
        }

        // PÓS-COMMIT (não bloqueia resposta)

        // 5. CONFIRMA PAYMENT (fora da transação)
        if (perSessionPayment) {
            try {
                await confirmPayment(perSessionPayment._id);
            } catch (confirmErr) {
                console.error(`[CompleteOrchestrator] Falha ao confirmar payment:`, confirmErr.message);
                // Log crítico - inconsistência
            }
        }

        // 6. CONVÊNIO: Consome guia e cria payment
        const insuranceGuideId = packageDoc?.insuranceGuide || appointment.insuranceGuide;
        console.log(`[CompleteOrchestrator] Convênio check: isConvenio=${isConvenio}, insuranceGuideId=${insuranceGuideId}`);
        if (isConvenio && insuranceGuideId) {
            console.log(`[CompleteOrchestrator] Processando convênio...`);
            try {
                const consumeResult = await consumeInsuranceGuide(
                    insuranceGuideId,
                    sessionId
                );
                console.log(`[CompleteOrchestrator] consumeInsuranceGuide result:`, consumeResult);

                await createInsurancePayment({
                    patientId: appointment.patient?._id,
                    doctorId: appointment.doctor?._id,
                    appointmentId,
                    sessionId,
                    packageId,
                    guideId: insuranceGuideId,
                    insuranceProvider: packageDoc?.insuranceProvider || appointment.insuranceProvider,
                    insuranceValue: packageDoc?.insuranceGrossAmount || appointment.insuranceValue || 0,
                    correlationId
                });
            } catch (insuranceErr) {
                console.error(`[CompleteOrchestrator] Erro convênio:`, insuranceErr.message);
            }
        }

        // 7. LIMINAR: Reconhece receita
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
                console.error(`[CompleteOrchestrator] Erro liminar:`, liminarErr.message);
            }
        }

        // 8. FIADO: Publica evento de balance update
        if (addToBalance) {
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
        }

        console.log(`[CompleteOrchestrator] Complete concluído`, {
            appointmentId,
            paymentOrigin,
            addToBalance
        });

        log.info('completed', 'Complete concluído', {
            appointmentId,
            paymentOrigin,
            addToBalance
        });

        // ✅ SOLICITA RECÁLCULO DE TOTAIS (complete gera receita)
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

        return {
            status: 'completed',
            appointmentId,
            paymentOrigin,
            addToBalance,
            perSessionPaymentId: perSessionPayment?._id,
            idempotencyKey
        };
        
        }); // Fim do processWithGuarantees
        
        }, { ttl: 30 }); // Fim do withLock
        
        } catch (error) {
            console.error(`[CompleteOrchestrator] Job ${job.id} erro:`, error.message);
            throw error;
        }

    }, {
        connection: redisConnection,
        concurrency: 3
    });

    worker.on('completed', (job, result) => {
        console.log(`[CompleteOrchestrator] Job ${job.id}: ${result.status}`);
    });

    worker.on('failed', (job, error) => {
        console.error(`[CompleteOrchestrator] Job ${job?.id} falhou:`, error.message);
    });

    console.log('[CompleteOrchestrator] Worker iniciado');
    return worker;
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
        update.$set.paymentStatus = 'pending_balance';  // 🚀 Novo status específico para saldo devedor
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
