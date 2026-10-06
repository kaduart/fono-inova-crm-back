/**
 * 🛡️ Convênio só vira 'paid' pelo recebimento do convênio (caso Antonella/Unimed, 2026-10-06).
 * MongoDB em memória — nunca toca banco real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Payment from '../../models/Payment.js';
import { transitionPaymentStatus } from '../../services/paymentStatusService.js';

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
}, 30000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await Payment.deleteMany({});
});

const base = (overrides = {}) => ({
    patient: new mongoose.Types.ObjectId(),
    amount: 80,
    paymentDate: new Date('2026-06-29T12:00:00Z'),
    paymentMethod: 'convenio',
    billingType: 'convenio',
    status: 'pending_billing',
    insurance: { status: 'pending_billing', provider: 'unimed-anapolis', grossAmount: 80 },
    ...overrides,
});

describe('transitionPaymentStatus — convênio e status paid', () => {
    it('bloqueia marcar convênio como pago por fluxo genérico (ex.: markAsPaid/worker/webhook)', async () => {
        const payment = await Payment.create(base());

        await expect(
            transitionPaymentStatus(payment._id.toString(), 'paid', {
                paymentMethod: 'other',
                paidAt: new Date(),
                reason: 'paymentService_markAsPaid',
                silent: true,
            })
        ).rejects.toMatchObject({ code: 'CONVENIO_PAID_REQUIRES_INSURANCE_RECEIPT' });

        const after = await Payment.findById(payment._id).lean();
        expect(after.status).toBe('pending_billing');
    });

    it('permite quando é o recebimento do convênio (insuranceReceipt: true)', async () => {
        const payment = await Payment.create(base({ status: 'billed', insurance: { status: 'billed', provider: 'unimed-anapolis', grossAmount: 80 } }));

        const { payment: updated } = await transitionPaymentStatus(payment._id.toString(), 'paid', {
            paymentMethod: 'convenio',
            paidAt: new Date('2026-07-10T12:00:00Z'),
            financialDate: new Date('2026-07-10T12:00:00Z'),
            reason: 'auto_settlement',
            insuranceReceipt: true,
            silent: true,
        });

        expect(updated.status).toBe('paid');
    });

    it('não afeta pagamento particular', async () => {
        const payment = await Payment.create({
            patient: new mongoose.Types.ObjectId(),
            amount: 200,
            paymentDate: new Date('2026-06-29T12:00:00Z'),
            paymentMethod: 'pix',
            billingType: 'particular',
            status: 'pending',
        });

        const { payment: updated } = await transitionPaymentStatus(payment._id.toString(), 'paid', {
            paymentMethod: 'pix',
            paidAt: new Date('2026-06-29T12:00:00Z'),
            financialDate: new Date('2026-06-29T12:00:00Z'),
            reason: 'manual',
            silent: true,
        });

        expect(updated.status).toBe('paid');
    });
});
