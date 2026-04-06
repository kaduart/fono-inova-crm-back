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
import { withLock } from '../utils/redisLock.js';

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
        paymentMethod: rawMethod = 'pix',
        notes 
    } = payload;
    
    // Mapear método de pagamento para valores do schema
    const methodMap = {
        'dinheiro': 'cash',
        'pix': 'pix',
        'credit_card': 'credit_card',
        'debit_card': 'debit_card',
        'cartao': 'credit_card',
        'cartão': 'credit_card',
        'transferencia': 'bank_transfer',
        'transferência': 'bank_transfer',
        'cash': 'cash'
    };
    const paymentMethod = methodMap[rawMethod] || 'pix';

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
        appointmentId: appointmentId,
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
        patientId: patientId,
        appointmentId: appointmentId,
        amount,
        paymentMethod,
        paymentDate: payload.paymentDate ? new Date(payload.paymentDate) : new Date(),
        status: 'pending',
        source: 'appointment',
        description: notes || `Pagamento referente ao agendamento ${appointmentId}`
    });

    try {
        await payment.save();
        log.info('payment_created', `Pagamento criado: ${payment._id}`);

        // 🔗 LINKA payment ao appointment para que completeOrchestratorWorker encontre via existingPayment
        await Appointment.findByIdAndUpdate(appointmentId, { payment: payment._id });

        // 🔄 ATUALIZA PAYMENTSVIEW (projection para tela de pagamentos)
        try {
            const { handlePaymentEvent } = await import('../projections/paymentsProjection.js');
            await handlePaymentEvent({
                type: 'PAYMENT_CREATED',
                payload: { paymentId: payment._id.toString() },
                timestamp: new Date()
            });
            log.info('payment_projection_updated', `PaymentsView atualizada para ${payment._id}`);
        } catch (projError) {
            log.error('payment_projection_error', 'Erro ao atualizar PaymentsView', { error: projError.message });
            // Não falha o worker se a projection falhar
        }
    } catch (error) {
        // 🛡️ IDEMPOTÊNCIA: Trata race condition - índice único violado
        if (error.code === 11000) {
            log.info('payment_duplicate_prevented', `Pagamento duplicado evitado pelo índice único para appointment ${appointmentId}`);
            const dupPayment = await Payment.findOne({ appointmentId: appointmentId });
            return {
                status: 'already_exists',
                paymentId: dupPayment?._id,
                appointmentId
            };
        }
        throw error; // Re-lança outros erros
    }

    // 4. Payment criado como pending — confirmação ocorre no completeOrchestratorWorker
    log.info('payment_pending', `Payment ${payment._id} criado como pending, aguarda COMPLETE`);

    return {
        status: 'payment_created_pending',
        paymentId: payment._id,
        appointmentId
    };
}

/**
 * Processa recebimento de pagamento (PAYMENT_PROCESS_REQUESTED)
 * 
 * 🎯 MODELO V2 CORRETO:
 * - PAYMENT_REQUESTED → cria Payment (produção gerada)
 * - PAYMENT_PROCESS_REQUESTED → registra recebimento (entrada de dinheiro)
 * 
 * Fluxos:
 * 1. Pagamento único (appointmentId): atualiza Payment existente
 * 2. Multi-payment (type='multi_payment'): cria Payment consolidado para saldo
 */
async function handlePaymentProcessRequested(payload, eventId, correlationId, log) {
    const {
        type,
        patientId,
        appointmentId,
        amount,
        paymentMethod: rawMethod = 'dinheiro',
        notes,
        payments,
        debitIds,
        totalAmount,
        requestedBy,
        isMultiPayment
    } = payload;
    
    // Mapear método de pagamento para valores do schema
    const methodMap = {
        'dinheiro': 'cash',
        'pix': 'pix',
        'credit_card': 'credit_card',
        'debit_card': 'debit_card',
        'cartao': 'credit_card',
        'cartão': 'credit_card',
        'transferencia': 'bank_transfer',
        'transferência': 'bank_transfer'
    };
    const paymentMethod = methodMap[rawMethod] || 'cash';

    // 🎯 FLUXO 1: Multi-payment (saldo/débitos)
    if (type === 'multi_payment' || isMultiPayment) {
        log.info('multi_payment_started', `Processando payment-multi: ${debitIds?.length || 0} débitos`, {
            patientId,
            totalAmount
        });

        // 🔒 LOCK: Evita race condition em payment-multi do mesmo paciente
        return await withLock(`payment-multi:${patientId}`, async () => {
            return await processMultiPayment(payload, eventId, correlationId, log);
        }, { ttl: 60 });
    }

    // 🎯 FLUXO 2: Pagamento único (recebimento de appointment)
    if (appointmentId) {
        log.info('single_payment_started', `Processando recebimento para appointment ${appointmentId}`, {
            patientId,
            amount,
            paymentMethod
        });

        return await processSinglePayment(payload, eventId, correlationId, log);
    }

    log.warn('unknown_payment_type', 'Tipo de pagamento não reconhecido', { type, appointmentId, isMultiPayment });
    return { status: 'ignored', reason: 'unknown_payment_type' };
}

async function processMultiPayment(payload, eventId, correlationId, log) {
    const {
        type,
        patientId,
        payments,
        debitIds,
        totalAmount,
        requestedBy
    } = payload;

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
        // Mapear método de pagamento do array payments
        const rawMethod = payments[0]?.paymentMethod || 'cash';
        const methodMap = {
            'dinheiro': 'cash', 'pix': 'pix', 'credit_card': 'credit_card', 'debit_card': 'debit_card',
            'cartao': 'credit_card', 'cartão': 'credit_card', 'transferencia': 'bank_transfer', 'transferência': 'bank_transfer'
        };
        const mappedMethod = methodMap[rawMethod] || rawMethod;
        
        const mainPayment = new Payment({
            patientId: patientId,
            amount: totalAmount,
            paymentMethod: mappedMethod,
            paymentDate: now,
            status: 'paid',
            source: 'manual',
            description: `Pagamento múltiplo: ${debitIds.length} débito(s) - Total: R$ ${totalAmount}`
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
 * Processa pagamento único (recebimento de appointment)
 * 🎯 FLUXO V2 CORRETO:
 * 1. Busca Payment existente (criado por PAYMENT_REQUESTED)
 * 2. Registra recebimento (atualiza receivedAmount ATOMICAMENTE)
 * 3. Atualiza status conforme regra de negócio
 * 4. Atualiza Appointment.paymentStatus
 * 
 * 🛡️ CONCORRÊNCIA: Usa $inc para evitar race conditions
 */
async function processSinglePayment(payload, eventId, correlationId, log) {
    const {
        appointmentId,
        patientId,
        amount,
        paymentMethod: rawMethod = 'dinheiro',
        notes,
        requestedBy
    } = payload;
    
    // Mapear método de pagamento para valores do schema
    const methodMap = {
        'dinheiro': 'cash',
        'pix': 'pix',
        'credit_card': 'credit_card',
        'debit_card': 'debit_card',
        'cartao': 'credit_card',
        'cartão': 'credit_card',
        'transferencia': 'bank_transfer',
        'transferência': 'bank_transfer'
    };
    const paymentMethod = methodMap[rawMethod] || 'cash';

    // 🛡️ VALIDAÇÃO: Verifica se payment existe e não está cancelado/pago
    const paymentBefore = await Payment.findOne({
        appointmentId: appointmentId,
        status: { $nin: ['cancelled', 'paid'] }
    });

    if (!paymentBefore) {
        // Verifica se existe mas já está pago
        const alreadyPaid = await Payment.findOne({
            appointmentId: appointmentId,
            status: 'paid'
        });

        if (alreadyPaid) {
            log.info('payment_already_paid', `Payment ${alreadyPaid._id} já está quitado`);
            return { 
                status: 'already_paid', 
                paymentId: alreadyPaid._id,
                receivedAmount: alreadyPaid.receivedAmount,
                amount: alreadyPaid.amount
            };
        }

        log.error('payment_not_found', `Payment não encontrado para appointment ${appointmentId}`);
        return { 
            status: 'error', 
            error: 'PAYMENT_NOT_FOUND',
            message: 'Pagamento não encontrado ou cancelado.'
        };
    }

    const mongoSession = await mongoose.startSession();
    
    try {
        await mongoSession.startTransaction();

        // 🚀 OPERAÇÃO ATÔMICA: Incrementa receivedAmount (thread-safe)
        const updated = await Payment.findOneAndUpdate(
            { 
                _id: paymentBefore._id,
                status: { $ne: 'paid' } // Garante que não foi pago por outro processo
            },
            {
                $inc: { receivedAmount: amount }
            },
            { 
                new: true, // Retorna documento atualizado
                session: mongoSession 
            }
        );

        if (!updated) {
            // Outro processo pagou enquanto validávamos
            await mongoSession.abortTransaction();
            log.warn('concurrent_payment', `Pagamento concorrente detectado para ${paymentBefore._id}`);
            return {
                status: 'concurrent_update',
                message: 'Pagamento foi atualizado por outro processo'
            };
        }

        // 2. Determina novo status baseado no valor ATUALIZADO
        const isFullyPaid = updated.receivedAmount >= updated.amount;
        const isPartial = updated.receivedAmount > 0 && !isFullyPaid;
        const newStatus = isFullyPaid ? 'paid' : (isPartial ? 'partial' : 'pending');

        // 3. Atualiza status e metadados (apenas se mudou)
        if (newStatus !== updated.status || isFullyPaid) {
            const updateFields = { status: newStatus };
            if (isFullyPaid) {
                updateFields.paidAt = new Date();
                updateFields.paymentMethod = paymentMethod;
            }
            if (notes) {
                updateFields.notes = updated.notes 
                    ? `${updated.notes} | ${notes}` 
                    : notes;
            }

            await Payment.updateOne(
                { _id: updated._id },
                { $set: updateFields },
                { session: mongoSession }
            );
        }

        // 4. Atualiza Appointment
        await Appointment.findByIdAndUpdate(
            appointmentId,
            {
                $set: {
                    paymentStatus: newStatus,
                    paidAt: isFullyPaid ? new Date() : undefined,
                    updatedAt: new Date()
                },
                $push: {
                    history: {
                        action: isFullyPaid ? 'payment_received_full' : 'payment_received_partial',
                        timestamp: new Date(),
                        amount: amount,
                        receivedTotal: updated.receivedAmount,
                        context: `Recebimento via ${paymentMethod}`
                    }
                }
            },
            { session: mongoSession }
        );

        await mongoSession.commitTransaction();

        log.info('payment_received', `Recebimento registrado: ${amount} (total: ${updated.receivedAmount}/${updated.amount})`, {
            paymentId: updated._id,
            appointmentId,
            status: newStatus
        });
        
        // 🔄 ATUALIZA PAYMENTSVIEW (projection para tela de pagamentos)
        try {
            const { handlePaymentEvent } = await import('../projections/paymentsProjection.js');
            await handlePaymentEvent({
                type: 'PAYMENT_UPDATED',
                payload: { paymentId: updated._id.toString() },
                timestamp: new Date()
            });
        } catch (projError) {
            log.error('payment_projection_error', 'Erro ao atualizar PaymentsView', { error: projError.message });
        }

        // 5. Publica eventos (para PaymentStore frontend e outros consumidores)
        await publishEvent(
            EventTypes.PAYMENT_RECEIVED,
            {
                paymentId: updated._id.toString(),
                appointmentId: appointmentId.toString(),
                patientId: patientId?.toString(),
                amountReceived: amount,
                receivedTotal: updated.receivedAmount,
                amountDue: updated.amount,
                status: newStatus,
                paymentMethod
            },
            { correlationId }
        );

        if (isFullyPaid) {
            await publishEvent(
                EventTypes.PAYMENT_COMPLETED,
                {
                    paymentId: updated._id.toString(),
                    appointmentId: appointmentId.toString(),
                    patientId: patientId?.toString(),
                    amount: updated.amount,
                    paymentMethod
                },
                { correlationId }
            );
        }

        return {
            status: newStatus,
            paymentId: updated._id,
            appointmentId,
            amountReceived: amount,
            receivedTotal: updated.receivedAmount,
            amountDue: updated.amount,
            remaining: Math.max(0, updated.amount - updated.receivedAmount)
        };

    } catch (error) {
        await mongoSession.abortTransaction();
        log.error('single_payment_error', `Erro no recebimento: ${error.message}`);
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
        log.error('compensation_error', `🚨🚨🚨 CRITICAL: Compensação falhou`, {
            error: compensationError.message,
            paymentId: payment._id,
            appointmentId: appointment._id,
            patientId: payment.patient
        });
        
        // 🚨 ALERTA CRÍTICO: Publica evento para monitoramento
        await publishEvent(
            'CRITICAL_ERROR',
            {
                type: 'PAYMENT_COMPENSATION_FAILED',
                severity: 'critical',
                paymentId: payment._id.toString(),
                appointmentId: appointment._id.toString(),
                patientId: payment.patient?.toString(),
                error: compensationError.message,
                timestamp: new Date().toISOString()
            },
            { correlationId }
        ).catch(err => {
            // Se falhar publicar, loga mas não quebra
            console.error('🚨 Falha ao publicar alerta crítico:', err.message);
        });
        
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
