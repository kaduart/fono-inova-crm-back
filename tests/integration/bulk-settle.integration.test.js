/**
 * 🧪 Teste de Integração - bulk-settle
 *
 * Valida:
 * - Cálculo do total a partir dos payments (ignora totalAmount do frontend)
 * - Criação de 1 recibo monthly_settlement consolidado
 * - Idempotência: segundo bulk-settle com mesmos IDs não cria recibo duplicado
 * - Atualização dos payments para paid
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import express from 'express';
import moment from 'moment-timezone';

vi.mock('../../middleware/auth.js', () => ({
    __esModule: true,
    auth: (req, res, next) => {
        req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin' };
        next();
    },
    authorize: () => (req, res, next) => next()
}));

vi.mock('../../config/redisConnection.js', () => ({
    redisConnection: {},
    safeRedis: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(0),
        scan: vi.fn().mockResolvedValue(['0', []])
    }
}));

let mongoReplSet;
let app;
let server;
let Patient, Payment, calculateCash, calculateCashForDashboard, calculateCashByDay, invalidateUFSCache;

beforeAll(async () => {
    mongoReplSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongoReplSet.getUri());

    Patient = (await import('../../models/Patient.js')).default;
    Payment = (await import('../../models/Payment.js')).default;
    await import('../../models/PatientsView.js'); // registrar schema para FinancialGuard/projection

    app = express();
    app.use(express.json());

    const paymentRouter = (await import('../../routes/payment.v2.js')).default;
    app.use('/payments', paymentRouter);
    app.use('/cashflow', (await import('../../routes/cashflow.v2.js')).default);
    app.use('/financial/dashboard', (await import('../../routes/financialDashboard.v2.js')).default);

    ({ calculateCash, calculateCashForDashboard, calculateCashByDay, invalidateUFSCache } = await import('../../services/unifiedFinancialService.v2.js'));

    server = app.listen(0);
});

afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    if (mongoReplSet) await mongoReplSet.stop();
});

beforeEach(async () => {
    await Patient.deleteMany({});
    await Payment.deleteMany({});
    invalidateUFSCache?.();
});

async function createPatient(name) {
    return Patient.create({ fullName: name, phone: '11999999999' });
}

async function createPendingPayment(patient, amount, method = 'pix', overrides = {}) {
    return Payment.create({
        patient: patient._id,
        patientId: patient._id.toString(),
        amount,
        paymentMethod: method,
        status: 'pending',
        paymentDate: new Date(),
        billingType: 'particular',
        kind: 'session_payment',
        kindConfidence: 'high',
        kindSource: 'manual',
        ...overrides
    });
}

async function assertCanonicalCash(expectedTotal, expectedIds) {
    invalidateUFSCache();
    const start = new Date(Date.now() - 86_400_000);
    const end = new Date(Date.now() + 86_400_000);
    const [cash, dashboardCash, daily] = await Promise.all([
        calculateCash(start, end),
        calculateCashForDashboard(start, end),
        calculateCashByDay(start, end)
    ]);
    expect(cash.total).toBe(expectedTotal);
    expect(dashboardCash.total).toBe(expectedTotal);
    expect(Object.values(cash.byMethod).reduce((sum, value) => sum + value, 0)).toBe(expectedTotal);
    expect(Object.values(dashboardCash.byMethod).reduce((sum, value) => sum + value, 0)).toBe(expectedTotal);
    expect([...daily.values()].reduce((sum, day) => sum + day.caixa, 0)).toBe(expectedTotal);
    expect(cash.payments.map(payment => payment._id.toString()).sort()).toEqual([...expectedIds].sort());
}

describe('POST /payments/bulk-settle', () => {
    it('deve quitar múltiplos payments pendentes e criar um recibo consolidado', async () => {
        const patient = await createPatient('Paciente Quitacao');
        const p1 = await createPendingPayment(patient, 100);
        const p2 = await createPendingPayment(patient, 150);
        const p3 = await createPendingPayment(patient, 250);

        const res = await request(server)
            .post('/payments/bulk-settle')
            .send({
                paymentIds: [p1._id.toString(), p2._id.toString(), p3._id.toString()],
                paymentMethod: 'pix',
                totalAmount: 999 // frontend enviou valor errado; backend deve ignorar
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.settledCount).toBe(3);
        expect(res.body.data.totalSettled).toBe(500);
        expect(res.body.data.paymentMethod).toBe('pix');

        const paymentsAfter = await Payment.find({ _id: { $in: [p1._id, p2._id, p3._id] } }).lean();
        expect(paymentsAfter.every(p => p.status === 'paid')).toBe(true);

        const settlements = await Payment.find({
            patient: patient._id,
            kind: 'monthly_settlement',
            status: { $nin: ['cancelled', 'canceled'] }
        }).lean();
        expect(settlements.length).toBe(1);
        expect(settlements[0].amount).toBe(500);
        expect(settlements[0].paymentMethod).toBe('pix');
        expect(settlements[0].settledPaymentIds.map(id => id.toString()).sort()).toEqual(
            [p1._id.toString(), p2._id.toString(), p3._id.toString()].sort()
        );
        expect(settlements[0].bulkSettlementKey).toBeTruthy();
        await assertCanonicalCash(500, [p1._id.toString(), p2._id.toString(), p3._id.toString()]);

        const now = moment.tz('America/Sao_Paulo');
        const [cashflowResponse, dashboardResponse] = await Promise.all([
            request(server).get('/cashflow').query({ date: now.format('YYYY-MM-DD') }),
            request(server).get('/financial/dashboard').query({ month: now.month() + 1, year: now.year() })
        ]);
        expect(cashflowResponse.status).toBe(200);
        expect(dashboardResponse.status).toBe(200);
        expect(cashflowResponse.body.data.caixa.total).toBe(500);
        expect(cashflowResponse.body.data.transacoes.reduce((sum, item) => sum + item.valor, 0)).toBe(500);
        expect(dashboardResponse.body.resumo.caixa).toBe(500);
        expect(Object.values(dashboardResponse.body.resumo.caixaDetalhe.byMethod).reduce((sum, value) => sum + value, 0)).toBe(500);
    });

    it('deve ser idempotente: segundo bulk-settle com mesmos IDs não cria recibo duplicado', async () => {
        const patient = await createPatient('Bulk Settle Idempotency');
        const p1 = await createPendingPayment(patient, 100);
        const p2 = await createPendingPayment(patient, 200);

        const ids = [p1._id.toString(), p2._id.toString()];

        const res1 = await request(server)
            .post('/payments/bulk-settle')
            .send({ paymentIds: ids, paymentMethod: 'pix' });
        expect(res1.status).toBe(200);
        expect(res1.body.data.totalSettled).toBe(300);

        // Segunda chamada com os mesmos IDs deve ser bloqueada por idempotência
        const res2 = await request(server)
            .post('/payments/bulk-settle')
            .send({ paymentIds: ids, paymentMethod: 'pix' });
        expect(res2.status).toBe(409);
        expect(res2.body.success).toBe(false);
        expect(res2.body.code).toBe('BULK_SETTLEMENT_ALREADY_EXISTS');
        expect(res2.body.error).toMatch(/já existe|Fechamento já realizado/i);

        const settlements = await Payment.find({
            patient: patient._id,
            kind: 'monthly_settlement',
            status: { $nin: ['cancelled', 'canceled'] }
        }).lean();
        expect(settlements.length).toBe(1);
        expect(settlements[0].amount).toBe(300);
    });

    it('deve aceitar split de pagamento e salvar splitMethods no recibo', async () => {
        const patient = await createPatient('Bulk Settle Split');
        const p1 = await createPendingPayment(patient, 100);
        const p2 = await createPendingPayment(patient, 200);

        const res = await request(server)
            .post('/payments/bulk-settle')
            .send({
                paymentIds: [p1._id.toString(), p2._id.toString()],
                paymentMethod: 'pix',
                totalAmount: 300,
                splitMethods: [
                    { method: 'pix', amount: 150 },
                    { method: 'dinheiro', amount: 150 }
                ]
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.totalSettled).toBe(300);
        expect(res.body.data.paymentMethod).toBe('pix');
        expect(res.body.data.splitMethods).toHaveLength(2);
        expect(res.body.data.splitMethods[0].method).toBe('pix');
        expect(res.body.data.splitMethods[1].method).toBe('dinheiro');

        const settlements = await Payment.find({
            patient: patient._id,
            kind: 'monthly_settlement',
            status: { $nin: ['cancelled', 'canceled'] }
        }).lean();
        expect(settlements.length).toBe(1);
        expect(settlements[0].splitMethods).toHaveLength(2);
        expect(settlements[0].splitMethods.map(s => s.amount).reduce((a, b) => a + b, 0)).toBe(300);

        // Payments individuais também devem ter o split propagado
        const paidPayments = await Payment.find({
            _id: { $in: [p1._id, p2._id] },
            status: 'paid'
        }).lean();
        expect(paidPayments.every(p => (p.splitMethods || []).reduce((sum, part) => sum + part.amount, 0) === p.amount)).toBe(true);
        await assertCanonicalCash(300, [p1._id.toString(), p2._id.toString()]);
    });

    it('deve rejeitar split quando a soma não bate com o total', async () => {
        const patient = await createPatient('Bulk Settle Split Mismatch');
        const p1 = await createPendingPayment(patient, 100);
        const p2 = await createPendingPayment(patient, 200);

        const res = await request(server)
            .post('/payments/bulk-settle')
            .send({
                paymentIds: [p1._id.toString(), p2._id.toString()],
                paymentMethod: 'pix',
                totalAmount: 300,
                splitMethods: [
                    { method: 'pix', amount: 100 },
                    { method: 'dinheiro', amount: 150 }
                ]
            });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('SPLIT_AMOUNT_MISMATCH');
    });

    it('deve retornar erro quando nenhum payment pendente for encontrado', async () => {
        const res = await request(server)
            .post('/payments/bulk-settle')
            .send({
                paymentIds: [new mongoose.Types.ObjectId().toString()],
                paymentMethod: 'pix'
            });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('deve retornar erro quando paymentIds estiver vazio', async () => {
        const res = await request(server)
            .post('/payments/bulk-settle')
            .send({ paymentIds: [], paymentMethod: 'pix' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('rejeita partial sem transformar o saldo aberto em recebimento integral', async () => {
        const patient = await createPatient('Paciente Parcial');
        const partial = await createPendingPayment(patient, 300, 'pix', { status: 'partial' });
        const res = await request(server).post('/payments/bulk-settle').send({
            paymentIds: [partial._id.toString()], paymentMethod: 'pix'
        });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('PARTIAL_SETTLEMENT_REQUIRES_REMAINING_AMOUNT');
        expect((await Payment.findById(partial._id)).status).toBe('partial');
        expect(await Payment.countDocuments({ kind: 'monthly_settlement' })).toBe(0);
    });

    it('rejeita conjunto com status mistos sem escrita parcial', async () => {
        const patient = await createPatient('Paciente Status Misto');
        const pending = await createPendingPayment(patient, 100);
        const paid = await createPendingPayment(patient, 200, 'pix', { status: 'paid', paidAt: new Date(), financialDate: new Date() });
        const res = await request(server).post('/payments/bulk-settle').send({
            paymentIds: [pending._id.toString(), paid._id.toString()], paymentMethod: 'pix'
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('MIXED_SETTLEMENT_STATUSES');
        expect((await Payment.findById(pending._id)).status).toBe('pending');
        expect(await Payment.countDocuments({ kind: 'monthly_settlement' })).toBe(0);
    });

    it('rejeita IDs duplicados, conjunto incompleto e pacientes ou clinicas diferentes sem escrita', async () => {
        const patientA = await createPatient('Paciente A');
        const patientB = await createPatient('Paciente B');
        const p1 = await createPendingPayment(patientA, 100, 'pix', { clinicId: 'clinic-a' });
        const p2 = await createPendingPayment(patientB, 200, 'pix', { clinicId: 'clinic-a' });
        const p3 = await createPendingPayment(patientA, 200, 'pix', { clinicId: 'clinic-b' });

        const cases = [
            { ids: [p1._id.toString(), p1._id.toString()], code: 'DUPLICATE_PAYMENT_IDS' },
            { ids: [p1._id.toString(), new mongoose.Types.ObjectId().toString()], code: 'PAYMENT_SET_INCOMPLETE' },
            { ids: [p1._id.toString(), p2._id.toString()], code: 'MIXED_PATIENTS' },
            { ids: [p1._id.toString(), p3._id.toString()], code: 'MIXED_CLINICS' }
        ];
        for (const testCase of cases) {
            const res = await request(server).post('/payments/bulk-settle').send({ paymentIds: testCase.ids, paymentMethod: 'pix' });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe(testCase.code);
        }
        expect(await Payment.countDocuments({ kind: 'monthly_settlement' })).toBe(0);
        expect(await Payment.countDocuments({ status: 'paid' })).toBe(0);
    });

    it('duas chamadas concorrentes produzem um unico recibo e um unico efeito financeiro', async () => {
        const patient = await createPatient('Paciente Concorrencia');
        const p1 = await createPendingPayment(patient, 100);
        const p2 = await createPendingPayment(patient, 200);
        const body = { paymentIds: [p1._id.toString(), p2._id.toString()], paymentMethod: 'pix' };
        const results = await Promise.all([
            request(server).post('/payments/bulk-settle').send(body),
            request(server).post('/payments/bulk-settle').send(body)
        ]);
        expect(results.map(result => result.status).sort()).toEqual([200, 409]);
        expect(await Payment.countDocuments({ kind: 'monthly_settlement' })).toBe(1);
        await assertCanonicalCash(300, [p1._id.toString(), p2._id.toString()]);
    });

    it('monthly_settlement e debt_settlement preservam auditoria com contribuicao zero', async () => {
        const patient = await createPatient('Paciente Recibos');
        const original = await createPendingPayment(patient, 300);
        const res = await request(server).post('/payments/bulk-settle').send({ paymentIds: [original._id.toString()], paymentMethod: 'pix' });
        expect(res.status).toBe(200);
        await Payment.create({
            patient: patient._id, patientId: patient._id.toString(), amount: 300,
            paymentMethod: 'pix', status: 'paid', paymentDate: new Date(), financialDate: new Date(),
            billingType: 'particular', kind: 'debt_settlement', settledPaymentIds: [original._id], paidAt: new Date()
        });
        await assertCanonicalCash(300, [original._id.toString()]);
    });

    describe('invalidação de cache escopada por data (regressão bulk-settle)', () => {
        async function primeCashflowCache(dateStr) {
            const first = await request(server).get('/cashflow').query({ date: dateStr });
            expect(first.status).toBe(200);
            const second = await request(server).get('/cashflow').query({ date: dateStr });
            expect(second.status).toBe(200);
            expect(second.headers['x-cache-hit']).toBe('true'); // confirma que ficou em cache
        }

        it('invalida cashflow apenas nas datas afetadas (serviceDate antigo + hoje), preserva as demais', async () => {
            const today = moment.tz('America/Sao_Paulo');
            const oldDateStr = today.clone().subtract(10, 'days').format('YYYY-MM-DD');
            const unrelatedDateStr = today.clone().subtract(20, 'days').format('YYYY-MM-DD');
            const todayStr = today.format('YYYY-MM-DD');
            const oldDate = today.clone().subtract(10, 'days').startOf('day').add(12, 'hours').toDate();

            const patient = await createPatient('Paciente Sessao Antiga');
            const payment = await createPendingPayment(patient, 400, 'pix', {
                serviceDate: oldDate,
                paymentDate: oldDate
            });

            // Pré-aquece os 3 caches: data antiga afetada, data "hoje" (novo financialDate) e uma data não relacionada
            await primeCashflowCache(oldDateStr);
            await primeCashflowCache(todayStr);
            await primeCashflowCache(unrelatedDateStr);

            const res = await request(server)
                .post('/payments/bulk-settle')
                .send({ paymentIds: [payment._id.toString()], paymentMethod: 'pix' });
            expect(res.status).toBe(200);

            // Datas afetadas (serviceDate original + novo financialDate=hoje): cache MISS
            const afterOld = await request(server).get('/cashflow').query({ date: oldDateStr });
            expect(afterOld.headers['x-cache-hit']).not.toBe('true');

            const afterToday = await request(server).get('/cashflow').query({ date: todayStr });
            expect(afterToday.headers['x-cache-hit']).not.toBe('true');

            // Data não relacionada: continua em cache (não foi tocada)
            const afterUnrelated = await request(server).get('/cashflow').query({ date: unrelatedDateStr });
            expect(afterUnrelated.headers['x-cache-hit']).toBe('true');
        });

        it('não invalida nada quando a transação aborta antes do commit (idempotência)', async () => {
            const today = moment.tz('America/Sao_Paulo');
            const oldDateStr = today.clone().subtract(5, 'days').format('YYYY-MM-DD');
            const oldDate = today.clone().subtract(5, 'days').startOf('day').add(12, 'hours').toDate();

            const patient = await createPatient('Paciente Idempotencia Cache');
            const payment = await createPendingPayment(patient, 250, 'pix', {
                serviceDate: oldDate,
                paymentDate: oldDate
            });

            const first = await request(server)
                .post('/payments/bulk-settle')
                .send({ paymentIds: [payment._id.toString()], paymentMethod: 'pix' });
            expect(first.status).toBe(200);

            // Re-aquece o cache já com o payment quitado
            await primeCashflowCache(oldDateStr);

            // Segunda chamada com os mesmos IDs: bloqueada por idempotência ANTES do commit
            const second = await request(server)
                .post('/payments/bulk-settle')
                .send({ paymentIds: [payment._id.toString()], paymentMethod: 'pix' });
            expect(second.status).toBe(409);
            expect(second.body.code).toBe('BULK_SETTLEMENT_ALREADY_EXISTS');

            // Cache permanece intacto: a chamada abortada não invalidou nada
            const after = await request(server).get('/cashflow').query({ date: oldDateStr });
            expect(after.headers['x-cache-hit']).toBe('true');
        });
    });
}, 60_000);
