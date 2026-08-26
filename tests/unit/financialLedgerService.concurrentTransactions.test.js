/**
 * 🔴🟢 Concorrência real: DUAS transações MongoDB separadas, cada uma
 * chamando recordPaymentReceived() com sua PRÓPRIA mongoSession, disparadas
 * ao mesmo tempo (Promise.all) — não duas chamadas soltas sem transação.
 *
 * Isso importa porque os dois call sites reais do bug (routes/payment.v2.js
 * create-sync e completeSessionService.v2.js) SEMPRE chamam
 * recordPaymentReceived dentro da PRÓPRIA transação. O teste anterior
 * (financialLedgerService.raceCondition.repro.test.js) prova a idempotência
 * sem transação; este prova que, quando as duas chamadas correm dentro de
 * transações reais e verdadeiramente concorrentes, NENHUMA das duas:
 *   - recebe erro 11000 (chave duplicada) propagado pro chamador;
 *   - tem sua transação de negócio abortada indevidamente por causa da
 *     tentativa duplicada (a transação "perdedora" precisa COMMITAR mesmo
 *     assim, só sem criar um segundo crédito).
 *
 * E ao final: exatamente um crédito líquido no ciclo.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Payment from '../../models/Payment.js';
import FinancialLedger from '../../models/FinancialLedger.js';
import { recordPaymentReceived } from '../../services/financialLedgerService.js';

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongod.getUri());
    await FinancialLedger.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await Payment.deleteMany({});
    await FinancialLedger.collection.deleteMany({});
});

function fakePayment(overrides = {}) {
    return {
        _id: new mongoose.Types.ObjectId(),
        patient: new mongoose.Types.ObjectId(),
        appointment: new mongoose.Types.ObjectId(),
        session: new mongoose.Types.ObjectId(),
        amount: 160,
        paymentMethod: 'pix',
        paidAt: new Date('2026-08-21T18:00:00Z'),
        paymentDate: new Date('2026-08-21T18:00:00Z'),
        ...overrides,
    };
}

/**
 * Simula um call site real (create-sync / completeSessionV2): abre sua
 * PRÓPRIA transação, chama recordPaymentReceived dentro dela, faz mais um
 * write de negócio qualquer (aqui: marca um campo no Payment simulando
 * "sessão concluída"), e comita. Se qualquer parte falhar, a transação
 * inteira aborta — exatamente como completeSessionV2 real se comportaria.
 */
// Campo real do schema (não declarado só pra teste) usado como marcador de
// "esta transação de negócio chegou a commitar" — evita o mesmo footgun do
// strict mode do Mongoose descartando campos não-declarados em updateOne.
const BUSINESS_MARKER_FIELD = { create_sync: 'notes', complete_session: 'canceledReason' };

async function simulateRealCallSite(payment, label) {
    const session = await mongoose.startSession();
    let outcome;
    try {
        await session.withTransaction(async () => {
            const credit = await recordPaymentReceived(payment, { correlationId: `${label}_${Date.now()}` }, session);
            // Trabalho de negócio adicional na MESMA transação — se a
            // transação fosse abortada indevidamente por causa da
            // duplicidade, isso nunca seria persistido.
            await Payment.updateOne(
                { _id: payment._id },
                { $set: { [BUSINESS_MARKER_FIELD[label]]: `marker_${label}` } },
                { session }
            );
            outcome = { ok: true, creditId: credit._id.toString() };
        });
    } catch (err) {
        outcome = { ok: false, error: err.message, code: err.code };
    } finally {
        await session.endSession();
    }
    return outcome;
}

describe('[cenário 1 — concorrência real] duas transações separadas, mesma chamada de negócio', () => {
    it('nenhuma das duas falha pro chamador; nenhum erro 11000 vaza; exatamente um crédito; nenhuma transação de negócio é abortada indevidamente', async () => {
        const payment = fakePayment();
        // Payment real no banco (necessário pro $set de negócio dentro da transação).
        await Payment.create({ _id: payment._id, patient: payment.patient, amount: 160, paymentDate: payment.paymentDate, paidAt: payment.paidAt, financialDate: payment.paidAt, paymentMethod: 'pix', status: 'paid', billingType: 'particular', kind: 'session_payment' });

        const [resultA, resultB] = await Promise.all([
            simulateRealCallSite(payment, 'create_sync'),
            simulateRealCallSite(payment, 'complete_session'),
        ]);

        // Nenhuma chamada pode devolver erro ao chamador — nem 11000, nem
        // "Transaction has been aborted", nem qualquer outro.
        expect(resultA.ok).toBe(true);
        expect(resultB.ok).toBe(true);
        expect(resultA.code).not.toBe(11000);
        expect(resultB.code).not.toBe(11000);

        // As DUAS transações de negócio precisam ter commitado de verdade —
        // os dois marcadores devem estar persistidos, provando que nenhuma
        // foi abortada por causa da tentativa duplicada de crédito.
        const reloaded = await Payment.findById(payment._id).lean();
        expect(reloaded.notes).toBe('marker_create_sync');
        expect(reloaded.canceledReason).toBe('marker_complete_session');

        // Exatamente um crédito líquido no ciclo.
        const entries = await FinancialLedger.find({ payment: payment._id, type: 'payment_received' }).lean();
        expect(entries).toHaveLength(1);
    }, 20000);
});
