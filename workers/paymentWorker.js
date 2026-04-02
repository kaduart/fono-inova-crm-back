// workers/paymentWorkerWithRules.js
// V2 COM TODAS AS REGRAS DE NEGÓCIO DA V1

import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Patient from '../models/Patient.js';
import Doctor from '../models/Doctor.js';
import Package from '../models/Package.js';
import Session from '../models/Session.js';
import PatientBalance from '../models/PatientBalance.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import mongoose from 'mongoose';
import { 
    eventExists, 
    processWithGuarantees, 
    appendEvent 
} from '../infrastructure/events/eventStoreService.js';
import EventStore from '../models/EventStore.js';
import { createContextLogger } from '../utils/logger.js';
import { distributePayments } from '../services/distributePayments.js';

export function startPaymentWorker() {
    const worker = new Worker('payment-processing', async (job) => {
        const { eventId, eventType, correlationId, payload } = job.data;
        
        const log = createContextLogger(correlationId, 'payment_worker');
        
        log.info('processing_started', `Processando ${eventType}: ${eventId}`, {
            patientId: payload.patientId,
            amount: payload.amount,
            attempt: job.attemptsMade + 1
        });

        // Idempotência
        const existingEvent = await EventStore.findOne({ eventId });
        if (existingEvent && existingEvent.status === 'processed') {
            log.info('already_processed', `Evento já processado: ${eventId}`);
            return { status: 'already_processed' };
        }

        try {
            await appendEvent({
                eventType: 'PAYMENT_CREATE_REQUESTED',
                aggregateType: 'payment',
                aggregateId: payload.patientId || eventId,
                payload: job.data,
                correlationId,
                metadata: { source: 'payment_worker', workerJobId: job.id }
            });

            const result = await processWithGuarantees(
                { eventId, eventType, correlationId, payload },
                async (event) => {
                    if (eventType === EventTypes.PAYMENT_REQUESTED) {
                        return await handlePaymentWithAllRules(payload, eventId, correlationId, log);
                    } else if (eventType === EventTypes.PAYMENT_PROCESS_REQUESTED) {
                        return await handlePaymentProcessRequested(payload, eventId, correlationId, log);
                    }
                    throw new Error(`Tipo desconhecido: ${eventType}`);
                },
                'payment_worker'
            );

            return result.result;
            
        } catch (error) {
            log.error('processing_error', error.message, { eventId, eventType });
            if (job.attemptsMade >= 4) await moveToDLQ(job, error);
            throw error;
        }
        
    }, {
        connection: redisConnection,
        concurrency: 3
    });

    worker.on('completed', (job, result) => {
        const log = createContextLogger(job.data.correlationId, 'payment_worker');
        log.info('job_completed', `Job ${job.id}: ${result?.status}`, result);
    });

    worker.on('failed', (job, error) => {
        const log = createContextLogger(job?.data?.correlationId, 'payment_worker');
        log.error('job_failed', `Job ${job?.id} falhou: ${error.message}`);
    });

    console.log('[PaymentWorker] Worker iniciado com TODAS as regras de negócio V1');
    return worker;
}

/**
 * Handler principal com TODAS as regras de negócio da V1
 */
async function handlePaymentWithAllRules(payload, eventId, correlationId, log) {
    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();
        
        const {
            patientId,
            doctorId,
            serviceType,
            amount,
            paymentMethod,
            status,
            notes,
            packageId,
            paymentDate,
            sessionType,
            sessionId,
            isAdvancePayment = false,
            advanceSessions = [],
            appointmentId
        } = payload;

        // ═══════════════════════════════════════════════════════════════
        // 1. VALIDAÇÕES BÁSICAS (da V1)
        // ═══════════════════════════════════════════════════════════════
        
        if (!patientId || !doctorId || !sessionType || !amount || !paymentMethod) {
            throw new Error('VALIDATION_ERROR: Campos obrigatórios faltando');
        }

        if (amount <= 0) {
            throw new Error('VALIDATION_ERROR: Valor deve ser maior que zero');
        }

        // ═══════════════════════════════════════════════════════════════
        // 2. VERIFICAÇÃO DE EXISTÊNCIA (da V1)
        // ═══════════════════════════════════════════════════════════════
        
        const patientExists = await Patient.exists({ _id: patientId });
        if (!patientExists) {
            throw new Error('PATIENT_NOT_FOUND: Paciente não encontrado');
        }

        const doctorExists = await Doctor.exists({ _id: doctorId });
        if (!doctorExists) {
            throw new Error('DOCTOR_NOT_FOUND: Médico não encontrado');
        }

        // ═══════════════════════════════════════════════════════════════
        // 3. VALIDAÇÃO POR TIPO DE SERVIÇO (da V1)
        // ═══════════════════════════════════════════════════════════════
        
        if (serviceType === 'package_session' && !packageId) {
            throw new Error('VALIDATION_ERROR: ID do pacote é obrigatório para pagamentos de pacote');
        }

        if (serviceType === 'package_session') {
            const packageExists = await Package.exists({ _id: packageId });
            if (!packageExists) {
                throw new Error('PACKAGE_NOT_FOUND: Pacote não encontrado');
            }
        }

        if (serviceType === 'session' && !sessionId) {
            throw new Error('VALIDATION_ERROR: ID da sessão é obrigatório para serviço do tipo "session"');
        }

        if (serviceType === 'session') {
            const sessionExists = await Session.exists({ _id: sessionId });
            if (!sessionExists) {
                throw new Error('SESSION_NOT_FOUND: Sessão não encontrada');
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // 4. CRIAÇÃO DE SESSÃO INDIVIDUAL (da V1)
        // ═══════════════════════════════════════════════════════════════
        
        let individualSessionId = null;
        if (serviceType === 'individual_session') {
            const newSession = await Session.create([{
                serviceType,
                patient: patientId,
                doctor: doctorId,
                notes,
                package: null,
                sessionType,
                createdAt: new Date(),
                updatedAt: new Date()
            }], { session: mongoSession });
            individualSessionId = newSession[0]._id;
            log.info('session_created', `Sessão individual criada: ${individualSessionId}`);
        }

        // ═══════════════════════════════════════════════════════════════
        // 5. CRIAÇÃO DE SESSÕES FUTURAS (Advance Payment - da V1)
        // ═══════════════════════════════════════════════════════════════
        
        let advanceSessionsIds = [];
        if (advanceSessions.length > 0) {
            for (const session of advanceSessions) {
                const newSession = await Session.create([{
                    date: session.date,
                    time: session.time,
                    sessionType: session.sessionType,
                    patient: patientId,
                    doctor: doctorId,
                    status: 'scheduled',
                    isPaid: true,
                    paymentMethod: paymentMethod,
                    isAdvance: true,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }], { session: mongoSession });
                advanceSessionsIds.push(newSession[0]._id);
            }
            log.info('advance_sessions_created', `${advanceSessionsIds.length} sessões futuras criadas`);
        }

        // ═══════════════════════════════════════════════════════════════
        // 6. CRIAÇÃO DO PAGAMENTO (da V1)
        // ═══════════════════════════════════════════════════════════════
        
        const currentDate = new Date();
        const paymentData = {
            patient: patientId,
            doctor: doctorId,
            serviceType,
            amount,
            paymentMethod,
            notes,
            status: status || 'paid',
            createdAt: currentDate,
            updatedAt: currentDate,
            sessionType,
            coveredSessions: advanceSessionsIds.map(id => ({
                sessionId: id,
                used: false,
                scheduledDate: advanceSessions.find(s => s.sessionId === id.toString())?.date
            })),
            isAdvance: advanceSessions.length > 0,
            eventId,
            correlationId
        };

        // Adiciona campos condicionais
        if (serviceType === 'session') {
            paymentData.session = sessionId;
        } else if (serviceType === 'individual_session') {
            paymentData.session = individualSessionId;
        } else if (serviceType === 'package_session') {
            paymentData.package = packageId;
        }

        if (appointmentId) {
            paymentData.appointment = appointmentId;
        }

        const [payment] = await Payment.create([paymentData], { session: mongoSession });
        log.info('payment_created', `Pagamento criado: ${payment._id}`, { amount, serviceType });

        // ═══════════════════════════════════════════════════════════════
        // 7. ATUALIZAÇÃO DE STATUS DA SESSÃO (da V1)
        // ═══════════════════════════════════════════════════════════════
        
        if (serviceType === 'session' || serviceType === 'individual_session') {
            const sessionToUpdate = serviceType === 'individual_session' ? individualSessionId : sessionId;
            await Session.findByIdAndUpdate(
                sessionToUpdate,
                { 
                    $set: { 
                        status: 'completed',
                        paymentStatus: 'paid',
                        paidAt: new Date()
                    }
                },
                { session: mongoSession }
            );
            log.info('session_updated', `Sessão ${sessionToUpdate} marcada como paga`);
        }

        // ═══════════════════════════════════════════════════════════════
        // 8. ATUALIZAÇÃO DO APPOINTMENT (da V1)
        // ═══════════════════════════════════════════════════════════════
        
        if (appointmentId) {
            await Appointment.findByIdAndUpdate(
                appointmentId,
                {
                    $set: {
                        operationalStatus: 'confirmed',
                        paymentStatus: 'paid',
                        payment: payment._id
                    },
                    $push: {
                        history: {
                            action: 'payment_confirmed',
                            newStatus: 'confirmed',
                            timestamp: new Date(),
                            context: `Pagamento ${payment._id} confirmado`
                        }
                    }
                },
                { session: mongoSession }
            );
            log.info('appointment_updated', `Appointment ${appointmentId} atualizado`);
        }

        // ═══════════════════════════════════════════════════════════════
        // 9. ATUALIZAÇÃO DE PACOTE (da V1)
        // ═══════════════════════════════════════════════════════════════
        
        if (serviceType === 'package_session' && packageId) {
            await Package.findByIdAndUpdate(
                packageId,
                {
                    $inc: { sessionsDone: 1 },
                    $push: {
                        payments: {
                            paymentId: payment._id,
                            amount: amount,
                            date: new Date()
                        }
                    }
                },
                { session: mongoSession }
            );
            log.info('package_updated', `Pacote ${packageId} atualizado`);
        }

        // ═══════════════════════════════════════════════════════════════
        // 10. COMMIT DA TRANSAÇÃO
        // ═══════════════════════════════════════════════════════════════
        
        await mongoSession.commitTransaction();
        
        // ═══════════════════════════════════════════════════════════════
        // 11. PUBLICAR EVENTO DE SUCESSO
        // ═══════════════════════════════════════════════════════════════
        
        await publishEvent(
            EventTypes.PAYMENT_COMPLETED,
            {
                paymentId: payment._id,
                patientId,
                doctorId,
                amount,
                serviceType,
                appointmentId,
                sessionsCreated: advanceSessionsIds.length
            },
            {
                correlationId,
                aggregateType: 'payment',
                aggregateId: payment._id
            }
        );

        return {
            status: 'payment_created',
            paymentId: payment._id,
            patientId,
            doctorId,
            amount,
            sessionsCreated: advanceSessionsIds.length,
            sessionId: individualSessionId || sessionId
        };
        
    } catch (error) {
        await mongoSession.abortTransaction();
        log.error('payment_failed', error.message, { error: error.stack });
        throw error;
    } finally {
        mongoSession.endSession();
    }
}

/**
 * Processa pagamento múltiplo (payment-multi)
 */
async function handlePaymentProcessRequested(payload, eventId, correlationId, log) {
    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();

        const { type, patientId, payments, debitIds, totalAmount } = payload;

        if (type !== 'multi_payment') {
            return { status: 'ignored', reason: 'not_multi_payment' };
        }

        // Validações
        if (!patientId || !payments?.length || !debitIds?.length) {
            throw new Error('VALIDATION_ERROR: Dados incompletos para payment-multi');
        }

        // Cria pagamento principal
        const [mainPayment] = await Payment.create([{
            patient: patientId,
            amount: totalAmount,
            paymentMethod: payments[0]?.paymentMethod || 'dinheiro',
            status: 'paid',
            type: 'multi_payment',
            debitIds,
            eventId,
            correlationId
        }], { session: mongoSession });

        // Atualiza PatientBalance
        await PatientBalance.updateOne(
            { patient: patientId },
            {
                $inc: { 
                    currentBalance: -totalAmount,
                    totalCredited: totalAmount
                },
                $push: {
                    transactions: {
                        type: 'payment',
                        amount: totalAmount,
                        description: `Pagamento múltiplo: ${debitIds.length} débitos`,
                        paymentId: mainPayment._id,
                        transactionDate: new Date()
                    }
                }
            },
            { session: mongoSession }
        );

        await mongoSession.commitTransaction();

        await publishEvent(
            EventTypes.PAYMENT_COMPLETED,
            {
                paymentId: mainPayment._id,
                patientId,
                amount: totalAmount,
                type: 'multi_payment',
                debitsPaid: debitIds.length
            },
            { correlationId, aggregateType: 'payment', aggregateId: mainPayment._id }
        );

        return {
            status: 'multi_payment_created',
            paymentId: mainPayment._id,
            debitsPaid: debitIds.length
        };
        
    } catch (error) {
        await mongoSession.abortTransaction();
        throw error;
    } finally {
        mongoSession.endSession();
    }
}
