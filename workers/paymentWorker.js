// workers/paymentWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ } from '../infrastructure/queue/queueConfig.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import moment from 'moment-timezone';
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
import { transitionPaymentStatus } from '../services/paymentStatusService.js';
import { invalidateDashboardCache } from '../routes/financialDashboard.v2.js';
import { safeAbortTransaction } from '../utils/safeAbortTransaction.js';
import { recordPaymentReceived } from '../services/financialLedgerService.js';
import {
    operationKeyFor,
    runPaymentOperation,
    markSideEffectsDone,
    applyStandalone,
    applyBalanceCredit,
    applyMultiPayment
} from '../services/paymentOperations.js';

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

/**
 * Invalida caches financeiros após mutação.
 * Centralizado para garantir que dashboard/cashflow reflitam dados atualizados.
 */
function invalidateFinancialCaches() {
    try {
        invalidateDashboardCache();
    } catch (err) {
        console.warn('[PaymentWorker] Falha ao invalidar cache financeiro:', err.message);
    }
}

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
                        return await handlePaymentProcessRequested(payload, eventId, correlationId, log, { idempotencyKey: job.data.idempotencyKey || null });
                    } else if (eventType === EventTypes.PAYMENT_COMPLETED) {
                        return await handlePaymentConfirmed(payload, eventId, correlationId, log);
                    }
                    
                    throw new Error(`Tipo desconhecido: ${eventType}`);
                },
                'payment_worker'
            );

            // 🆕 V2: atualiza snapshot financeiro de forma não-bloqueante
            try {
                const { processFinancialEvent } = await import('./financialSnapshotWorker.v2.js');
                processFinancialEvent(eventType, payload).catch(err =>
                    log.error('snapshot_update_error', err.message, { eventId, eventType })
                );
            } catch (importErr) {
                log.warn('snapshot_import_failed', importErr.message, { eventId });
            }

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

    // Data clínica do agendamento (para paymentDate)
    const clinicalPaymentDate = appointment?.date
        ? moment.tz(appointment.date, 'America/Sao_Paulo').startOf('day').toDate()
        : new Date();

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

    // 3. Cria registro de pagamento (pending — financialDate preenchido só no paid)
    const payment = new Payment({
        patient: appointment?.patient || patientId,  // 🎯 Schema obrigatório: busca do appointment ou fallback payload
        patientId: patientId,
        appointment: appointmentId,  // 🎯 Schema espera 'appointment'
        appointmentId: appointmentId,
        amount,
        paymentMethod,
        paymentDate: clinicalPaymentDate,
        financialDate: null,
        status: 'pending',
        billingType: 'particular', // 🎯 Dashboard separa por tipo
        source: 'appointment',
        description: notes || `Pagamento referente ao agendamento ${appointmentId}`
    });

    try {
        await payment.save();
        log.info('payment_created', `Pagamento criado: ${payment._id}`);

        // 🔗 LINKA payment ao appointment (sync forte)
        await Appointment.findByIdAndUpdate(appointmentId, { 
            $set: {
                payment: payment._id,
                paymentId: payment._id.toString(),
                financialStatus: 'pending',
                updatedAt: new Date()
            },
            $push: {
                history: {
                    action: 'payment_link_created',
                    timestamp: new Date(),
                    paymentId: payment._id.toString(),
                    context: `Link de pagamento criado: ${payment._id}`
                }
            }
        });

        // ✅ CONFIRMA PAYMENT IMEDIATAMENTE (sessão já foi completada antes deste evento)
        // financialDate é derivado do pagamento real (paidAt), não do input externo
        await transitionPaymentStatus(payment._id, 'paid', {
            paymentMethod: payment.paymentMethod || 'pix',
            paidAt: new Date(),
            reason: 'payment_link_confirmed'
        });
        log.info('payment_confirmed', `Pagamento confirmado como paid: ${payment._id}`);

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

    log.info('payment_paid', `Payment ${payment._id} criado e confirmado como paid`);
    
    // 🏦 REGISTRA NO LEDGER (caixa)
    try {
        const { recordPaymentReceived } = await import('../services/financialLedgerService.js');
        await recordPaymentReceived(payment, { correlationId });
        log.info('ledger_recorded', `Lançamento contábil registrado: ${payment.amount}`);
    } catch (ledgerError) {
        log.error('ledger_error', 'Erro ao registrar no ledger (não-fatal)', { error: ledgerError.message });
    }

    // 🔄 INVALIDA CACHE FINANCEIRO
    invalidateFinancialCaches();

    return {
        status: 'payment_created_paid',
        paymentId: payment._id,
        appointmentId
    };
}

/**
 * Processa recebimento de pagamento (PAYMENT_PROCESS_REQUESTED)
 * 
 * 🎯 WORKER SIMPLIFICADO V2:
 * - Assume payload VALIDADO e NORMALIZADO pela API
 * - Não faz validações defensivas (fail fast na API)
 * - Usa 'type' do payload para routing (sempre presente)
 * 
 * Fluxos:
 * 1. multi_payment: cria Payment consolidado para saldo/débitos
 * 2. appointment_payment: atualiza Payment existente do appointment
 * 3. standalone: cria Payment avulso (sem appointment)
 */
async function handlePaymentProcessRequested(payload, eventId, correlationId, log, ctx = {}) {
    const { type, patientId, appointmentId, amount, paymentMethod, source } = payload;

    log.info('payment_process_started', `Processando ${type}`, {
        patientId,
        appointmentId,
        amount,
        paymentMethod,
        source: source || 'unknown'
    });

    switch (type) {
        case 'multi_payment':
            // O lock reduz disputa; a garantia vem do PaymentOperation na transação.
            return await withLock(`payment-multi:${patientId}`, async () => {
                return await processMultiPayment(payload, eventId, correlationId, log, ctx);
            }, { ttl: 60 });

        case 'appointment_payment':
            return await processSinglePayment(payload, eventId, correlationId, log);

        case 'standalone':
            log.info('standalone_payment', 'Processando pagamento avulso', { patientId, amount });
            return await processStandalonePayment(payload, eventId, correlationId, log, ctx);

        case 'balance_credit':
            log.info('balance_credit', 'Processando crédito em conta', { patientId, amount });
            return await processBalanceCredit(payload, eventId, correlationId, log, ctx);

        default:
            log.error('invalid_type', 'Tipo inválido recebido - falha na validação da API', { type });
            throw new Error(`INVALID_TYPE: ${type}. Falha na validação da API.`);
    }
}

/**
 * Efeitos depois do commit: pelo menos uma vez. Na reentrega de uma operação
 * já aplicada, só rodam se sideEffectsAt ainda estiver vazio. Os eventos levam
 * idempotencyKey derivada da operação para o publisher descartar repetição.
 */
async function runPostCommitEffects({ kind, op, correlationId, log, completedPayload, reason, notification }) {
    const key = op.operationKey;

    if (op.paymentId) {
        try {
            const { handlePaymentEvent } = await import('../projections/paymentsProjection.js');
            await handlePaymentEvent({
                type: 'PAYMENT_CREATED',
                payload: { paymentId: String(op.paymentId) },
                timestamp: new Date()
            });
        } catch (projError) {
            log.error('payment_projection_error', 'Erro ao atualizar PaymentsView', { error: projError.message });
        }
    }

    invalidateFinancialCaches();

    if (completedPayload) {
        await publishEvent(EventTypes.PAYMENT_COMPLETED, completedPayload, {
            correlationId,
            idempotencyKey: `${key}:completed`
        });
        const day = new Date().toISOString().split('T')[0];
        await publishEvent(EventTypes.TOTALS_RECALCULATE_REQUESTED, {
            clinicId: null, date: day, period: 'month', reason, triggeredBy: 'payment_worker'
        }, { correlationId, idempotencyKey: `${key}:totals` });
        await publishEvent(EventTypes.DAILY_CLOSING_REQUESTED, {
            clinicId: 'default', date: day, reason, triggeredBy: 'payment_worker'
        }, { correlationId, idempotencyKey: `${key}:daily_closing` });
    }

    if (notification) {
        await publishEvent(EventTypes.NOTIFICATION_REQUESTED, notification, {
            correlationId,
            idempotencyKey: `${key}:notification`
        });
    }

    await markSideEffectsDone(key);
    log.info('payment_side_effects_done', `Efeitos pós-commit concluídos (${kind})`, { operationKey: key, replayed: op.replayed });
}

/**
 * Pagamento avulso. Payment + crédito no saldo + ledger numa transação,
 * uma vez por operationKey.
 */
async function processStandalonePayment(payload, eventId, correlationId, log, ctx = {}) {
    const { patientId, amount, paymentMethod } = payload;
    const operationKey = operationKeyFor('standalone', { idempotencyKey: ctx.idempotencyKey, eventId });

    const op = await runPaymentOperation({
        operationKey,
        kind: 'standalone',
        request: payload,
        eventId,
        log,
        apply: (txCtx) => applyStandalone(payload, txCtx, { correlationId, recordLedger: recordPaymentReceived })
    });

    if (op.applied || op.sideEffectsPending) {
        await runPostCommitEffects({
            kind: 'standalone',
            op,
            correlationId,
            log,
            reason: 'payment_standalone_completed',
            completedPayload: {
                paymentId: String(op.paymentId),
                patientId: String(patientId),
                amount,
                billingType: 'particular',
                type: 'standalone',
                paymentMethod
            }
        });
    }

    return { ...(op.result || {}), replayed: op.replayed, operationKey };
}

/**
 * Crédito em conta. Lançamento no saldo uma vez por operationKey.
 */
async function processBalanceCredit(payload, eventId, correlationId, log, ctx = {}) {
    const operationKey = operationKeyFor('balance_credit', { idempotencyKey: ctx.idempotencyKey, eventId });

    const op = await runPaymentOperation({
        operationKey,
        kind: 'balance_credit',
        request: payload,
        eventId,
        log,
        apply: (txCtx) => applyBalanceCredit(payload, txCtx)
    });

    if (op.applied || op.sideEffectsPending) {
        await runPostCommitEffects({ kind: 'balance_credit', op, correlationId, log });
    }

    log.info('balance_credit_applied', `Crédito de ${payload.amount} para ${payload.patientId}`, { replayed: op.replayed });
    return { ...(op.result || {}), replayed: op.replayed, operationKey };
}

/**
 * Pagamento múltiplo. Payment consolidado + quitação dos débitos + saldo +
 * agendamentos + ledger numa transação, uma vez por operationKey.
 */
async function processMultiPayment(payload, eventId, correlationId, log, ctx = {}) {
    const { patientId, payments, debitIds, totalAmount } = payload;

    const rawMethod = payments[0]?.paymentMethod || 'cash';
    if (['convenio', 'liminar_credit'].includes(rawMethod)) {
        throw new Error(`PAYMENT_FLOW_BLOCKED: paymentWorker não processa billingType='${rawMethod}'. Use fluxo correto.`);
    }

    log.info('multi_payment_processing', `Processando ${debitIds.length} débitos`, {
        patientId,
        totalAmount,
        paymentCount: payments.length
    });

    const operationKey = operationKeyFor('multi_payment', { idempotencyKey: ctx.idempotencyKey, eventId });

    let op;
    try {
        op = await runPaymentOperation({
            operationKey,
            kind: 'multi_payment',
            request: payload,
            eventId,
            log,
            apply: (txCtx) => applyMultiPayment(payload, txCtx, { correlationId, recordLedger: recordPaymentReceived, Appointment })
        });
    } catch (error) {
        log.error('multi_payment_error', `Erro no payment-multi: ${error.message}`, { operationKey });
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
    }

    if (op.applied || op.sideEffectsPending) {
        await runPostCommitEffects({
            kind: 'multi_payment',
            op,
            correlationId,
            log,
            reason: 'payment_multi_completed',
            completedPayload: {
                paymentId: String(op.paymentId),
                patientId: patientId.toString(),
                amount: totalAmount,
                billingType: 'particular',
                paymentMethod: payments[0]?.paymentMethod || 'dinheiro',
                type: 'multi_payment',
                debitsCount: debitIds.length,
                appointmentsCount: op.result?.appointmentsUpdated ?? 0
            },
            notification: {
                type: 'PAYMENT_CONFIRMED',
                patientId: patientId.toString(),
                amount: totalAmount,
                message: `Pagamento de R$ ${totalAmount} confirmado (${debitIds.length} débito(s) quitados)`
            }
        });
    }

    log.info('multi_payment_completed', `Payment-multi: ${op.paymentId}`, { operationKey, replayed: op.replayed });
    return { ...(op.result || {}), replayed: op.replayed, operationKey };
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

    // 🛡️ VALIDAÇÃO: Verifica se payment existe, ou cria um novo
    let paymentBefore = await Payment.findOne({
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

        // 🆕 CRIA PAYMENT SE NÃO EXISTIR (fluxo V2 completo)
        log.info('payment_not_found_creating', `Payment não encontrado para ${appointmentId}, criando novo...`);
        
        // Busca o appointment para pegar o patient correto
        const appointmentData = await Appointment.findById(appointmentId).select('patient');
        const patientRef = appointmentData?.patient || patientId;
        
        paymentBefore = new Payment({
            patient: patientRef,  // 🎯 Campo obrigatório do schema
            patientId: patientId,
            appointmentId: appointmentId,
            appointment: appointmentId,
            amount: amount,
            receivedAmount: 0,
            paymentMethod: paymentMethod,
            paymentDate: new Date(),
            financialDate: new Date(), // 🎯 Fonte única de verdade
            status: 'pending',
            source: 'appointment_v2',
            description: `Pagamento referente ao agendamento ${appointmentId}`
        });
        
        await paymentBefore.save();
        log.info('payment_created_auto', `Payment ${paymentBefore._id} criado automaticamente`);
        
        // Linka ao appointment
        await Appointment.findByIdAndUpdate(appointmentId, {
            $set: {
                payment: paymentBefore._id,
                paymentId: paymentBefore._id.toString(),
                updatedAt: new Date()
            }
        });
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

        // 3. Atualiza status via paymentStatusService (apenas se mudou)
        if (newStatus !== updated.status) {
            await transitionPaymentStatus(updated._id, newStatus, {
                session: mongoSession,
                paymentMethod: isFullyPaid ? paymentMethod : undefined,
                paidAt: isFullyPaid ? new Date() : undefined,
                financialDate: updated.paymentDate || new Date(),
                reason: isFullyPaid ? 'payment_received_full' : 'payment_received_partial'
            });
        }
        // Notes é atualizado separadamente (não afeta status)
        if (notes) {
            await Payment.updateOne(
                { _id: updated._id },
                { $set: { notes: updated.notes ? `${updated.notes} | ${notes}` : notes } },
                { session: mongoSession }
            );
        }

        // 4. Atualiza Appointment com link forte (fonte única de verdade)
        const appointmentUpdate = {
            $set: {
                paymentStatus: newStatus,
                financialStatus: newStatus,  // 🎯 Fonte única de verdade financeira
                paymentId: updated._id.toString(),  // 🔗 Link direto
                paidAt: isFullyPaid ? new Date() : undefined,
                lastPaymentAt: new Date(),
                updatedAt: new Date()
            },
            $push: {
                history: {
                    action: isFullyPaid ? 'payment_received_full' : 'payment_received_partial',
                    timestamp: new Date(),
                    amount: amount,
                    receivedTotal: updated.receivedAmount,
                    paymentId: updated._id.toString(),
                    context: `Recebimento via ${paymentMethod}`
                }
            }
        };
        
        // 🔄 SYNC: Atualiza Appointment com link forte
        console.log(`[PaymentWorker] Syncando appointment ${appointmentId} com payment ${updated._id}`);
        
        const appointmentResult = await Appointment.findByIdAndUpdate(
            appointmentId,
            appointmentUpdate,
            { session: mongoSession, new: true }
        );
        
        if (!appointmentResult) {
            console.error(`[PaymentWorker] ❌ ERRO CRÍTICO: Appointment ${appointmentId} não encontrado durante sync!`);
            console.error(`[PaymentWorker] Payment ${updated._id} foi processado mas appointment não foi atualizado`);
            log.error('appointment_sync_failed', `Appointment ${appointmentId} não encontrado durante sync`, {
                paymentId: updated._id,
                appointmentId
            });
            // Não falha o pagamento, mas loga crítico
        } else {
            console.log(`[PaymentWorker] ✅ Appointment ${appointmentId} sincronizado com sucesso`);
            console.log(`[PaymentWorker]    financialStatus: ${newStatus}, paymentId: ${updated._id}`);
            log.info('appointment_synced', `Appointment ${appointmentId} sincronizado`, {
                financialStatus: newStatus,
                paymentId: updated._id
            });
        }

        await mongoSession.commitTransaction();

        log.info('payment_received', `Recebimento registrado: ${amount} (total: ${updated.receivedAmount}/${updated.amount})`, {
            paymentId: updated._id,
            appointmentId,
            status: newStatus
        });
        
        // 🏦 REGISTRA NO LEDGER (caixa) - CRÍTICO
        try {
            const { recordPaymentReceived } = await import('../services/financialLedgerService.js');
            await recordPaymentReceived(updated, { correlationId });
            log.info('ledger_recorded', `Lançamento contábil registrado no caixa`);
        } catch (ledgerError) {
            log.error('ledger_error', 'Erro ao registrar no ledger (não-fatal)', { error: ledgerError.message });
            // Não falha o pagamento se o ledger falhar
        }
        
        // 🔄 ATUALIZA PROJECTIONS (Financial)
        try {
            const { default: FinancialProjectionHandler } = await import('../projections/financialProjection.js');
            await FinancialProjectionHandler.updateCash({
                amount: updated.amount,
                billingType: 'particular',
                paymentMethod: updated.paymentMethod,
                paymentId: updated._id.toString()
            });
            log.info('projection_updated', 'Financial projection atualizada');
        } catch (projError) {
            log.error('projection_error', 'Erro ao atualizar projection', { error: projError.message });
        }
        
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

        // 🔄 INVALIDA CACHE FINANCEIRO
        invalidateFinancialCaches();

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
                    billingType: 'particular', // 🎯 Para projection
                    paymentMethod,
                    source: 'single_payment'
                },
                { correlationId }
            );
        }
        
        // 🔄 EVENTO DE SYNC: Garante consistência entre Appointment ↔ Payment
        await publishEvent(
            'APPOINTMENT_PAYMENT_SYNCED',
            {
                appointmentId: appointmentId.toString(),
                paymentId: updated._id.toString(),
                patientId: patientId?.toString(),
                financialStatus: newStatus,
                isFullyPaid,
                amountReceived: amount,
                receivedTotal: updated.receivedAmount,
                syncedAt: new Date().toISOString()
            },
            { correlationId }
        );

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
        if (mongoSession.inTransaction()) {
            await mongoSession.abortTransaction();
        }
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
        await transitionPaymentStatus(payment._id, 'paid', {
            session: mongoSession,
            paymentMethod: payment.paymentMethod || 'pix',
            financialDate: payment.paymentDate || new Date(),
            paidAt: new Date(),
            reason: 'saga_confirm'
        });
        
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
        await safeAbortTransaction(mongoSession);
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
        await safeAbortTransaction(mongoSession);
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
    if (payment) {
        await transitionPaymentStatus(paymentId, 'paid', {
            paymentMethod: payment.paymentMethod || 'pix',
            financialDate: payment.paymentDate || new Date(),
            paidAt: new Date(),
            reason: 'webhook_confirmed'
        });
        payment.transactionId = transactionId;
        payment.history.push({
            action: 'confirmed_via_webhook',
            transactionId,
            timestamp: new Date()
        });
        await payment.save();
    }
    
    // Confirma agendamento
    await Appointment.findByIdAndUpdate(payment.appointment, {
        operationalStatus: 'scheduled',
        paymentStatus: 'paid'
    });
    
    // 🏦 REGISTRAR NO LEDGER (caixa)
    try {
        const { recordPaymentReceived } = await import('../services/financialLedgerService.js');
        await recordPaymentReceived(payment, { correlationId: correlationId || `webhook_${Date.now()}` });
        log.info('ledger_recorded', `Lançamento contábil registrado no caixa (webhook)`);
    } catch (ledgerError) {
        log.error('ledger_error', 'Erro ao registrar no ledger (não-fatal)', { error: ledgerError.message });
    }

    // 🔄 INVALIDA CACHE FINANCEIRO
    invalidateFinancialCaches();
    
    log.info('confirmed_via_webhook', `Pagamento ${paymentId} confirmado via webhook`);
    
    return { status: 'confirmed_via_webhook', paymentId };
}
