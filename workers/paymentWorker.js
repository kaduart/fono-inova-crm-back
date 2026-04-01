// workers/paymentWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
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
 * Payment Worker - Processa pagamentos com Saga Pattern
 * 
 * Responsabilidade:
 * - Criar registro de pagamento
 * - Processar cobrança (PIX, cartão, etc)
 * - Confirmar ou rejeitar
 * - COMPENSAÇÃO: se falhar → cancela agendamento
 * 
 * Saga Pattern:
 * SUCCESS: PAYMENT_REQUESTED → PAYMENT_CONFIRMED → APPOINTMENT_CONFIRMED
 * FAILURE: PAYMENT_REQUESTED → PAYMENT_FAILED → APPOINTMENT_CANCELLED (compensação)
 */

export function startPaymentWorker() {
    const worker = new Worker('payment-processing', async (job) => {
        const { eventId, eventType, correlationId, payload } = job.data;
        
        const log = createContextLogger(correlationId, 'payment_worker');
        
        log.info('processing_started', `Processando ${eventType}: ${eventId}`, {
            appointmentId: payload.appointmentId,
            amount: payload.amount,
            attempt: job.attemptsMade + 1
        });

        // Idempotência: verifica via EventStore
        const existingEvent = await EventStore.findOne({ eventId });
        if (existingEvent && existingEvent.status === 'processed') {
            log.info('already_processed', `Evento já processado: ${eventId}`);
            return { status: 'already_processed' };
        }

        // Idempotência via idempotencyKey se disponível
        const idempotencyKey = job.data.idempotencyKey || eventId;
        if (idempotencyKey && await eventExists(idempotencyKey)) {
            log.info('already_processed', `Evento com idempotencyKey já processado: ${idempotencyKey}`);
            return { status: 'already_processed' };
        }

        try {
            // Registra evento no Event Store
            await appendEvent({
                eventType: 'PAYMENT_CREATE_REQUESTED',
                aggregateType: 'payment',
                aggregateId: payload.appointmentId || eventId,
                payload: job.data,
                idempotencyKey,
                correlationId,
                metadata: {
                    source: 'payment_worker',
                    workerJobId: job.id
                }
            });

            // Wrapper com garantias de processamento
            const result = await processWithGuarantees(
                { eventId, eventType, correlationId, payload },
                async (event) => {
                    if (eventType === EventTypes.PAYMENT_REQUESTED) {
                        return await handlePaymentRequested(payload, eventId, correlationId, log);
                    } else if (eventType === EventTypes.PAYMENT_PROCESS_REQUESTED) {
                        return await handlePaymentProcessRequested(payload, eventId, correlationId, log);
                    } else if (eventType === EventTypes.PAYMENT_COMPLETED) {
                        return await handlePaymentConfirmed(payload, eventId, correlationId, log);
                    }
                    
                    throw new Error(`Tipo desconhecido: ${eventType}`);
                },
                'payment_worker'
            );

            return result.result;
            
        } catch (error) {
            log.error('processing_error', error.message, { eventId, eventType });
            
            if (job.attemptsMade >= 4) {
                await moveToDLQ(job, error);
            }
            
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

    console.log('[PaymentWorker] Worker iniciado (com Saga Pattern e Event Store)');
    return worker;
}

/**
 * Processa solicitação de pagamento
 * Saga: Step 1 → Cria pagamento e processa
 */
async function handlePaymentRequested(payload, eventId, correlationId, log) {
    const { 
        appointmentId, 
        patientId, 
        doctorId, 
        amount, 
        paymentMethod = 'pix',
        notes 
    } = payload;

    // 1. STATE GUARD: Verifica se agendamento existe e está pending
    const appointment = await Appointment.findById(appointmentId);
    
    if (!appointment) {
        throw new Error(`APPOINTMENT_NOT_FOUND: ${appointmentId}`);
    }

    if (appointment.operationalStatus === 'confirmed') {
        log.info('already_confirmed', `Agendamento ${appointmentId} já confirmado`);
        return { status: 'already_confirmed', appointmentId };
    }

    if (appointment.operationalStatus === 'rejected' || appointment.operationalStatus === 'canceled') {
        log.info('appointment_cancelled', `Agendamento ${appointmentId} já cancelado/rejeitado`);
        return { status: 'appointment_cancelled', appointmentId };
    }

    // 2. Verifica se já existe pagamento para este appointment (idempotência)
    const existingPayment = await Payment.findOne({ 
        appointment: appointmentId,
        status: { $in: ['paid', 'pending'] }
    });

    if (existingPayment) {
        log.info('payment_exists', `Pagamento já existe: ${existingPayment._id}`);
        return { 
            status: existingPayment.status === 'paid' ? 'already_paid' : 'already_pending',
            paymentId: existingPayment._id
        };
    }

    // 3. Cria registro de pagamento
    const payment = new Payment({
        patient: patientId,
        doctor: doctorId,
        appointment: appointmentId,
        amount,
        paymentMethod,
        status: 'pending', // Começa como pending
        correlationId,
        notes: notes || `Pagamento referente ao agendamento ${appointmentId}`,
        requestedAt: new Date()
    });

    await payment.save();
    log.info('payment_created', `Pagamento criado: ${payment._id}`);

    // 4. PROCESSA PAGAMENTO (simulação - aqui entra Sicoob/gateway)
    const paymentResult = await processPayment(payment, log);

    if (paymentResult.success) {
        // ✅ SAGA: Sucesso
        await confirmPaymentFlow(payment, appointment, correlationId, log);
        
        return {
            status: 'payment_confirmed',
            paymentId: payment._id,
            appointmentId,
            transactionId: paymentResult.transactionId
        };
    } else {
        // ❌ SAGA: Falha → Compensação
        await compensatePaymentFailure(payment, appointment, paymentResult.error, correlationId, log);
        
        return {
            status: 'payment_failed_compensated',
            paymentId: payment._id,
            appointmentId,
            error: paymentResult.error
        };
    }
}

/**
 * Processa pagamento múltiplo (payment-multi do saldo)
 * Usado para quitar múltiplos débitos de uma vez
 */
async function handlePaymentProcessRequested(payload, eventId, correlationId, log) {
    const {
        type,
        patientId,
        payments,
        debitIds,
        totalAmount,
        requestedBy
    } = payload;

    log.info('multi_payment_started', `Processando payment-multi: ${debitIds?.length || 0} débitos`, {
        patientId,
        totalAmount
    });

    // Se não for multi_payment, ignora
    if (type !== 'multi_payment') {
        log.warn('unknown_type', `Tipo desconhecido: ${type}`);
        return { status: 'ignored', reason: 'not_multi_payment' };
    }

    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();

        const now = new Date();
        const results = {
            paymentsCreated: [],
            debitsMarked: [],
            appointmentsUpdated: [],
            errors: []
        };

        // 1. Cria o Payment principal (consolidado)
        const mainPayment = new Payment({
            patient: patientId,
            amount: totalAmount,
            paymentMethod: payments[0]?.paymentMethod || 'dinheiro',
            status: 'paid',
            kind: 'multi_payment',
            notes: `Pagamento múltiplo: ${debitIds.length} débito(s) - Total: R$ ${totalAmount}`,
            correlationId,
            paidAt: now,
            createdAt: now
        });

        await mainPayment.save({ session: mongoSession });
        results.paymentsCreated.push(mainPayment._id);

        // 2. Atualiza PatientBalance (marca débitos como pagos)
        const PatientBalance = (await import('../models/PatientBalance.js')).default;
        
        const balanceUpdate = await PatientBalance.findOneAndUpdate(
            { 
                patient: patientId,
                'transactions._id': { $in: debitIds.map(id => new mongoose.Types.ObjectId(id)) }
            },
            {
                $set: {
                    'transactions.$[debit].isPaid': true,
                    'transactions.$[debit].paidAt': now,
                    'transactions.$[debit].paymentId': mainPayment._id
                },
                $inc: {
                    currentBalance: -totalAmount,
                    totalCredited: totalAmount
                },
                $push: {
                    transactions: {
                        type: 'payment',
                        amount: totalAmount,
                        description: `Pagamento múltiplo - ${debitIds.length} débito(s)`,
                        paymentMethod: payments[0]?.paymentMethod || 'dinheiro',
                        registeredBy: requestedBy,
                        createdAt: now
                    }
                }
            },
            {
                session: mongoSession,
                arrayFilters: [{ 
                    'debit._id': { $in: debitIds.map(id => new mongoose.Types.ObjectId(id)) },
                    'debit.type': 'debit'
                }],
                new: true
            }
        );

        if (!balanceUpdate) {
            throw new Error('BALANCE_UPDATE_FAILED');
        }

        results.debitsMarked = debitIds;

        // 3. Atualiza Appointments relacionados aos débitos
        const appointmentIds = [];
        for (const debitId of debitIds) {
            const debit = balanceUpdate.transactions.find(t => 
                t._id.toString() === debitId && t.type === 'debit'
            );
            if (debit?.appointmentId) {
                appointmentIds.push(debit.appointmentId);
            }
        }

        if (appointmentIds.length > 0) {
            await Appointment.updateMany(
                { _id: { $in: appointmentIds } },
                {
                    $set: {
                        paymentStatus: 'paid',
                        visualFlag: 'ok',
                        paidAt: now,
                        updatedAt: now
                    },
                    $push: {
                        history: {
                            action: 'multi_payment_received',
                            newStatus: 'paid',
                            timestamp: now,
                            context: `Pagamento múltiplo: ${mainPayment._id}`
                        }
                    }
                },
                { session: mongoSession }
            );
            results.appointmentsUpdated = appointmentIds;
        }

        await mongoSession.commitTransaction();

        log.info('multi_payment_completed', `Payment-multi concluído: ${mainPayment._id}`, {
            paymentId: mainPayment._id,
            debitsCount: debitIds.length,
            appointmentsCount: appointmentIds.length
        });

        // 4. Publica eventos de resultado
        await publishEvent(
            EventTypes.PAYMENT_COMPLETED,
            {
                paymentId: mainPayment._id.toString(),
                patientId: patientId.toString(),
                amount: totalAmount,
                type: 'multi_payment',
                debitsCount: debitIds.length,
                appointmentsCount: appointmentIds.length
            },
            { correlationId }
        );

        // 4.1 Solicita recálculo de totais (snapshot ficará stale)
        await publishEvent(
            EventTypes.TOTALS_RECALCULATE_REQUESTED,
            {
                clinicId: null, // Todos os clinicos
                date: new Date().toISOString().split('T')[0],
                period: 'month',
                reason: 'payment_multi_completed',
                triggeredBy: 'payment_worker'
            },
            { correlationId }
        );

        // 5. Notificação
        await publishEvent(
            EventTypes.NOTIFICATION_REQUESTED,
            {
                type: 'PAYMENT_CONFIRMED',
                patientId: patientId.toString(),
                amount: totalAmount,
                message: `Pagamento de R$ ${totalAmount} confirmado (${debitIds.length} débito(s) quitados)`
            },
            { correlationId }
        );

        return {
            status: 'multi_payment_completed',
            paymentId: mainPayment._id,
            amount: totalAmount,
            debitsCount: debitIds.length,
            appointmentsUpdated: appointmentIds.length
        };

    } catch (error) {
        await mongoSession.abortTransaction();
        log.error('multi_payment_error', `Erro no payment-multi: ${error.message}`);
        
        // Publica evento de falha
        await publishEvent(
            EventTypes.PAYMENT_FAILED,
            {
                patientId: patientId.toString(),
                amount: totalAmount,
                error: error.message,
                type: 'multi_payment'
            },
            { correlationId }
        );
        
        throw error;
    } finally {
        mongoSession.endSession();
    }
}

/**
 * Processa pagamento (integração com gateway)
 * TODO: Substituir por integração real com Sicoob
 */
async function processPayment(payment, log) {
    log.debug('processing_payment', `Processando pagamento ${payment._id}...`);
    
    // Simulação: 90% sucesso, 10% falha (para testar compensação)
    const shouldFail = Math.random() < 0.1;
    
    if (shouldFail && process.env.NODE_ENV === 'development') {
        return {
            success: false,
            error: 'INSUFFICIENT_FUNDS',
            message: 'Saldo insuficiente (simulação)'
        };
    }
    
    // Aqui entraria a integração real:
    // - Gerar QR Code PIX
    // - Aguardar webhook de confirmação
    // - Ou processar cartão
    
    // Simula delay de processamento
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return {
        success: true,
        transactionId: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
}

/**
 * SAGA: Fluxo de sucesso
 * Confirma pagamento e agendamento
 */
async function confirmPaymentFlow(payment, appointment, correlationId, log) {
    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();
        
        // 1. Atualiza pagamento para 'paid'
        await Payment.findByIdAndUpdate(payment._id, {
            status: 'paid',
            paidAt: new Date(),
            confirmedAt: new Date()
        }, { session: mongoSession });
        
        // 2. Confirma agendamento
        await Appointment.findByIdAndUpdate(appointment._id, {
            operationalStatus: 'scheduled',
            paymentStatus: 'paid',
            payment: payment._id,
            confirmedAt: new Date(),
            $push: {
                history: {
                    action: 'payment_confirmed',
                    newStatus: 'scheduled',
                    timestamp: new Date(),
                    context: `Pagamento ${payment._id} confirmado`
                }
            }
        }, { session: mongoSession });
        
        await mongoSession.commitTransaction();
        
        log.info('payment_confirmed', `Pagamento ${payment._id} confirmado, agendamento ${appointment._id} ativado`);
        
        // 3. Publica evento de sucesso
        await publishEvent(
            EventTypes.PAYMENT_COMPLETED,
            {
                paymentId: payment._id.toString(),
                appointmentId: appointment._id.toString(),
                patientId: payment.patient?.toString(),
                amount: payment.amount,
                paymentMethod: payment.paymentMethod
            },
            { correlationId }
        );

        // 3.1 Solicita recálculo de totais
        await publishEvent(
            EventTypes.TOTALS_RECALCULATE_REQUESTED,
            {
                clinicId: appointment.clinicId,
                date: new Date().toISOString().split('T')[0],
                period: 'month',
                reason: 'payment_confirmed',
                triggeredBy: 'payment_worker'
            },
            { correlationId }
        );
        
        // 4. Notificação
        await publishEvent(
            EventTypes.NOTIFICATION_REQUESTED,
            {
                type: 'PAYMENT_CONFIRMED',
                patientId: payment.patient?.toString(),
                appointmentId: appointment._id.toString(),
                amount: payment.amount,
                channels: ['whatsapp', 'email']
            },
            { correlationId, delay: 2000 }
        );
        
    } catch (error) {
        await mongoSession.abortTransaction();
        throw error;
    } finally {
        mongoSession.endSession();
    }
}

/**
 * SAGA: Compensação por falha
 * Cancela pagamento e agendamento
 */
async function compensatePaymentFailure(payment, appointment, error, correlationId, log) {
    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();
        
        // 1. Marca pagamento como falho
        await Payment.findByIdAndUpdate(payment._id, {
            status: 'failed',
            failedAt: new Date(),
            failureReason: error,
            $push: {
                history: {
                    action: 'payment_failed',
                    error,
                    timestamp: new Date()
                }
            }
        }, { session: mongoSession });
        
        // 2. COMPENSAÇÃO: Cancela agendamento
        await Appointment.findByIdAndUpdate(appointment._id, {
            operationalStatus: 'rejected',
            paymentStatus: 'canceled',
            rejectionReason: 'PAYMENT_FAILED',
            rejectionDetails: { paymentId: payment._id, error },
            $push: {
                history: {
                    action: 'appointment_rejected',
                    newStatus: 'rejected',
                    timestamp: new Date(),
                    context: `Compensação: pagamento falhou - ${error}`
                }
            }
        }, { session: mongoSession });
        
        await mongoSession.commitTransaction();
        
        log.info('compensation_executed', `Compensação executada: agendamento ${appointment._id} cancelado (pagamento falhou)`);
        
        // 3. Publica evento de compensação
        await publishEvent(
            EventTypes.PAYMENT_FAILED,
            {
                paymentId: payment._id.toString(),
                appointmentId: appointment._id.toString(),
                patientId: payment.patient?.toString(),
                amount: payment.amount,
                error,
                compensationAction: 'APPOINTMENT_CANCELLED'
            },
            { correlationId }
        );
        
        // 4. Notificação de falha
        await publishEvent(
            EventTypes.NOTIFICATION_REQUESTED,
            {
                type: 'PAYMENT_FAILED',
                patientId: payment.patient?.toString(),
                appointmentId: appointment._id.toString(),
                error,
                channels: ['whatsapp'],
                message: 'Seu pagamento não foi aprovado. O agendamento foi cancelado.'
            },
            { correlationId }
        );
        
    } catch (compensationError) {
        await mongoSession.abortTransaction();
        log.error('compensation_error', `ERRO NA COMPENSAÇÃO: ${compensationError.message}`);
        // Aqui deveria alertar o time (PagerDuty, etc)
        throw compensationError;
    } finally {
        mongoSession.endSession();
    }
}

/**
 * Handler para confirmação externa (webhook)
 * Usado quando o pagamento é confirmado por webhook (ex: Sicoob)
 */
async function handlePaymentConfirmed(payload, eventId, correlationId, log) {
    const { paymentId, transactionId } = payload;
    
    const payment = await Payment.findById(paymentId);
    if (!payment) {
        throw new Error(`PAYMENT_NOT_FOUND: ${paymentId}`);
    }
    
    // Já está confirmado?
    if (payment.status === 'paid') {
        return { status: 'already_confirmed', paymentId };
    }
    
    // Atualiza com dados da transação
    await Payment.findByIdAndUpdate(paymentId, {
        status: 'paid',
        paidAt: new Date(),
        confirmedAt: new Date(),
        transactionId,
        $push: {
            history: {
                action: 'confirmed_via_webhook',
                transactionId,
                timestamp: new Date()
            }
        }
    });
    
    // Confirma agendamento
    await Appointment.findByIdAndUpdate(payment.appointment, {
        operationalStatus: 'scheduled',
        paymentStatus: 'paid'
    });
    
    log.info('confirmed_via_webhook', `Pagamento ${paymentId} confirmado via webhook`);
    
    return { status: 'confirmed_via_webhook', paymentId };
}
