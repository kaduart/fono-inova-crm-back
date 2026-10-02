/**
 * Integração — baixa individual de convênio grava AuditLog com o usuário logado.
 * Mongo em memória; ledger/outbox/eventos mockados (fora do escopo).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../services/financialLedgerService.js', () => ({ recordInsuranceReceived: vi.fn().mockResolvedValue({}) }));
vi.mock('../../infrastructure/outbox/outboxPattern.js', () => ({ saveToOutbox: vi.fn().mockResolvedValue({}) }));
vi.mock('../../infrastructure/events/eventPublisher.js', () => ({
    publishEvent: vi.fn().mockResolvedValue({ eventId: 'evt' }),
    EventTypes: new Proxy({}, { get: (_, k) => String(k) })
}));
vi.mock('../../utils/insuranceIss.js', () => ({
    getConvenioIssRate: vi.fn().mockResolvedValue(0),
    calculateInsuranceIss: (amount) => ({ grossAmount: amount, issRate: 0, issAmount: 0, netAmount: amount })
}));

let mongoServer, Payment, AuditLog, settle;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    Payment = (await import('../../models/Payment.js')).default;
    AuditLog = (await import('../../models/AuditLog.js')).default;
    ({ settleInsurancePayment: settle } = await import('../../services/autoInsuranceSettlementService.js'));
}, 300000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
});

beforeEach(async () => {
    await Payment.deleteMany({});
    await AuditLog.deleteMany({});
});

const newConvenioPayment = () => Payment.collection.insertOne({
    _id: new mongoose.Types.ObjectId(), amount: 80, status: 'pending', billingType: 'convenio', paymentMethod: 'convenio',
    kind: 'session_payment', insurance: { status: 'billed', provider: 'unimed-anapolis' },
    patient: new mongoose.Types.ObjectId(), paymentDate: new Date('2026-05-22T20:00:00Z'),
    serviceDate: new Date('2026-05-22T20:00:00Z'), createdAt: new Date(), updatedAt: new Date()
}).then(r => r.insertedId);

describe('settleInsurancePayment — auditoria', () => {
    it('com actor: AuditLog tem userId do usuário logado, antes/depois e a origem manual', async () => {
        const id = await newConvenioPayment();
        const actor = { id: new mongoose.Types.ObjectId().toString(), role: 'admin' };

        const res = await settle(id, { reason: 'manual_receive_avulso', paidAt: new Date('2026-10-02T14:00:00Z'), actor });
        expect(res.settled).toBe(true);

        const logs = await AuditLog.find({ entityType: 'Payment', entityId: id }).lean();
        expect(logs).toHaveLength(1);
        expect(String(logs[0].userId)).toBe(actor.id);
        expect(logs[0].actorRole).toBe('admin');
        expect(logs[0].action).toBe('insurance_payment_received');
        expect(logs[0].source).toBe('insurance_settlement:manual_receive_avulso');
        expect(logs[0].before.status).toBe('pending');
        expect(logs[0].after.status).toBe('paid');
        expect(logs[0].diff.status).toEqual({ from: 'pending', to: 'paid' });

        const p = await Payment.findById(id).lean();
        expect(p.insurance.receivedAtSource).toBe('manual:manual_receive_avulso');
    });

    it('sem actor (automático): auditoria como SYSTEM e origem automática', async () => {
        const id = await newConvenioPayment();
        await settle(id, { reason: 'auto_avulso_settlement' });

        const [log] = await AuditLog.find({ entityId: id }).lean();
        expect(log.userId).toBeNull();
        expect(log.actorRole).toBe('SYSTEM');
        expect((await Payment.findById(id).lean()).insurance.receivedAtSource).toBe('autoInsuranceSettlementService');
    });

    it('baixa repetida (já paga) não gera segundo log', async () => {
        const id = await newConvenioPayment();
        const actor = { id: new mongoose.Types.ObjectId().toString(), role: 'secretary' };
        await settle(id, { reason: 'manual_receive_avulso', actor });
        const again = await settle(id, { reason: 'manual_receive_avulso', actor });

        expect(again.skipped).toBe(true);
        expect(await AuditLog.countDocuments({ entityId: id })).toBe(1);
    });
});
