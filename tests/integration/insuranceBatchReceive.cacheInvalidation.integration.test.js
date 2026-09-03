/**
 * receiveInsuranceBatch() → calculateMetaRealizada + cache de cashflow (2026-09-03)
 *
 * calculateMetaRealizada não tem cache próprio (ver unifiedFinancialService.v2.js —
 * decisão registrada lá), então o valor recalculado já é sempre correto. O que
 * este teste prova é a camada ACIMA: o endpoint de cashflow (routes/cashflow.v2.js)
 * cacheia a resposta inteira (que inclui metaRealizada) em Redis, e até esta
 * mudança (2026-09-03) o recebimento em lote de convênio — que usa
 * Payment.bulkWrite via transitionPaymentStatusBatchToReceived, não .save() —
 * não invalidava esse cache Redis nenhuma vez.
 *
 * Dois bugs corrigidos e travados aqui:
 *   1. InsuranceBatchReceiptService.js não chamava invalidateDashboardCache()
 *      nem clearCashflowCache() depois do recebimento.
 *   2. clearCashflowCache() (routes/cashflow.v2.js) chama safeRedis.scan() pra
 *      invalidação em massa — método que nunca existiu em safeRedis
 *      (config/redisConnection.js). O erro era engolido pelo try/catch do
 *      chamador, então a invalidação Redis "completa" nunca removia nada.
 *
 * Usa MongoMemoryReplSet (transação multi-documento) + o Redis real do
 * ambiente de dev (mesma conexão usada pelos outros testes de integração) —
 * chave de teste isolada sob o prefixo real (cashflow:v2:) pra exercitar o
 * SCAN de verdade, limpa no afterAll.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let mongod;
let Payment, Session, Appointment, InsuranceBatch, FinancialLedger, Outbox;
let receiveInsuranceBatch;
let calculateMetaRealizada;
let safeRedis;

const REDIS_CACHE_PREFIX = 'cashflow:v2:';
const TEST_REDIS_KEY = `${REDIS_CACHE_PREFIX}__test_meta_realizada_integration__`;

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
    ({ calculateMetaRealizada } = await import('../../services/unifiedFinancialService.v2.js'));
    ({ safeRedis } = await import('../../config/redisConnection.js'));
}, 60000);

afterAll(async () => {
    await safeRedis.del(TEST_REDIS_KEY);
    await mongoose.disconnect();
    await mongod.stop();
});

async function resetCollections() {
    await Payment.deleteMany({});
    await Session.deleteMany({});
    await Appointment.deleteMany({});
    await InsuranceBatch.deleteMany({});
    await FinancialLedger.collection.deleteMany({});
    await Outbox.deleteMany({});
    await safeRedis.del(TEST_REDIS_KEY);
}

beforeEach(resetCollections);

const MONTH_START = new Date('2026-08-01T03:00:00.000Z');
const MONTH_END = new Date('2026-09-01T02:59:59.999Z');

async function buildSingleConvenioBatch({ amount = 180 } = {}) {
    const appointmentId = new mongoose.Types.ObjectId();
    await Appointment.collection.insertOne({ _id: appointmentId, specialty: 'fonoaudiologia', channel: 'manual' });
    const session = await Session.create({
        patient: new mongoose.Types.ObjectId(), doctor: new mongoose.Types.ObjectId(),
        appointmentId, date: new Date('2026-08-15T12:00:00Z'),
        status: 'completed', paymentMethod: 'convenio', sessionType: 'fonoaudiologia', sessionValue: amount,
    });
    const payment = await Payment.create({
        patient: new mongoose.Types.ObjectId(), amount,
        paymentDate: new Date('2026-08-01T12:00:00Z'), paymentMethod: 'convenio',
        billingType: 'convenio', status: 'billed', session: session._id, appointment: appointmentId,
        insurance: { status: 'billed', grossAmount: amount },
    });
    const guideId = new mongoose.Types.ObjectId();
    const batch = await InsuranceBatch.create({
        batchNumber: `LOT-CACHE-TESTE-${Date.now()}`,
        insuranceProvider: 'unimed-teste',
        startDate: new Date('2026-08-01'), endDate: new Date('2026-08-31'),
        status: 'sent', invoiceNumber: '999', issRate: 2.01, totalGross: amount,
        sessions: [{ session: session._id, appointment: appointmentId, guide: guideId, payment: payment._id, grossAmount: amount }],
    });
    return { batch, payment };
}

describe('recebimento em lote de convênio (bulkWrite) → Meta Realizada + cache Redis do cashflow', () => {
    it('calculateMetaRealizada não tem cache — reflete o recebimento na consulta seguinte sem qualquer espera', async () => {
        const { batch } = await buildSingleConvenioBatch({ amount: 220 });

        const before = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(before.total).toBe(0); // ainda 'billed', não 'paid'

        await receiveInsuranceBatch(batch._id.toString(), {
            receivedDate: '2026-08-20',
            userId: new mongoose.Types.ObjectId().toString(),
        });

        const after = await calculateMetaRealizada(MONTH_START, MONTH_END);
        expect(after.total).toBeGreaterThan(0);
        expect(after.porTipo.convenio).toBeGreaterThan(0);
    });

    it('receiveInsuranceBatch invalida o cache Redis do cashflow (prefixo cashflow:v2:) via clearCashflowCache — antes deste fix, safeRedis.scan não existia e nada era removido', async () => {
        const { batch } = await buildSingleConvenioBatch({ amount: 300 });

        // "Aquece" o cache Redis do endpoint de cashflow com uma chave real do
        // prefixo usado por routes/cashflow.v2.js — clearCashflowCache() sem
        // data faz SCAN + DEL por esse prefixo inteiro.
        await safeRedis.set(TEST_REDIS_KEY, JSON.stringify({ stale: true }), 'EX', 300);
        const seeded = await safeRedis.get(TEST_REDIS_KEY);
        expect(seeded).not.toBeNull(); // pré-condição: Redis está disponível e a chave foi gravada

        await receiveInsuranceBatch(batch._id.toString(), {
            receivedDate: '2026-08-20',
            userId: new mongoose.Types.ObjectId().toString(),
        });

        // dá um instante pro clearCashflowCache() (chamado sem await, .catch())
        // terminar — SCAN+DEL contra Redis real não é instantâneo.
        await new Promise(resolve => setTimeout(resolve, 300));

        const afterReceive = await safeRedis.get(TEST_REDIS_KEY);
        expect(afterReceive).toBeNull();
    });
});
