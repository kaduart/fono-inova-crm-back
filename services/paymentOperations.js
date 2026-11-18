// services/paymentOperations.js
// Idempotência das operações de dinheiro do paymentWorker:
// multi_payment, standalone e balance_credit.
//
// IDENTIDADE DA OPERAÇÃO
//   operationKey = `payop:<tipo>:<idempotencyKey do evento | eventId>`
//   - multi_payment: a API já gera a chave natural
//     `payment_multi_<paciente>_<débitos ordenados>`; pagar os mesmos débitos
//     duas vezes é a mesma operação.
//   - standalone / balance_credit: a chave vem do cabeçalho Idempotency-Key
//     quando o cliente envia (estável entre reenvios HTTP); sem ele, a chave é
//     única por requisição e protege reentrega, retry e reinício do worker,
//     mas não um segundo clique que gera outra requisição.
//
// GARANTIA
//   O registro PaymentOperation (_id = operationKey) é inserido NA MESMA
//   transação que Payment, PatientBalance e o lançamento do ledger. A
//   unicidade do _id decide quem aplica; não depende de consulta prévia (a
//   consulta prévia existe só como atalho). Reentrega, reinício e execução
//   concorrente da mesma chave devolvem o resultado gravado. Mesma chave com
//   conteúdo financeiro diferente é IDEMPOTENCY_KEY_CONFLICT (não retentável).
//
// O QUE NÃO É GARANTIDO
//   Efeitos depois do commit (projeções, eventos, notificação) são pelo menos
//   uma vez: se o processo cair entre o commit e sideEffectsAt, a reentrega os
//   executa de novo, com chaves de idempotência derivadas da operação.

import crypto from 'crypto';
import mongoose from 'mongoose';
import PaymentOperation from '../models/PaymentOperation.js';
import Payment from '../models/Payment.js';
import PatientBalance from '../models/PatientBalance.js';
import { NonRetryableError } from '../infrastructure/events/errorClassifier.js';

export const OPERATION_KINDS = Object.freeze(['multi_payment', 'standalone', 'balance_credit']);
export const CONFLICT_CODE = 'IDEMPOTENCY_KEY_CONFLICT';
export const DEBITS_NOT_PAYABLE_CODE = 'MULTI_PAYMENT_DEBITS_NOT_PAYABLE';

const MAX_APPLY_ATTEMPTS = 3;

const cents = (v) => Math.round(Number(v || 0) * 100);
const asObjectIdOrNull = (v) => (v && mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24
    ? new mongoose.Types.ObjectId(String(v))
    : null);

export function operationKeyFor(kind, { idempotencyKey, eventId } = {}) {
    if (!OPERATION_KINDS.includes(kind)) {
        throw new NonRetryableError(`PAYMENT_OPERATION_KIND_INVALID: ${kind}`, 'INVALID_PAYLOAD');
    }
    const base = idempotencyKey || eventId;
    if (!base) {
        throw new NonRetryableError('PAYMENT_OPERATION_KEY_MISSING', 'INVALID_PAYLOAD');
    }
    return `payop:${kind}:${base}`;
}

/**
 * Impressão digital só dos campos financeiros. Notas, requestedAt e
 * correlationId mudam a cada reenvio HTTP e não entram.
 */
export function requestFingerprint(kind, p = {}) {
    let f;
    if (kind === 'multi_payment') {
        f = {
            kind,
            patientId: String(p.patientId),
            debitIds: [...(p.debitIds || [])].map(String).sort(),
            totalAmount: cents(p.totalAmount),
            payments: (p.payments || [])
                .map((x) => `${x.paymentMethod || ''}|${cents(x.amount)}`)
                .sort()
        };
    } else {
        f = {
            kind,
            patientId: String(p.patientId),
            amount: cents(p.amount),
            paymentMethod: p.paymentMethod || null
        };
    }
    return crypto.createHash('sha256').update(JSON.stringify(f)).digest('hex');
}

function isOperationDuplicate(err) {
    if (err?.code !== 11000) return false;
    const msg = String(err.message || '');
    return msg.includes('payment_operations') || (err.keyPattern && err.keyPattern._id === 1 && Object.keys(err.keyPattern).length === 1);
}

async function replay(existing, requestHash, log) {
    if (existing.requestHash !== requestHash) {
        const err = new NonRetryableError(
            `${CONFLICT_CODE}: a operação ${existing._id} já foi aplicada com outro conteúdo`,
            CONFLICT_CODE
        );
        err.operationKey = existing._id;
        throw err;
    }
    await PaymentOperation.updateOne({ _id: existing._id }, { $inc: { replays: 1 } });
    log?.info?.('payment_operation_replayed', `Operação já aplicada: ${existing._id}`, {
        paymentId: existing.paymentId,
        sideEffectsPending: !existing.sideEffectsAt
    });
    return {
        applied: false,
        replayed: true,
        operationKey: existing._id,
        paymentId: existing.paymentId || null,
        result: existing.result || null,
        sideEffectsPending: !existing.sideEffectsAt
    };
}

/**
 * Aplica `apply` uma única vez por operationKey.
 * `apply({ session, operationKey, appliedAt })` grava tudo com a session e
 * devolve { paymentId?, result }.
 */
export async function runPaymentOperation({ operationKey, kind, request, eventId = null, apply, log, now = () => new Date() }) {
    const requestHash = requestFingerprint(kind, request);

    // Atalho. A proteção real é o _id único dentro da transação abaixo.
    const prior = await PaymentOperation.findById(operationKey).lean();
    if (prior) return replay(prior, requestHash, log);

    for (let attempt = 1; ; attempt++) {
        const session = await mongoose.startSession();
        let outcome;
        try {
            await session.withTransaction(async () => {
                const appliedAt = now();
                await PaymentOperation.create([{
                    _id: operationKey,
                    kind,
                    requestHash,
                    patient: request.patientId,
                    amount: kind === 'multi_payment' ? Number(request.totalAmount) : Number(request.amount),
                    eventId,
                    appliedAt
                }], { session });

                const out = await apply({ session, operationKey, appliedAt });

                await PaymentOperation.updateOne(
                    { _id: operationKey },
                    { $set: { paymentId: out?.paymentId || null, result: out?.result ?? null } },
                    { session }
                );
                outcome = {
                    applied: true,
                    replayed: false,
                    operationKey,
                    paymentId: out?.paymentId || null,
                    result: out?.result ?? null,
                    sideEffectsPending: true
                };
            });
            return outcome;
        } catch (err) {
            if (isOperationDuplicate(err)) {
                const existing = await PaymentOperation.findById(operationKey).lean();
                if (existing) return replay(existing, requestHash, log);
            }
            // Corrida de upsert do PatientBalance (índice único por paciente)
            // entre operações DIFERENTES: a transação foi abortada inteira,
            // então repetir é seguro.
            if (err?.code === 11000 && attempt < MAX_APPLY_ATTEMPTS && String(err.message || '').includes('patientbalance')) {
                log?.warn?.('payment_operation_retry', 'Corrida de criação do saldo; repetindo a transação', { operationKey, attempt });
                continue;
            }
            throw err;
        } finally {
            await session.endSession();
        }
    }
}

export async function markSideEffectsDone(operationKey, now = new Date()) {
    await PaymentOperation.updateOne(
        { _id: operationKey, sideEffectsAt: null },
        { $set: { sideEffectsAt: now } }
    );
}

// ============ NÚCLEOS (gravam só com a session recebida) ============

/**
 * Pagamento avulso: Payment pago + crédito no saldo + ledger, atômicos.
 * Antes: o crédito no saldo e o ledger ficavam fora de transação e um erro no
 * saldo era engolido ("não-fatal"), deixando Payment sem crédito.
 */
export async function applyStandalone(payload, { session, operationKey, appliedAt }, { correlationId, recordLedger } = {}) {
    const { patientId, amount, paymentMethod, notes, requestedBy } = payload;

    const payment = new Payment({
        patient: patientId,
        patientId,
        amount,
        paymentMethod,
        paymentDate: appliedAt,
        financialDate: appliedAt,
        status: 'paid',
        paidAt: appliedAt,
        billingType: 'particular',
        source: 'manual',
        description: notes || 'Pagamento avulso',
        operationKey
    });
    await payment.save({ session });

    // Mesma semântica de PatientBalance.addCredit: crédito reduz o saldo devedor.
    await PatientBalance.findOneAndUpdate(
        { patient: patientId },
        {
            $inc: { currentBalance: -amount, totalCredited: amount },
            $set: { lastTransactionAt: appliedAt },
            $push: {
                transactions: {
                    type: 'credit',
                    amount,
                    description: notes || 'Crédito de pagamento avulso',
                    registeredBy: asObjectIdOrNull(requestedBy),
                    transactionDate: appliedAt,
                    operationKey
                }
            }
        },
        { upsert: true, new: true, session, setDefaultsOnInsert: true }
    );

    if (recordLedger) await recordLedger(payment, { correlationId }, session);

    return {
        paymentId: payment._id,
        result: { status: 'standalone_payment_completed', paymentId: String(payment._id), patientId: String(patientId), amount }
    };
}

/**
 * Crédito em conta: um lançamento de crédito no saldo, atômico com o
 * registro da operação. Sinal: ver BALANCE_CREDIT_SIGN abaixo.
 */
export const BALANCE_CREDIT_SIGN = -1; // crédito reduz currentBalance (devedor > 0)

export async function applyBalanceCredit(payload, { session, operationKey, appliedAt }) {
    const { patientId, amount, paymentMethod, notes, requestedBy } = payload;

    await PatientBalance.findOneAndUpdate(
        { patient: patientId },
        {
            $inc: { currentBalance: BALANCE_CREDIT_SIGN * amount, totalCredited: amount },
            $set: { lastTransactionAt: appliedAt },
            $push: {
                transactions: {
                    type: 'credit',
                    amount,
                    description: notes || 'Crédito em conta',
                    paymentMethod,
                    registeredBy: asObjectIdOrNull(requestedBy),
                    transactionDate: appliedAt,
                    operationKey
                }
            }
        },
        { upsert: true, new: true, session, setDefaultsOnInsert: true }
    );

    return {
        paymentId: null,
        result: { status: 'balance_credit_completed', patientId: String(patientId), amount }
    };
}

const MULTI_METHOD_MAP = {
    dinheiro: 'cash', pix: 'pix', credit_card: 'credit_card', debit_card: 'debit_card',
    cartao: 'credit_card', 'cartão': 'credit_card', transferencia: 'bank_transfer', 'transferência': 'bank_transfer'
};

/**
 * Pagamento múltiplo: Payment consolidado + quitação dos débitos + saldo +
 * agendamentos + ledger, atômicos.
 * Correção: o filtro exige que TODOS os débitos existam e estejam em aberto.
 * Antes, um débito já pago era "pago de novo" e o saldo era abatido outra vez.
 */
export async function applyMultiPayment(payload, { session, operationKey, appliedAt }, { correlationId, recordLedger, Appointment } = {}) {
    const { patientId, payments, debitIds, totalAmount, requestedBy } = payload;
    const debitOids = debitIds.map((id) => new mongoose.Types.ObjectId(String(id)));
    const rawMethod = payments[0]?.paymentMethod || 'cash';

    const mainPayment = new Payment({
        patient: patientId,
        patientId,
        amount: totalAmount,
        paymentMethod: MULTI_METHOD_MAP[rawMethod] || rawMethod,
        paymentDate: appliedAt,
        financialDate: appliedAt,
        status: 'paid',
        // O código anterior não preenchia paidAt e o guarda do Payment
        // (MISSING_PAID_AT) recusava todo pagamento múltiplo. Ver B-2 no doc.
        paidAt: appliedAt,
        source: 'manual',
        description: `Pagamento múltiplo: ${debitIds.length} débito(s) - Total: R$ ${totalAmount}`,
        operationKey
    });
    await mainPayment.save({ session });

    // Duas escritas na mesma transação: o MongoDB recusa $set em
    // transactions.$[debit] junto com $push em transactions no mesmo update
    // (código 40, "would create a conflict"). O código anterior fazia isso
    // num único update e falhava sempre. Ver B-3 no doc.
    const balanceUpdate = await PatientBalance.findOneAndUpdate(
        {
            patient: patientId,
            transactions: {
                $all: debitOids.map((oid) => ({ $elemMatch: { _id: oid, type: 'debit', isPaid: { $ne: true } } }))
            }
        },
        {
            $set: {
                'transactions.$[debit].isPaid': true,
                'transactions.$[debit].paidAt': appliedAt,
                'transactions.$[debit].paymentId': mainPayment._id,
                lastTransactionAt: appliedAt
            },
            $inc: { currentBalance: -totalAmount, totalCredited: totalAmount }
        },
        {
            session,
            arrayFilters: [{ 'debit._id': { $in: debitOids }, 'debit.type': 'debit' }],
            new: true
        }
    );

    if (!balanceUpdate) {
        throw new NonRetryableError(
            `${DEBITS_NOT_PAYABLE_CODE}: algum débito não existe ou já está pago`,
            DEBITS_NOT_PAYABLE_CODE
        );
    }

    await PatientBalance.updateOne(
        { _id: balanceUpdate._id },
        {
            $push: {
                transactions: {
                    type: 'payment',
                    amount: totalAmount,
                    description: `Pagamento múltiplo - ${debitIds.length} débito(s)`,
                    paymentMethod: payments[0]?.paymentMethod || 'dinheiro',
                    registeredBy: asObjectIdOrNull(requestedBy),
                    transactionDate: appliedAt,
                    operationKey
                }
            }
        },
        { session }
    );

    const wanted = new Set(debitIds.map(String));
    const appointmentIds = balanceUpdate.transactions
        .filter((t) => t.type === 'debit' && wanted.has(String(t._id)) && t.appointmentId)
        .map((t) => t.appointmentId);

    if (appointmentIds.length > 0 && Appointment) {
        await Appointment.updateMany(
            { _id: { $in: appointmentIds } },
            {
                $set: { paymentStatus: 'paid', visualFlag: 'ok', paidAt: appliedAt, updatedAt: appliedAt, _fromWriteGateway: true },
                $push: {
                    history: {
                        action: 'multi_payment_received',
                        newStatus: 'paid',
                        timestamp: appliedAt,
                        context: `Pagamento múltiplo: ${mainPayment._id}`
                    }
                }
            },
            { session }
        );
    }

    if (recordLedger) await recordLedger(mainPayment, { correlationId }, session);

    return {
        paymentId: mainPayment._id,
        result: {
            status: 'multi_payment_completed',
            paymentId: String(mainPayment._id),
            amount: totalAmount,
            debitsCount: debitIds.length,
            appointmentsUpdated: appointmentIds.length
        }
    };
}
