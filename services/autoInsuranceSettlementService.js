/**
 * AUTO INSURANCE SETTLEMENT SERVICE
 *
 * Responsabilidade única: fechar o ciclo financeiro de convênios
 * Session completed + Payment pending → Payment paid
 *
 * Dois caminhos:
 *   1. Batch path:  payment está em InsuranceBatch → processReturn (já existe)
 *   2. Avulso path: payment NOT in batch → settleInsurancePayment direto
 *
 * Idempotência: verifica payment.status antes de qualquer transição.
 * Double-settlement: impossível — transitionPaymentStatus não-op se já paid.
 */
import mongoose from 'mongoose';
import crypto from 'crypto';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import { transitionPaymentStatus } from './paymentStatusService.js';
import { appendEvent } from '../infrastructure/events/eventStoreService.js';

const TAG = '[AutoInsuranceSettlement]';

// ──────────────────────────────────────────────────────────────────────────
// CORE: settle um único payment de convênio
// ──────────────────────────────────────────────────────────────────────────
export async function settleInsurancePayment(paymentId, { reason = 'auto_settlement', paidAt, financialDate } = {}) {
    // 🔒 LOCK ATÔMICO: adquire _billingEventId antes de qualquer operação
    // findOneAndUpdate com condição → garante que apenas 1 executor processa (sem race condition)
    const eventId = `settle-${crypto.randomUUID()}`;
    const locked = await Payment.findOneAndUpdate(
        {
            _id: paymentId,
            status: { $ne: 'paid' },
            $or: [{ _billingEventId: null }, { _billingEventId: { $exists: false } }]
        },
        { $set: { _billingEventId: eventId } },
        { new: false }
    ).lean();

    if (!locked) {
        // Já foi settled ou outro processo adquiriu o lock
        const current = await Payment.findById(paymentId).select('status _billingEventId').lean();
        const skipReason = current?.status === 'paid' ? 'already_paid' : 'lock_acquired_by_other';
        console.log(`${TAG} Payment ${paymentId} ignorado (${skipReason})`);
        return { skipped: true, paymentId, reason: skipReason };
    }

    if (locked.billingType !== 'convenio') {
        // Libera o lock se inválido
        await Payment.updateOne({ _id: paymentId }, { $unset: { _billingEventId: 1 } });
        throw new Error(`${TAG} Payment ${paymentId} não é de convenio (billingType=${locked.billingType})`);
    }

    const now = paidAt || new Date();
    const sessionDate = financialDate || (locked.session
        ? (await Session.findById(locked.session).select('date').lean())?.date
        : null) || now;

    const { payment: updated } = await transitionPaymentStatus(paymentId, 'paid', {
        paymentMethod: 'convenio',
        paidAt: now,
        financialDate: sessionDate,
        reason
    });

    // Atualiza insurance.status → received
    await Payment.updateOne(
        { _id: paymentId },
        { $set: { 'insurance.status': 'received', 'insurance.receivedAt': now.toISOString().split('T')[0] } }
    );

    await appendEvent({
        type: 'INSURANCE_PAYMENT_AUTO_SETTLED',
        aggregateId: paymentId.toString(),
        payload: { paymentId: paymentId.toString(), amount: locked.amount, reason, settledAt: now }
    });

    console.log(`${TAG} Settled payment ${paymentId} — R$${locked.amount} (${reason})`);
    return { settled: true, paymentId, amount: locked.amount };
}

// ──────────────────────────────────────────────────────────────────────────
// Busca payments avulsos (não estão em nenhum batch)
// ──────────────────────────────────────────────────────────────────────────
async function findAvulsoPayments() {
    // Todos payments de convênio pendentes com valor real
    const candidates = await Payment.find({
        billingType: 'convenio',
        status: 'pending',
        amount: { $gt: 0 },
        'insurance.status': { $in: ['pending_billing', 'billed'] }
    }).select('_id amount session insurance').lean();

    if (candidates.length === 0) return [];

    // Quais estão em algum batch?
    const candidateIds = candidates.map(p => p._id);
    const batchesWithPayments = await InsuranceBatch.find({
        'sessions.payment': { $in: candidateIds }
    }).select('sessions.payment').lean();

    const inBatchSet = new Set(
        batchesWithPayments.flatMap(b => b.sessions.map(s => s.payment?.toString()).filter(Boolean))
    );

    // Avulsos = não estão em nenhum batch
    return candidates.filter(p => !inBatchSet.has(p._id.toString()));
}

// ──────────────────────────────────────────────────────────────────────────
// Valida se a session associada está realmente completed
// ──────────────────────────────────────────────────────────────────────────
async function isSessionCompleted(sessionId) {
    if (!sessionId) return true; // sem session = não bloqueia (legado)
    const session = await Session.findById(sessionId).select('status').lean();
    return session?.status === 'completed';
}

// ──────────────────────────────────────────────────────────────────────────
// MAIN: roda settlement para todos os avulsos elegíveis
// ──────────────────────────────────────────────────────────────────────────
export async function runAvulsoSettlement({ dryRun = false } = {}) {
    console.log(`${TAG} Iniciando settlement avulso (dryRun=${dryRun})...`);

    const avulsos = await findAvulsoPayments();
    console.log(`${TAG} ${avulsos.length} payments avulsos candidatos`);

    let settled = 0, skipped = 0, errors = 0;
    const log = [];

    for (const payment of avulsos) {
        try {
            const ok = await isSessionCompleted(payment.session);
            if (!ok) {
                console.log(`${TAG} Payment ${payment._id} ignorado — session não completed`);
                skipped++;
                log.push({ paymentId: payment._id, status: 'skipped', reason: 'session_not_completed' });
                continue;
            }

            if (dryRun) {
                log.push({ paymentId: payment._id, amount: payment.amount, status: 'would_settle' });
                settled++;
                continue;
            }

            await settleInsurancePayment(payment._id, { reason: 'auto_avulso_settlement' });
            settled++;
            log.push({ paymentId: payment._id, amount: payment.amount, status: 'settled' });
        } catch (err) {
            errors++;
            log.push({ paymentId: payment._id, status: 'error', error: err.message });
            console.error(`${TAG} Erro ao settle ${payment._id}:`, err.message);
        }
    }

    const summary = {
        total: avulsos.length,
        settled,
        skipped,
        errors,
        dryRun,
        runAt: new Date().toISOString(),
        log
    };
    console.log(`${TAG} Resultado:`, JSON.stringify({ settled, skipped, errors, dryRun }));
    return summary;
}

// ──────────────────────────────────────────────────────────────────────────
// Settle um lote inteiro (para uso no receberLote quando batch existe)
// ──────────────────────────────────────────────────────────────────────────
export async function settleBatch(batchId, { reason = 'manual_batch_receive', paidAt } = {}) {
    const batch = await InsuranceBatch.findById(batchId).lean();
    if (!batch) throw new Error(`${TAG} Batch ${batchId} não encontrado`);

    const results = [];
    for (const s of batch.sessions || []) {
        if (!s.payment) continue;
        try {
            const result = await settleInsurancePayment(s.payment, { reason, paidAt });
            results.push(result);
        } catch (err) {
            results.push({ paymentId: s.payment, error: err.message });
        }
    }

    await InsuranceBatch.updateOne({ _id: batchId }, { $set: { status: 'received', processedAt: new Date() } });
    return results;
}
