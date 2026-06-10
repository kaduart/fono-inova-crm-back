// services/paymentSync.service.js
// 🔄 SINCRONIZADOR DE PAYMENTS <-> APPOINTMENT.paymentForms
//
// Regra: Payment é SSOT financeiro, mas quando o usuário altera o split
// de pagamento no agendamento (paymentForms), os Payments devem refletir
// a nova realidade. Isso é feito via REVERSÃO + RECRIAÇÃO (audit trail).
//
// NÃO sincroniza:
//   - package_receipt (venda de pacote — imutável)
//   - isFromPackage=true (consumo de pacote pré-pago — não é caixa real)
//   - monthly_settlement / debt_settlement (pagamentos agregados)

import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import crypto from 'crypto';

const EXCLUDED_KINDS = ['package_receipt', 'monthly_settlement', 'debt_settlement', 'package_consumed'];

function normalizeMethod(method) {
    const m = String(method || '').toLowerCase().trim();
    const map = {
        pix: 'pix',
        dinheiro: 'dinheiro', cash: 'dinheiro',
        'cartão': 'cartão', cartao: 'cartão', cartao_credito: 'cartão',
        credito: 'cartão', debito: 'cartão', cartao_debito: 'cartão',
        credit_card: 'cartão', debit_card: 'cartão',
        transferencia: 'transferencia_bancaria', transferencia_bancaria: 'transferencia_bancaria',
        bank_transfer: 'transferencia_bancaria',
        convenio: 'convenio', liminar_credit: 'liminar_credit'
    };
    return map[m] || m || 'dinheiro';
}

function computePaymentSyncHash(paymentForms) {
    if (!Array.isArray(paymentForms) || paymentForms.length === 0) return null;
    const normalized = paymentForms
        .map(f => ({ method: normalizeMethod(f.method), amount: Number(f.amount || 0) }))
        .sort((x, y) => x.method.localeCompare(y.method) || x.amount - y.amount);
    const payload = JSON.stringify(normalized);
    return crypto.createHash('sha256').update(payload).digest('hex');
}

function paymentFormsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const sort = (arr) => [...arr].sort((x, y) => (x.method || '').localeCompare(y.method || '') || (x.amount || 0) - (y.amount || 0));
    const sa = sort(a);
    const sb = sort(b);
    return sa.every((it, i) => normalizeMethod(it.method) === normalizeMethod(sb[i].method) && (it.amount || 0) === (sb[i].amount || 0));
}

/**
 * Sincroniza Payments de um appointment com base no appointment.paymentForms.
 *
 * @param {string} appointmentId
 * @param {mongoose.ClientSession} [mongoSession]
 * @returns {Promise<{reversed: number, created: number, appointmentId: string}>}
 */
export async function syncAppointmentPayments(appointmentId, mongoSession = null) {
    const appointment = await Appointment.findById(appointmentId)
        .select('patient doctor date time serviceType sessionType specialty billingType insuranceProvider insuranceValue authorizationCode paymentForms payment session package')
        .lean();

    if (!appointment) {
        console.warn(`[paymentSync] Appointment ${appointmentId} não encontrado`);
        return { reversed: 0, created: 0, appointmentId, note: 'appointment_not_found' };
    }

    if (!appointment.paymentForms?.length) {
        return { reversed: 0, created: 0, appointmentId, note: 'no_paymentForms' };
    }

    // 🔒 IDEMPOTÊNCIA: comparar hash do split desejado vs hash salvo
    const desiredHash = computePaymentSyncHash(appointment.paymentForms);
    if (desiredHash && appointment.paymentSyncHash === desiredHash) {
        console.log(`[paymentSync] Appointment ${appointmentId} já está sincronizado (hash match). Skip.`);
        return { reversed: 0, created: 0, appointmentId, note: 'hash_match_skip' };
    }

    // Buscar payments vinculados ao appointment (ou session) que não estão cancelados
    const query = {
        $or: [
            { appointment: appointmentId },
            ...(appointment.session ? [{ session: appointment.session }] : [])
        ],
        status: { $nin: ['canceled', 'cancelado'] },
        kind: { $nin: EXCLUDED_KINDS },
        isFromPackage: { $ne: true }
    };

    const existingPayments = await Payment.find(query)
        .session(mongoSession)
        .sort({ createdAt: 1 })
        .lean();

    // Se não há payments elegíveis, nada a sincronizar (o complete/create deve criar)
    if (!existingPayments.length) {
        return { reversed: 0, created: 0, appointmentId, note: 'no_eligible_payments' };
    }

    // Montar "split atual" dos payments existentes
    const existingSplit = existingPayments.map(p => ({
        method: p.paymentMethod,
        amount: p.amount
    }));

    const desiredSplit = appointment.paymentForms.map(f => ({
        method: f.method,
        amount: f.amount
    }));

    // Se já está igual, não faz nada
    if (paymentFormsEqual(existingSplit, desiredSplit)) {
        return { reversed: 0, created: 0, appointmentId, note: 'already_in_sync' };
    }

    console.log(`[paymentSync] 🔄 Divergência detectada em ${appointmentId}. Revertendo ${existingPayments.length} payment(s) e recriando ${desiredSplit.length}.`);

    const now = new Date();
    const session = mongoSession || await mongoose.startSession();
    let ownsSession = !mongoSession;

    try {
        if (ownsSession) {
            await session.startTransaction();
        }

        // 1. Reverter (cancelar) payments existentes
        for (const p of existingPayments) {
            await Payment.findByIdAndUpdate(
                p._id,
                {
                    $set: {
                        status: 'canceled',
                        canceledAt: now,
                        canceledReason: 'sync_reversal: paymentForms updated',
                        updatedAt: now
                    }
                },
                { session }
            );
            console.log(`[paymentSync] ❌ Payment ${p._id} cancelado (sync_reversal)`);
        }

        // 2. Recriar payments conforme novo split
        const splitGroupId = crypto.randomUUID();
        const createdPayments = [];
        for (const form of appointment.paymentForms) {
            const paymentDate = form.date ? new Date(form.date) : now;
            const [doc] = await Payment.create([{
                patient: appointment.patient,
                doctor: appointment.doctor,
                appointment: appointmentId,
                session: appointment.session || null,
                amount: form.amount || 0,
                paymentMethod: normalizeMethod(form.method),
                paymentDate,
                financialDate: paymentDate,
                paidAt: now,
                status: 'paid',
                kind: 'session_payment',
                billingType: appointment.billingType || 'particular',
                serviceType: appointment.serviceType || appointment.sessionType || null,
                serviceDate: appointment.date,
                insuranceProvider: appointment.insuranceProvider || null,
                insuranceValue: appointment.insuranceValue || 0,
                authorizationCode: appointment.authorizationCode || null,
                splitGroupId,
                source: 'appointment_split',
                notes: `Sincronizado via paymentSync — split atualizado em ${now.toISOString()} #${splitGroupId}`,
                createdAt: now,
                updatedAt: now
            }], { session });
            createdPayments.push(doc);
            console.log(`[paymentSync] ✅ Payment ${doc._id} criado: ${normalizeMethod(form.method)} ${form.amount}`);
        }

        // 3. Atualizar appointment.payment e paymentSyncHash
        if (createdPayments.length > 0) {
            await Appointment.findByIdAndUpdate(
                appointmentId,
                {
                    $set: {
                        payment: createdPayments[0]._id,
                        paymentSyncHash: desiredHash,
                        updatedAt: now
                    }
                },
                { session }
            );
        }

        if (ownsSession) {
            await session.commitTransaction();
        }

        return {
            reversed: existingPayments.length,
            created: createdPayments.length,
            appointmentId,
            newPaymentIds: createdPayments.map(p => p._id.toString())
        };
    } catch (err) {
        if (ownsSession) {
            await session.abortTransaction();
        }
        console.error(`[paymentSync] 💥 Erro ao sincronizar ${appointmentId}:`, err.message);
        throw err;
    } finally {
        if (ownsSession) {
            session.endSession();
        }
    }
}

export default { syncAppointmentPayments };
