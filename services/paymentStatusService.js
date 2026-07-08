/**
 * 💰 Payment Status Service
 *
 * ÚNICA fonte de verdade para transições de status de Payment.
 *
 * REGRA DE OURO:
 *   NUNCA altere Payment.status diretamente via findByIdAndUpdate.
 *   SEMPRE use este serviço.
 *
 * Garantias:
 *   - Evento PAYMENT_STATUS_CHANGED é emitido para TODA transição
 *   - Campos derivados (paidAt, financialDate) são atualizados automaticamente
 *   - Idempotência via eventId único
 *   - Audit trail completo
 */

import Payment from '../models/Payment.js';
import { EventTypes } from '../infrastructure/events/eventPublisher.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import mongoose from 'mongoose';
import moment from 'moment-timezone';

const TIMEZONE = 'America/Sao_Paulo';

/**
 * Transiciona o status de um payment e emite evento.
 *
 * @param {string} paymentId — ObjectId do payment
 * @param {string} newStatus — 'pending' | 'paid' | 'partial' | 'canceled' | 'billed' | etc
 * @param {Object} options
 * @param {Date}   options.financialDate — Data financeira (default: hoje)
 * @param {Date}   options.paidAt — Data de pagamento (default: hoje se status=paid)
 * @param {string} options.paymentMethod — Método de pagamento (opcional)
 * @param {string} options.userId — ID do usuário que executou a ação
 * @param {string} options.reason — Motivo da transição (ex: 'admin_manual', 'batch_process')
 * @param {Object} options.session — Mongoose session (para transactions)
 * @param {boolean} options.silent — Se true, NÃO emite evento (use com cuidado!)
 * @returns {Promise<{payment: Payment, event: Object|null, changed: boolean}>}
 */
export async function transitionPaymentStatus(paymentId, newStatus, options = {}) {
    const {
        financialDate,
        paidAt,
        paymentMethod,
        userId,
        reason = 'manual',
        session: mongoSession,
        silent = false
    } = options;

    // 1. Busca o payment (dentro da session se houver)
    const query = Payment.findById(paymentId);
    if (mongoSession) query.session(mongoSession);
    const payment = await query;

    if (!payment) {
        throw new Error(`[PaymentStatusService] Payment não encontrado: ${paymentId}`);
    }

    const oldStatus = payment.status;

    // 2. Se não mudou status, não faz nada (mas retorna o payment)
    if (oldStatus === newStatus) {
        return { payment, event: null, changed: false };
    }

    // 3. Aplica a transição
    payment.status = newStatus;

    // Campos derivados automáticos
    if (newStatus === 'paid' && !payment.paidAt) {
        payment.paidAt = paidAt || new Date();
    }
    if (newStatus === 'paid' && !payment.financialDate) {
        payment.financialDate = financialDate || payment.paidAt || new Date();
    }
    if (paymentMethod) {
        payment.paymentMethod = paymentMethod;
    }

    // 4. Salva (com ou sem session)
    if (mongoSession) {
        await payment.save({ session: mongoSession });
    } else {
        await payment.save();
    }

    // 5. Salva evento no Outbox (dentro da transação quando houver session)
    let event = null;
    if (!silent) {
        try {
            const idempotencyKey = `${paymentId}_${oldStatus}_${newStatus}_${moment.tz(TIMEZONE).format('YYYY-MM-DD')}`;
            event = await saveToOutbox(
                {
                    eventId: idempotencyKey,
                    eventType: EventTypes.PAYMENT_STATUS_CHANGED,
                    payload: {
                        paymentId: payment._id.toString(),
                        patientId: payment.patient?.toString?.(),
                        appointmentId: payment.appointment?.toString?.(),
                        sessionId: payment.session?.toString?.(),
                        packageId: payment.package?.toString?.(),
                        from: oldStatus,
                        to: newStatus,
                        amount: payment.amount,
                        paymentMethod: payment.paymentMethod,
                        financialDate: payment.financialDate,
                        paidAt: payment.paidAt,
                        kind: payment.kind,
                        billingType: payment.billingType,
                        isFromPackage: payment.isFromPackage,
                        reason,
                        userId: userId?.toString?.()
                    },
                    aggregateType: 'payment',
                    aggregateId: paymentId,
                    correlationId: `payment_status_${paymentId}_${oldStatus}_${newStatus}_${Date.now()}`
                },
                mongoSession
            );
        } catch (pubErr) {
            // Falha no evento quebra a transação quando há session, garantindo consistência.
            // Sem session, loga crítico e continua.
            console.error(`[PaymentStatusService] ⚠️ Falha ao salvar evento no Outbox: ${pubErr.message}`, {
                paymentId,
                from: oldStatus,
                to: newStatus
            });
            if (mongoSession) throw pubErr;
        }
    }

    console.log(`[PaymentStatusService] ${paymentId}: ${oldStatus} → ${newStatus} | R$${payment.amount} | reason=${reason}`);

    return { payment, event, changed: true };
}

/**
 * Batch: transiciona múltiplos payments de uma vez.
 * Útil para "marcar todos como pago" na tabela financeira.
 *
 * @param {string[]} paymentIds
 * @param {string} newStatus
 * @param {Object} options
 * @returns {Promise<{success: number, failed: number, errors: Array}>}
 */
export async function batchTransitionStatus(paymentIds, newStatus, options = {}) {
    const results = { success: 0, failed: 0, errors: [] };

    for (const paymentId of paymentIds) {
        try {
            await transitionPaymentStatus(paymentId, newStatus, options);
            results.success++;
        } catch (err) {
            results.failed++;
            results.errors.push({ paymentId, error: err.message });
        }
    }

    console.log(`[PaymentStatusService][BATCH] ${results.success} sucesso, ${results.failed} falhas`);
    return results;
}

/**
 * Wrapper seguro para uso em controllers.
 * Abre transaction, executa transição, commit/rollback automático.
 */
export async function transitionPaymentStatusWithTransaction(paymentId, newStatus, options = {}) {
    const session = await mongoose.startSession();
    try {
        await session.startTransaction();

        const result = await transitionPaymentStatus(paymentId, newStatus, {
            ...options,
            session
        });

        await session.commitTransaction();
        return result;
    } catch (err) {
        await session.abortTransaction();
        throw err;
    } finally {
        session.endSession();
    }
}

export default {
    transitionPaymentStatus,
    batchTransitionStatus,
    transitionPaymentStatusWithTransaction
};
