/**
 * Testes de regressão para measureStateMachineDrift.
 *
 * Cobre especificamente o bug de 2026-07-07: uma chave `$or` duplicada no
 * objeto de query fazia o filtro de billingType ser silenciosamente
 * descartado, inflando sessionCompletedNoPaymentId de ~2 para 1385
 * (contava particular/liminar junto com convênio).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { measureStateMachineDrift } from '../stateMachineConvenioReconciliation.service.js';

let mongoServer;
let db;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    db = mongoose.connection.db;
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    await db.collection('sessions').deleteMany({});
    await db.collection('payments').deleteMany({});
    await db.collection('insuranceguides').deleteMany({});
});

describe('measureStateMachineDrift — sessionCompletedWithoutResolvablePayment', () => {
    it('não conta sessions particulares completed sem paymentId (regressão do bug de $or duplicado)', async () => {
        await db.collection('sessions').insertMany([
            { status: 'completed', billingType: 'particular', paymentId: null },
            { status: 'completed', billingType: 'liminar', paymentId: null },
        ]);

        const drift = await measureStateMachineDrift(db);

        expect(drift.sessionCompletedWithoutResolvablePayment).toBe(0);
    });

    it('não conta convênio quando Payment.session resolve (fluxo novo, sem Session.paymentId)', async () => {
        const sessionId = new mongoose.Types.ObjectId();
        await db.collection('sessions').insertOne({
            _id: sessionId,
            status: 'completed',
            billingType: 'convenio',
            paymentId: null, // fluxo novo (ConvenioHandler) nunca escreve isso
        });
        await db.collection('payments').insertOne({
            session: sessionId,
            status: 'pending',
            billingType: 'convenio',
        });

        const drift = await measureStateMachineDrift(db);

        expect(drift.sessionCompletedWithoutResolvablePayment).toBe(0);
    });

    it('não conta convênio quando Session.paymentId resolve (fluxo legado, convenioPackageController)', async () => {
        const paymentId = new mongoose.Types.ObjectId();
        await db.collection('sessions').insertOne({
            status: 'completed',
            billingType: 'convenio',
            paymentId,
        });

        const drift = await measureStateMachineDrift(db);

        expect(drift.sessionCompletedWithoutResolvablePayment).toBe(0);
    });

    it('conta drift real: convênio completed sem paymentId e sem Payment ativo algum', async () => {
        await db.collection('sessions').insertOne({
            status: 'completed',
            billingType: 'convenio',
            paymentId: null,
        });

        const drift = await measureStateMachineDrift(db);

        expect(drift.sessionCompletedWithoutResolvablePayment).toBe(1);
    });

    it('ignora Payment cancelado/refunded ao resolver via Payment.session (não conta como resolvido)', async () => {
        const sessionId = new mongoose.Types.ObjectId();
        await db.collection('sessions').insertOne({
            _id: sessionId,
            status: 'completed',
            billingType: 'convenio',
            paymentId: null,
        });
        await db.collection('payments').insertOne({
            session: sessionId,
            status: 'canceled',
            billingType: 'convenio',
        });

        const drift = await measureStateMachineDrift(db);

        expect(drift.sessionCompletedWithoutResolvablePayment).toBe(1);
    });
});

describe('measureStateMachineDrift — guideUsedSessionsInconsistent (preservado)', () => {
    it('continua detectando divergência entre guide.usedSessions e sessions guideConsumed=true', async () => {
        const guideId = new mongoose.Types.ObjectId();
        await db.collection('insuranceguides').insertOne({ _id: guideId, usedSessions: 5 });
        await db.collection('sessions').insertOne({
            insuranceGuide: guideId,
            status: 'completed',
            guideConsumed: true,
        });

        const drift = await measureStateMachineDrift(db);

        expect(drift.guideUsedSessionsInconsistent).toBe(1);
    });
});
