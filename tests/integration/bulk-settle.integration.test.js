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

vi.mock('../../middleware/auth.js', () => ({
    __esModule: true,
    auth: (req, res, next) => {
        req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin' };
        next();
    }
}));

let mongoReplSet;
let app;
let server;
let Patient, Payment;

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

    server = app.listen(0);
});

afterAll(async () => {
    await server.close();
    await mongoose.disconnect();
    await mongoReplSet.stop();
});

beforeEach(async () => {
    await Patient.deleteMany({});
    await Payment.deleteMany({});
});

async function createPatient(name) {
    return Patient.create({ fullName: name, phone: '11999999999' });
}

async function createPendingPayment(patient, amount, method = 'pix') {
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
        kindSource: 'manual'
    });
}

describe('POST /payments/bulk-settle', () => {
    it('deve quitar múltiplos payments pendentes e criar um recibo consolidado', async () => {
        const patient = await createPatient('Bulk Settle Test');
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

        const settlements = await Payment.find({
            patient: patient._id,
            kind: 'monthly_settlement',
            status: { $nin: ['cancelled', 'canceled'] }
        }).lean();
        expect(settlements.length).toBe(1);
        expect(settlements[0].splitMethods).toHaveLength(2);
        expect(settlements[0].splitMethods.map(s => s.amount).reduce((a, b) => a + b, 0)).toBe(300);
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
});
