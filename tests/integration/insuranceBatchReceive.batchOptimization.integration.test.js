/**
 * receiveInsuranceBatch() — otimização do recebimento de NF/guia (2026-09-02)
 *
 * Contexto: o loop sequencial antigo (transitionPaymentStatus + 2º .save() +
 * recordInsuranceReceived, um Payment por vez) virou 1 Payment.bulkWrite + 1
 * FinancialLedger.insertMany + Outbox dedupe+insertMany, tudo dentro da mesma
 * transação (ver services/paymentStatusService.js#transitionPaymentStatusBatchToReceived
 * e services/insuranceBatch/paymentReceiptInvariants.js).
 *
 * Este arquivo tem dois papéis:
 *   1. Caracterização — trava o comportamento OBSERVÁVEL (campos finais do
 *      Payment, quantidade/valores/referências do Ledger, quantidade/conteúdo
 *      do Outbox, estado final do Batch) para N=30 e para recebimento parcial
 *      por guideIds. Estes testes devem passar tanto contra o código antigo
 *      quanto contra o novo — provam que a otimização não mudou nada
 *      observável.
 *   2. Instrumentação — conta operações Mongo reais (via debug do mongoose)
 *      para provar que o total não cresce linearmente com N. Este é o único
 *      bloco que só passa contra o código NOVO (o antigo é O(6N) por
 *      construção).
 *
 * Usa MongoMemoryReplSet pelo mesmo motivo do arquivo fourModels: transação
 * multi-documento exige replica set.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let mongod;
let Payment, Session, Appointment, InsuranceBatch, FinancialLedger, Outbox;
let receiveInsuranceBatch;

beforeAll(async () => {
    mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongod.getUri());

    Payment = (await import('../../models/Payment.js')).default;
    Session = (await import('../../models/Session.js')).default;
    Appointment = (await import('../../models/Appointment.js')).default;
    InsuranceBatch = (await import('../../models/InsuranceBatch.js')).default;
    FinancialLedger = (await import('../../models/FinancialLedger.js')).default;
    Outbox = (await import('../../infrastructure/outbox/OutboxModel.js')).default;
    ({ receiveInsuranceBatch } = await import('../../services/insuranceBatch/InsuranceBatchReceiptService.js'));
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

// FinancialLedger é imutável por schema (pre deleteMany bloqueia) — limpeza
// de teste usa a collection nativa, contornando o middleware de propósito.
async function resetCollections() {
    await Payment.deleteMany({});
    await Session.deleteMany({});
    await Appointment.deleteMany({});
    await InsuranceBatch.deleteMany({});
    await FinancialLedger.collection.deleteMany({});
    await Outbox.deleteMany({});
}

beforeEach(resetCollections);

async function insertAppointmentFixture() {
    const id = new mongoose.Types.ObjectId();
    await Appointment.collection.insertOne({ _id: id, specialty: 'fonoaudiologia', channel: 'manual' });
    return id;
}

/**
 * Cria N sessões completed + N Payments 'billed' + 1 InsuranceBatch 'sent'
 * cobrindo todas. `guideAssignment(i)` decide a guia de cada item (default:
 * uma guia própria por item — sem agrupamento).
 */
async function buildBatchWithNPayments(n, { provider = 'unimed-teste', guideAssignment, sessionValue = 80 } = {}) {
    const sessions = [];
    const payments = [];
    for (let i = 0; i < n; i++) {
        const appointmentId = await insertAppointmentFixture();
        const guideId = guideAssignment ? guideAssignment(i) : new mongoose.Types.ObjectId();
        const session = await Session.create({
            patient: new mongoose.Types.ObjectId(), doctor: new mongoose.Types.ObjectId(),
            appointmentId, date: new Date(`2026-08-${String((i % 27) + 1).padStart(2, '0')}T12:00:00Z`),
            status: 'completed', paymentMethod: 'convenio', sessionType: 'fonoaudiologia', sessionValue,
        });
        const payment = await Payment.create({
            patient: new mongoose.Types.ObjectId(), amount: sessionValue,
            paymentDate: new Date('2026-08-01T12:00:00Z'), paymentMethod: 'convenio',
            billingType: 'convenio', status: 'billed', session: session._id, appointment: appointmentId,
            insurance: { status: 'billed', grossAmount: sessionValue },
        });
        sessions.push({ session: session._id, appointment: appointmentId, guide: guideId, payment: payment._id, grossAmount: sessionValue });
        payments.push(payment);
    }
    const batch = await InsuranceBatch.create({
        batchNumber: `LOT-TESTE-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        insuranceProvider: provider,
        startDate: new Date('2026-08-01'), endDate: new Date('2026-08-31'),
        status: 'sent', invoiceNumber: '999', issRate: 2.01, totalGross: sessionValue * n,
        sessions,
    });
    return { batch, payments };
}

describe('Caracterização — N=30 Payments numa única NF', () => {
    it('recebe os 30, campos finais corretos em todos, Ledger com 30 lançamentos somando o líquido, Outbox com 30 eventos, Batch received', async () => {
        const { batch, payments } = await buildBatchWithNPayments(30);
        const userId = new mongoose.Types.ObjectId().toString();

        const result = await receiveInsuranceBatch(batch._id.toString(), { receivedDate: '2026-08-20', userId });

        expect(result.idempotent).toBe(false);
        expect(result.status).toBe('received');
        expect(result.paymentsReceived).toBe(30);

        // ── Payment: campos finais ──────────────────────────────────────
        const reloadedPayments = await Payment.find({ _id: { $in: payments.map(p => p._id) } }).lean();
        expect(reloadedPayments).toHaveLength(30);
        for (const p of reloadedPayments) {
            expect(p.status).toBe('paid');
            expect(p.paymentMethod).toBe('convenio');
            expect(p.paidAt).toBeTruthy();
            expect(p.financialDate).toBeTruthy();
            expect(p.insurance.status).toBe('received');
            expect(p.insurance.grossAmount).toBe(80);
            expect(p.insurance.receivedAmount).toBeGreaterThan(0);
            expect(p.insurance.receivedAt).toBeTruthy();
        }

        // ── Ledger: quantidade, referências, soma líquida ───────────────
        const ledgerEntries = await FinancialLedger.find({
            payment: { $in: payments.map(p => p._id) }, type: 'insurance_received'
        }).lean();
        expect(ledgerEntries).toHaveLength(30);
        for (const entry of ledgerEntries) {
            expect(entry.direction).toBe('credit');
            expect(entry.billingType).toBe('convenio');
            expect(entry.amount).toBeGreaterThan(0);
            expect(entry.correlationId).toMatch(/^insurance_batch_received_/);
            expect(entry.patient).toBeTruthy();
            expect(entry.session).toBeTruthy();
        }
        const ledgerSum = ledgerEntries.reduce((sum, e) => sum + e.amount, 0);

        const reloadedBatch = await InsuranceBatch.findById(batch._id).lean();
        expect(reloadedBatch.status).toBe('received');
        expect(reloadedBatch.receivedAt).toBeTruthy();
        expect(Math.round(ledgerSum * 100)).toBe(Math.round(reloadedBatch.receivedAmount * 100));
        expect(Math.round(ledgerSum * 100)).toBe(Math.round(reloadedBatch.totalNet * 100));

        // ── Outbox: exatamente 1 evento por Payment, formato preservado ──
        const outboxEntries = await Outbox.find({
            eventType: 'PAYMENT_STATUS_CHANGED',
            aggregateId: { $in: payments.map(p => p._id.toString()) }
        }).lean();
        expect(outboxEntries).toHaveLength(30);
        for (const entry of outboxEntries) {
            expect(entry.eventId).toMatch(/^[0-9a-f]{24}_billed_paid_\d{4}-\d{2}-\d{2}$/);
            expect(entry.payload.from).toBe('billed');
            expect(entry.payload.to).toBe('paid');
            expect(entry.payload.billingType).toBe('convenio');
            expect(entry.payload.reason).toBe('insurance_batch_invoice_received');
        }
    });
});

describe('Caracterização — recebimento parcial por guideIds', () => {
    it('recebe só a guia selecionada; a outra guia da mesma NF continua billed, sem Ledger/Outbox extra', async () => {
        const guideA = new mongoose.Types.ObjectId();
        const guideB = new mongoose.Types.ObjectId();
        const { batch, payments } = await buildBatchWithNPayments(6, {
            guideAssignment: i => (i < 3 ? guideA : guideB)
        });

        const result = await receiveInsuranceBatch(batch._id.toString(), {
            receivedDate: '2026-08-20',
            userId: new mongoose.Types.ObjectId().toString(),
            guideIds: [guideA.toString()]
        });

        expect(result.paymentsReceived).toBe(3);
        expect(result.status).toBe('partial');

        const reloaded = await Payment.find({ _id: { $in: payments.map(p => p._id) } }).lean();
        expect(reloaded.filter(p => p.insurance.status === 'received')).toHaveLength(3);
        expect(reloaded.filter(p => p.insurance.status === 'billed')).toHaveLength(3);
        expect(reloaded.filter(p => p.status === 'paid')).toHaveLength(3);
        expect(reloaded.filter(p => p.status === 'billed')).toHaveLength(3);

        const ledgerEntries = await FinancialLedger.find({ payment: { $in: payments.map(p => p._id) } }).lean();
        expect(ledgerEntries).toHaveLength(3);

        const outboxEntries = await Outbox.find({
            eventType: 'PAYMENT_STATUS_CHANGED',
            aggregateId: { $in: payments.map(p => p._id.toString()) }
        }).lean();
        expect(outboxEntries).toHaveLength(3);

        const reloadedBatch = await InsuranceBatch.findById(batch._id).lean();
        expect(reloadedBatch.status).toBe('partial');
        expect(reloadedBatch.receivedAt).toBeFalsy();

        // Segunda chamada recebendo a guia B completa a NF.
        const second = await receiveInsuranceBatch(batch._id.toString(), {
            receivedDate: '2026-08-21',
            userId: new mongoose.Types.ObjectId().toString(),
            guideIds: [guideB.toString()]
        });
        expect(second.paymentsReceived).toBe(3);
        expect(second.status).toBe('received');

        const ledgerAfter = await FinancialLedger.find({ payment: { $in: payments.map(p => p._id) } }).lean();
        expect(ledgerAfter).toHaveLength(6); // 3 + 3, nenhuma duplicata da primeira leva
    });
});

describe('Concorrência — duas chamadas simultâneas para o mesmo batch', () => {
    it('não duplica Payment, Ledger nem Outbox; batch termina received', async () => {
        const { batch, payments } = await buildBatchWithNPayments(10);
        const args = { receivedDate: '2026-08-20', userId: new mongoose.Types.ObjectId().toString() };

        const results = await Promise.allSettled([
            receiveInsuranceBatch(batch._id.toString(), args),
            receiveInsuranceBatch(batch._id.toString(), args),
        ]);

        const succeeded = results.filter(r => r.status === 'fulfilled');
        expect(succeeded.length).toBeGreaterThanOrEqual(1);

        const reloadedPayments = await Payment.find({ _id: { $in: payments.map(p => p._id) } }).lean();
        expect(reloadedPayments).toHaveLength(10);
        expect(reloadedPayments.every(p => p.status === 'paid')).toBe(true);
        expect(reloadedPayments.every(p => p.insurance.status === 'received')).toBe(true);

        const ledgerEntries = await FinancialLedger.find({ payment: { $in: payments.map(p => p._id) } }).lean();
        expect(ledgerEntries).toHaveLength(10); // não 20

        const outboxEntries = await Outbox.find({
            eventType: 'PAYMENT_STATUS_CHANGED',
            aggregateId: { $in: payments.map(p => p._id.toString()) }
        }).lean();
        expect(outboxEntries).toHaveLength(10); // não 20

        const reloadedBatch = await InsuranceBatch.findById(batch._id).lean();
        expect(reloadedBatch.status).toBe('received');
    });
});

describe('Atomicidade — payment corrompido no meio de um lote de 30 não deixa NENHUM parcialmente recebido', () => {
    it('rejeita o lote inteiro e não grava Ledger nem Outbox nem Payment nenhum', async () => {
        const { batch, payments } = await buildBatchWithNPayments(30);

        // Corrompe um Payment do meio via driver raw (bypassa os hooks/guardas de
        // escrita) — simula um registro que escapou das guardas normais.
        await Payment.collection.updateOne(
            { _id: payments[15]._id },
            { $set: { isFromPackage: true, kind: 'package_consumed' } }
        );

        await expect(receiveInsuranceBatch(batch._id.toString(), {
            receivedDate: '2026-08-20',
            userId: new mongoose.Types.ObjectId().toString(),
        })).rejects.toThrow();

        const reloadedPayments = await Payment.find({ _id: { $in: payments.map(p => p._id) } }).lean();
        expect(reloadedPayments.every(p => p.status === 'billed')).toBe(true);
        expect(reloadedPayments.every(p => p.insurance.status === 'billed')).toBe(true);

        const ledgerEntries = await FinancialLedger.find({ payment: { $in: payments.map(p => p._id) } }).lean();
        expect(ledgerEntries).toHaveLength(0);

        const outboxEntries = await Outbox.find({
            eventType: 'PAYMENT_STATUS_CHANGED',
            aggregateId: { $in: payments.map(p => p._id.toString()) }
        }).lean();
        expect(outboxEntries).toHaveLength(0);

        const reloadedBatch = await InsuranceBatch.findById(batch._id).lean();
        expect(reloadedBatch.status).toBe('sent');
    });
});

describe('Instrumentação — contagem real de operações Mongo (não cresce linearmente com N)', () => {
    /**
     * Conta comandos via mongoose.set('debug', fn) — captura toda chamada
     * collection.<method>(...) que o driver executa, dentro e fora de
     * transação. Não mede tempo de parede (não confiável em MongoMemoryReplSet
     * local) — mede contagem real de operações, que é determinística.
     */
    function countMongoOperations(fn) {
        const calls = [];
        const originalDebug = mongoose.get('debug');
        mongoose.set('debug', (collectionName, method) => {
            calls.push(`${collectionName}.${method}`);
        });
        return fn().finally(() => mongoose.set('debug', originalDebug || false));
    }

    it('N=1 e N=30: a contagem de operações do lote de Payments não escala 1:1 com N', async () => {
        const { batch: batch1, payments: payments1 } = await buildBatchWithNPayments(1);
        const calls1 = [];
        await countMongoOperations(async () => {
            mongoose.set('debug', (collectionName, method) => calls1.push(`${collectionName}.${method}`));
            await receiveInsuranceBatch(batch1._id.toString(), {
                receivedDate: '2026-08-20', userId: new mongoose.Types.ObjectId().toString()
            });
        });

        await resetCollections();

        const { batch: batch30 } = await buildBatchWithNPayments(30);
        const calls30 = [];
        await countMongoOperations(async () => {
            mongoose.set('debug', (collectionName, method) => calls30.push(`${collectionName}.${method}`));
            await receiveInsuranceBatch(batch30._id.toString(), {
                receivedDate: '2026-08-20', userId: new mongoose.Types.ObjectId().toString()
            });
        });

        // Só as operações da PRÓPRIA receiveInsuranceBatch (payments/insurancebatches/
        // financial_ledger/outboxes) — exclui ruído de setup (sessions/appointments
        // já foram criados antes de o debug ligar).
        const relevant = (calls) => calls.filter(c => /^(payments|insurancebatches|financial_ledger|outboxes)\./.test(c));
        const ops1 = relevant(calls1);
        const ops30 = relevant(calls30);

        console.log(`[instrumentação] N=1: ${ops1.length} operações Mongo — ${JSON.stringify(ops1)}`);
        console.log(`[instrumentação] N=30: ${ops30.length} operações Mongo — ${JSON.stringify(ops30)}`);

        // O antigo era ~3-4 fixas + 6N (9 pra N=1, 183 pra N=30 — cresce quase
        // 1:1 com N). O novo é um número fixo de operações batch, independente
        // de N. Prova de "não linear": N=30 não pode custar nem perto de 30x N=1.
        expect(ops30.length).toBeLessThan(ops1.length * 5);
        // E em termos absolutos, bem abaixo do que 6×30=180 do fluxo antigo.
        expect(ops30.length).toBeLessThan(20);
    });
});
