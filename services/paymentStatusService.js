/**
 * 💰 Payment Status Service
 * FLOW REFERENCE: back/docs/ARCHITECTURE_FLOW.md
 * Domínio: Payment | Insurance
 * Fluxo: Fluxo 3 — Convênio > faturamento em lote
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
import FinancialLedger from '../models/FinancialLedger.js';
import Outbox from '../infrastructure/outbox/OutboxModel.js';
import { EventTypes } from '../infrastructure/events/eventPublisher.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';
import {
    assertFinancialContextAllowsPaymentWrite,
    assertPaymentBillable,
    buildBilledUpdate
} from './billingSubmission/paymentBillingInvariants.js';
import { isPackageConsumptionPayment, PackageConsumptionInBillingError } from '../utils/packageConsumptionPayment.js';
import mongoose from 'mongoose';
import moment from 'moment-timezone';

const TIMEZONE = 'America/Sao_Paulo';

export class PaymentBatchTransitionError extends Error {
    constructor(code, message, details = undefined) {
        super(message);
        this.name = 'PaymentBatchTransitionError';
        this.code = code;
        this.details = details;
    }
}

/**
 * Transição canônica e performática de Payments de convênio para `billed`.
 * Centraliza status, campos derivados, ledger e Outbox sem N+1.
 */
export async function transitionPaymentStatusBatch(transitions, newStatus, options = {}) {
    const {
        session: mongoSession,
        now = new Date(),
        reason = 'batch_process',
        userId,
        additionalOutboxDocs = [],
        step = (_name, operation) => operation()
    } = options;

    if (newStatus !== 'billed') {
        throw new PaymentBatchTransitionError(
            'PAYMENT_BATCH_STATUS_UNSUPPORTED',
            `Transição em lote para '${newStatus}' não implementada`
        );
    }

    assertFinancialContextAllowsPaymentWrite();
    const eventDay = moment.tz(now, TIMEZONE).format('YYYY-MM-DD');
    const paymentOps = [];
    const ledgerDocs = [];
    const outboxDocs = [...additionalOutboxDocs];
    const warnings = [];

    for (const transition of transitions) {
        const { payment, ledger } = transition;
        assertPaymentBillable(payment);
        const built = buildBilledUpdate(payment, { now });
        if (built.warnings.length) {
            warnings.push({ paymentId: payment._id.toString(), warnings: built.warnings });
        }

        paymentOps.push({
            updateOne: {
                filter: { _id: payment._id, status: payment.status },
                update: { $set: built.set }
            }
        });
        ledgerDocs.push(ledger);
        outboxDocs.push({
            eventId: `${payment._id}_${payment.status}_${newStatus}_${eventDay}`,
            correlationId: `payment_status_${payment._id}_${payment.status}_${newStatus}_${now.getTime()}`,
            eventType: EventTypes.PAYMENT_STATUS_CHANGED,
            aggregateType: 'payment',
            aggregateId: String(payment._id),
            status: 'pending',
            createdAt: now,
            payload: {
                paymentId: payment._id.toString(),
                patientId: payment.patient?.toString?.(),
                appointmentId: payment.appointment?.toString?.(),
                sessionId: payment.session?.toString?.(),
                packageId: payment.package?.toString?.(),
                from: payment.status,
                to: newStatus,
                amount: payment.amount,
                paymentMethod: payment.paymentMethod,
                financialDate: payment.financialDate,
                paidAt: payment.paidAt,
                kind: built.set.kind || payment.kind,
                billingType: payment.billingType,
                isFromPackage: payment.isFromPackage,
                reason,
                userId: userId?.toString?.()
            }
        });
    }

    // Contagem real de round-trips ao Mongo — reportada ao chamador em vez de um
    // número fixo, porque insert_outbox é CONDICIONAL (só roda se sobrar algum
    // evento novo depois do dedupe). Um retry onde todo evento já existe faz 3
    // queries, não 4; um chamador que assumisse 4 sempre estaria mentindo na
    // própria instrumentação.
    let queriesExecuted = 0;

    const paymentResult = await step('bill_payments', () =>
        Payment.bulkWrite(paymentOps, { session: mongoSession, ordered: true }));
    queriesExecuted += 1;
    if (paymentResult.modifiedCount !== paymentOps.length) {
        throw new PaymentBatchTransitionError(
            'BILLING_SUBMISSION_PAYMENT_CONCURRENT_CHANGE',
            'Um Payment mudou de status durante a transição em lote',
            { expected: paymentOps.length, modified: paymentResult.modifiedCount }
        );
    }

    await step('insert_ledger', () =>
        FinancialLedger.insertMany(ledgerDocs, { session: mongoSession, ordered: true }));
    queriesExecuted += 1;

    const existingEventIds = await step('outbox_dedupe', async () => {
        const found = await Outbox.find({ eventId: { $in: outboxDocs.map(doc => doc.eventId) } })
            .select('eventId')
            .session(mongoSession)
            .lean();
        return new Set(found.map(doc => doc.eventId));
    });
    queriesExecuted += 1;
    const freshOutboxDocs = outboxDocs.filter(doc => !existingEventIds.has(doc.eventId));
    if (freshOutboxDocs.length) {
        await step('insert_outbox', () =>
            Outbox.insertMany(freshOutboxDocs, { session: mongoSession, ordered: true }));
        queriesExecuted += 1;
    }

    return {
        modifiedCount: paymentResult.modifiedCount,
        warnings,
        existingEventCount: existingEventIds.size,
        insertedOutboxCount: freshOutboxDocs.length,
        queriesExecuted
    };
}

/**
 * Transição canônica e performática de Payments de convênio para `paid` /
 * `insurance.status='received'` — o lado de RECEBIMENTO de NF, irmã de
 * `transitionPaymentStatusBatch` (que cobre o lado de FATURAMENTO, `→ billed`).
 * Centraliza status, campos derivados, ledger e Outbox sem N+1.
 *
 * O `$set` de cada Payment e o doc de Ledger correspondente são montados pelo
 * CHAMADOR (services/insuranceBatch/InsuranceBatchReceiptService.js), usando
 * services/insuranceBatch/paymentReceiptInvariants.js#buildReceivedUpdate —
 * mesma separação de responsabilidade de transitionPaymentStatusBatch: este
 * arquivo não sabe calcular rateio de ISS nem valor líquido, só sabe escrever
 * em lote com segurança.
 *
 * @param {Array<{payment: Object, set: Object, ledger: Object}>} transitions
 *   payment = documento lean já carregado pelo chamador (reaproveitado, sem
 *   re-fetch); set = resultado de buildReceivedUpdate; ledger = doc completo
 *   pronto para FinancialLedger.insertMany (mesmo shape de FinancialLedger.credit()).
 * @param {Object} options
 * @param {Object} options.session   mongoose session da transação (obrigatória
 *                                    na prática — o chamador sempre roda dentro
 *                                    de mongoSession.withTransaction)
 * @param {Date}   [options.now]     momento real do processamento (não a data
 *                                    histórica do recebimento) — usado só para
 *                                    o dia do eventId e correlationId do evento
 * @param {string} [options.reason]
 * @param {string} [options.userId]
 * @param {Function} [options.step] instrumentação opcional (nome, operação) => resultado
 * @returns {Promise<{modifiedCount:number, existingEventCount:number, insertedOutboxCount:number, queriesExecuted:number}>}
 */
export async function transitionPaymentStatusBatchToReceived(transitions, options = {}) {
    const {
        session: mongoSession,
        now = new Date(),
        reason = 'insurance_batch_invoice_received',
        userId,
        step = (_name, operation) => operation()
    } = options;

    assertFinancialContextAllowsPaymentWrite();
    const eventDay = moment.tz(now, TIMEZONE).format('YYYY-MM-DD');
    const paymentOps = [];
    const ledgerDocs = [];
    const outboxDocs = [];

    for (const { payment, set, ledger } of transitions) {
        // Filtro otimista pelos DOIS campos relevantes, com o valor OBSERVADO
        // (não um valor fixo assumido): payment.status varia entre payments —
        // 'billed' no fluxo normal, mas pode ser outro valor em lotes
        // reconciliados manualmente onde só insurance.status foi promovido a
        // 'billed'. Travar num valor fixo rejeitaria esse caso legítimo.
        paymentOps.push({
            updateOne: {
                filter: { _id: payment._id, status: payment.status, 'insurance.status': payment.insurance?.status },
                update: { $set: set }
            }
        });
        ledgerDocs.push(ledger);
        outboxDocs.push({
            eventId: `${payment._id}_${payment.status}_paid_${eventDay}`,
            correlationId: `payment_status_${payment._id}_${payment.status}_paid_${now.getTime()}`,
            eventType: EventTypes.PAYMENT_STATUS_CHANGED,
            aggregateType: 'payment',
            aggregateId: String(payment._id),
            status: 'pending',
            createdAt: now,
            payload: {
                paymentId: payment._id.toString(),
                patientId: payment.patient?.toString?.(),
                appointmentId: payment.appointment?.toString?.(),
                sessionId: payment.session?.toString?.(),
                packageId: payment.package?.toString?.(),
                from: payment.status,
                to: 'paid',
                amount: payment.amount,
                paymentMethod: set.paymentMethod || payment.paymentMethod,
                financialDate: set.financialDate ?? payment.financialDate,
                paidAt: set.paidAt ?? payment.paidAt,
                kind: set.kind || payment.kind,
                billingType: payment.billingType,
                isFromPackage: payment.isFromPackage,
                reason,
                userId: userId?.toString?.()
            }
        });
    }

    // Mesma lógica de contagem real de transitionPaymentStatusBatch: insert_outbox
    // é condicional (só roda se sobrar evento novo após o dedupe).
    let queriesExecuted = 0;

    const paymentResult = await step('receive_payments', () =>
        Payment.bulkWrite(paymentOps, { session: mongoSession, ordered: true }));
    queriesExecuted += 1;
    if (paymentResult.modifiedCount !== paymentOps.length) {
        throw new PaymentBatchTransitionError(
            'INSURANCE_BATCH_RECEIVE_PAYMENT_CONCURRENT_CHANGE',
            'Um Payment mudou de status durante o recebimento em lote',
            { expected: paymentOps.length, modified: paymentResult.modifiedCount }
        );
    }

    await step('insert_ledger', () =>
        FinancialLedger.insertMany(ledgerDocs, { session: mongoSession, ordered: true }));
    queriesExecuted += 1;

    const existingEventIds = await step('outbox_dedupe', async () => {
        const found = await Outbox.find({ eventId: { $in: outboxDocs.map(doc => doc.eventId) } })
            .select('eventId')
            .session(mongoSession)
            .lean();
        return new Set(found.map(doc => doc.eventId));
    });
    queriesExecuted += 1;
    const freshOutboxDocs = outboxDocs.filter(doc => !existingEventIds.has(doc.eventId));
    if (freshOutboxDocs.length) {
        await step('insert_outbox', () =>
            Outbox.insertMany(freshOutboxDocs, { session: mongoSession, ordered: true }));
        queriesExecuted += 1;
    }

    return {
        modifiedCount: paymentResult.modifiedCount,
        existingEventCount: existingEventIds.size,
        insertedOutboxCount: freshOutboxDocs.length,
        queriesExecuted
    };
}

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
/**
 * Encontra o crédito 'payment_received' ATIVO (ainda não revertido) mais
 * recente de um Payment, e lança a reversão vinculada especificamente a ele
 * (`reversalOfEntryId`). Suporta múltiplos ciclos pagar→reverter→pagar no
 * mesmo Payment: cada reversão aponta pro crédito exato que compensa, então
 * uma reversão antiga nunca é confundida com — nem bloqueia — um ciclo novo.
 *
 * Idempotente por construção do banco (índice único em reversalOfEntryId,
 * ver models/FinancialLedger.js), não por leitura prévia: duas chamadas
 * concorrentes tentando reverter o MESMO crédito colidem no insert, a
 * perdedora recebe 11000 e trata como já revertido — sem duplicar débito.
 */
async function reverseActiveCreditIfAny(payment, { mongoSession, userId, reason, oldStatus, newStatus }) {
    const creditsQuery = FinancialLedger.find({ payment: payment._id, type: 'payment_received' }).sort({ createdAt: 1 });
    if (mongoSession) creditsQuery.session(mongoSession);
    const credits = await creditsQuery.lean();
    if (credits.length === 0) return null;

    const reversalsQuery = FinancialLedger.find({ reversalOfEntryId: { $in: credits.map(c => c._id) } });
    if (mongoSession) reversalsQuery.session(mongoSession);
    const reversals = await reversalsQuery.lean();
    const reversedCreditIds = new Set(reversals.map(r => r.reversalOfEntryId.toString()));

    const unreversed = credits.filter(c => !reversedCreditIds.has(c._id.toString()));
    if (unreversed.length === 0) return null;

    // Mais recente primeiro — em uso normal só existe um crédito ativo por
    // vez (o Payment só pode estar 'paid' uma vez até a próxima reversão),
    // mas pega o mais novo defensivamente se houver mais de um.
    const targetCredit = unreversed[unreversed.length - 1];

    try {
        const reversal = await FinancialLedger.debit({
            type: 'reversal',
            amount: targetCredit.amount,
            billingType: targetCredit.billingType,
            patient: payment.patient,
            appointment: payment.appointment,
            session: payment.session,
            payment: payment._id,
            reversalOfEntryId: targetCredit._id,
            correlationId: `reversal:${targetCredit._id}`,
            description: `Reversão automática: status mudou de '${oldStatus}' para '${newStatus}' (${reason})`,
            occurredAt: new Date(),
            createdBy: userId,
            metadata: { source: 'transitionPaymentStatus', previousStatus: oldStatus, newStatus, reason }
        }, mongoSession);
        console.log(`[PaymentStatusService] 🔄 Reversão automática do ledger: Payment ${payment._id} (${oldStatus}→${newStatus}), R$${targetCredit.amount}, compensando crédito ${targetCredit._id}`);
        return reversal;
    } catch (err) {
        if (err?.code === 11000) {
            const existingQuery = FinancialLedger.findOne({ reversalOfEntryId: targetCredit._id, type: 'reversal' });
            if (mongoSession) existingQuery.session(mongoSession);
            const existing = await existingQuery.lean();
            if (existing) {
                console.warn(`[PaymentStatusService] Reversão concorrente detectada: crédito ${targetCredit._id} já revertido por ${existing._id} — não duplicando.`);
                return existing;
            }
        }
        throw err;
    }
}

export async function transitionPaymentStatus(paymentId, newStatus, options = {}) {
    const {
        financialDate,
        paidAt,
        paymentMethod,
        userId,
        reason = 'manual',
        session: externalSession,
        silent = false
    } = options;

    // 1. Leitura inicial só pra decidir o caminho — early-return de "não
    // mudou nada" e a guarda de consumo de pacote são baratos e não precisam
    // de transação própria.
    const initialQuery = Payment.findById(paymentId);
    if (externalSession) initialQuery.session(externalSession);
    const initialPayment = await initialQuery;

    if (!initialPayment) {
        throw new Error(`[PaymentStatusService] Payment não encontrado: ${paymentId}`);
    }

    const oldStatus = initialPayment.status;

    if (oldStatus === newStatus) {
        return { payment: initialPayment, event: null, changed: false };
    }

    // 🛡️ GUARDA FINANCEIRA: consumo de pacote (isFromPackage=true ou
    // kind='package_consumed') nunca pode virar recebível de convênio.
    // Payment.pre('save') só bloqueia quando financialDate é setado (status
    // 'paid'), não quando o status é 'billed' — deixando esse trecho aberto
    // para o mesmo bug do backfill de abril/2026 se reproduzir hoje via
    // qualquer chamador deste serviço. Checagem centralizada em
    // utils/packageConsumptionPayment.js. Ver auditoria
    // scripts/maintenance/audit-convenio-isfrompackage-2026-08-26.mjs.
    if (newStatus === 'billed' && isPackageConsumptionPayment(initialPayment)) {
        throw new PackageConsumptionInBillingError([initialPayment], 'transitionPaymentStatus:billed');
    }

    // 🛡️ ATOMICIDADE Payment+Ledger: saindo de 'paid', o Payment.save() e a
    // eventual reversão do ledger precisam commitar ou abortar JUNTOS — senão
    // uma falha na escrita do ledger (rede, validação, etc.) deixa o Payment
    // já salvo como 'pending' com o crédito antigo intacto, exatamente o
    // achado real de produção (2026-08-26) que originou este redesenho. Se o
    // chamador já nos deu uma session (participa da transação dele), usamos
    // a dele; senão abrimos uma própria só para este escopo.
    const willAttemptReversal = oldStatus === 'paid' && newStatus !== 'paid';
    let ownSession = null;
    if (willAttemptReversal && !externalSession) {
        ownSession = await mongoose.startSession();
    }

    const runCore = async (mongoSession) => {
        const query = Payment.findById(paymentId);
        if (mongoSession) query.session(mongoSession);
        const payment = await query;
        if (!payment) {
            throw new Error(`[PaymentStatusService] Payment não encontrado: ${paymentId}`);
        }
        if (payment.status === newStatus) {
            return { payment, event: null, changed: false };
        }
        if (newStatus === 'billed' && isPackageConsumptionPayment(payment)) {
            throw new PackageConsumptionInBillingError([payment], 'transitionPaymentStatus:billed');
        }

        const localOldStatus = payment.status;

        // 3. Aplica a transição
        payment.status = newStatus;

        // Campos derivados automáticos
        if (newStatus === 'paid' && !payment.paidAt) {
            payment.paidAt = paidAt || new Date();
        }
        if (newStatus === 'paid' && !payment.financialDate) {
            payment.financialDate = financialDate || payment.paidAt || new Date();
        }
        if (newStatus === 'billed' && !payment.billedAt) {
            payment.billedAt = new Date();
        }
        if (newStatus === 'billed') {
            if (!payment.insurance) {
                payment.insurance = {};
            }
            payment.insurance.status = 'billed';
            if (!payment.insurance.billedAt) {
                payment.insurance.billedAt = new Date();
                payment.insurance.billedAtSource = 'paymentStatusService';
            }
        }
        if (paymentMethod) {
            payment.paymentMethod = paymentMethod;
        }

        // 4. Salva (com ou sem session)
        // Flag transitória: impede o post-save safety net de publicar o mesmo evento
        // fora da Outbox. Não pertence ao schema e nunca é persistida.
        payment.__statusChangedEmitted = true;
        // 🛡️ Autoriza esta escrita perante o AppointmentWriteGuard — sem isso,
        // TODA chamada a esta função (a única via canônica de mudar
        // Payment.status) gerava WARN de "write não autorizado", já que .save()
        // em documento existente delega pra collection.updateOne (interceptado).
        payment._fromPaymentStatusService = true;
        if (mongoSession) {
            await payment.save({ session: mongoSession });
        } else {
            await payment.save();
        }

        // 🛡️ REVERSÃO AUTOMÁTICA DE LEDGER: saindo de 'paid' pra qualquer outro
        // status, o crédito payment_received original deixa de refletir a
        // realidade — sem isso o FinancialLedger fica com um crédito fantasma
        // pra sempre. Achado real em produção (2026-08-26): PATCH
        // /api/v2/payments/:id genérico usa este serviço pra reverter status
        // paid→pending sem passar pelo fluxo dedicado de estorno
        // (routes/payment.v2.js /register-debit). FinancialLedger é imutável
        // (docs/DELETE_CASCADE_CONTRACT.md) — a correção é lançar um débito de
        // reversão vinculado ao crédito exato, nunca apagar/alterar o original.
        if (localOldStatus === 'paid' && newStatus !== 'paid') {
            await reverseActiveCreditIfAny(payment, { mongoSession, userId, reason, oldStatus: localOldStatus, newStatus });
        }

        return { payment, localOldStatus, changed: true };
    };

    let coreResult;
    if (ownSession) {
        try {
            await ownSession.withTransaction(async () => {
                coreResult = await runCore(ownSession);
            });
        } finally {
            await ownSession.endSession();
        }
    } else {
        coreResult = await runCore(externalSession);
    }

    if (!coreResult.changed) {
        return coreResult;
    }
    const { payment } = coreResult;
    const mongoSession = externalSession || null;

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
    transitionPaymentStatusBatch,
    batchTransitionStatus,
    transitionPaymentStatusWithTransaction
};
