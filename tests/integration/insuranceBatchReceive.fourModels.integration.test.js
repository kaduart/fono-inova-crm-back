/**
 * 🧾 receiveInsuranceBatch() — recebimento completo + prova dos quatro modelos financeiros
 *
 * Contexto (auditoria 2026-08-26, ver
 * scripts/maintenance/audit-convenio-isfrompackage-2026-08-26.mjs e
 * scripts/maintenance/repair-convenio-isfrompackage-2026-08-26.js): 37 Payments
 * de convênio ficaram mis-tagged isFromPackage=true pelo backfill de
 * 19/04/2026, quebrando `POST /v2/insurance-batches/:id/receive`
 * (PACKAGE_PAYMENT_CANNOT_HAVE_FINANCIAL_DATE). O reparo já rodou em produção
 * (36/36, validado por diff de snapshot). Este teste cobre o que o reparo em
 * si não prova: que o SERVIÇO oficial de recebimento (não uma NF real)
 * funciona corretamente fim-a-fim para um Payment de convênio normal, é
 * idempotente, e é atômico (uma falha no meio do lote não deixa nada
 * parcialmente recebido) — sem precisar baixar a NF #124 real.
 *
 * Também prova que os quatro modelos financeiros (ver
 * utils/packageFinancialModel.js e o adendo do usuário na auditoria) não são
 * afetados pelas guardas novas (paymentStatusService/insuranceBatchService):
 *   1. particular pré-pago — consumo continua isFromPackage:true, nunca billed.
 *   2. particular por sessão — Payment individual continua podendo ir a paid.
 *   3. liminar pré-paga — billingType='liminar' nunca entra na query de
 *      elegibilidade de createBatch (filtro billingType:'convenio'), então as
 *      guardas novas nunca avaliam esses Payments.
 *   4. convênio — recebimento ocorre pela baixa da NF (receiveInsuranceBatch).
 *
 * Usa MongoMemoryReplSet (não MongoMemoryServer) porque
 * receiveInsuranceBatch() usa mongoSession.withTransaction() — transação
 * multi-documento exige replica set.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let mongod;
let Payment, Session, Appointment, InsuranceBatch, Package;
let receiveInsuranceBatch;
let transitionPaymentStatus;
let createBatch;

beforeAll(async () => {
    mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongod.getUri());

    Payment = (await import('../../models/Payment.js')).default;
    Session = (await import('../../models/Session.js')).default;
    Appointment = (await import('../../models/Appointment.js')).default;
    InsuranceBatch = (await import('../../models/InsuranceBatch.js')).default;
    Package = (await import('../../models/Package.js')).default;
    ({ receiveInsuranceBatch } = await import('../../services/insuranceBatch/InsuranceBatchReceiptService.js'));
    ({ transitionPaymentStatus } = await import('../../services/paymentStatusService.js'));
    ({ createBatch } = await import('../../services/insuranceBatchService.js'));
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await Payment.deleteMany({});
    await Session.deleteMany({});
    await Appointment.deleteMany({});
    await InsuranceBatch.deleteMany({});
    await Package.deleteMany({});
});

function basePaymentFields(overrides = {}) {
    return {
        patient: new mongoose.Types.ObjectId(),
        amount: 80,
        paymentDate: new Date('2026-08-01T12:00:00Z'),
        paymentMethod: 'convenio',
        billingType: 'convenio',
        status: 'billed',
        insurance: { status: 'billed' },
        ...overrides,
    };
}

async function insertAppointmentFixture() {
    const id = new mongoose.Types.ObjectId();
    await Appointment.collection.insertOne({ _id: id, specialty: 'psicologia', channel: 'manual' });
    return id;
}

describe('receiveInsuranceBatch — modelo 4 (convênio): recebimento completo via serviço oficial', () => {
    it('transiciona billed -> paid, seta financialDate/paidAt/insurance.receivedAt, e marca a NF como received', async () => {
        const appointmentId = await insertAppointmentFixture();
        const session = await Session.create({
            patient: new mongoose.Types.ObjectId(), doctor: new mongoose.Types.ObjectId(),
            appointmentId, date: new Date('2026-08-05T12:00:00Z'), status: 'completed',
            paymentMethod: 'convenio', sessionType: 'psicologia', sessionValue: 80,
        });
        const payment = await Payment.create(basePaymentFields({ session: session._id, appointment: appointmentId }));
        const batch = await InsuranceBatch.create({
            batchNumber: `LOT-TESTE-${Date.now()}`,
            insuranceProvider: 'unimed-teste',
            startDate: new Date('2026-08-01'), endDate: new Date('2026-08-31'),
            status: 'sent', invoiceNumber: '999', issRate: 0, totalGross: 80,
            sessions: [{ session: session._id, appointment: appointmentId, payment: payment._id, grossAmount: 80 }],
        });

        const result = await receiveInsuranceBatch(batch._id.toString(), {
            receivedDate: '2026-08-20',
            userId: new mongoose.Types.ObjectId().toString(),
        });

        expect(result.idempotent).toBe(false);
        expect(result.status).toBe('received');
        expect(result.paymentsReceived).toBe(1);

        const reloadedPayment = await Payment.findById(payment._id).lean();
        expect(reloadedPayment.status).toBe('paid');
        expect(reloadedPayment.financialDate).toBeTruthy();
        expect(reloadedPayment.paidAt).toBeTruthy();
        expect(reloadedPayment.insurance.status).toBe('received');
        expect(reloadedPayment.insurance.receivedAt).toBeTruthy();

        const reloadedBatch = await InsuranceBatch.findById(batch._id).lean();
        expect(reloadedBatch.status).toBe('received');
        expect(reloadedBatch.receivedAt).toBeTruthy();
    });

    it('é idempotente — segunda chamada não reprocessa nem altera nada', async () => {
        const appointmentId = await insertAppointmentFixture();
        const session = await Session.create({
            patient: new mongoose.Types.ObjectId(), doctor: new mongoose.Types.ObjectId(),
            appointmentId, date: new Date('2026-08-05T12:00:00Z'), status: 'completed',
            paymentMethod: 'convenio', sessionType: 'psicologia', sessionValue: 80,
        });
        const payment = await Payment.create(basePaymentFields({ session: session._id, appointment: appointmentId }));
        const batch = await InsuranceBatch.create({
            batchNumber: `LOT-TESTE-${Date.now()}`,
            insuranceProvider: 'unimed-teste',
            startDate: new Date('2026-08-01'), endDate: new Date('2026-08-31'),
            status: 'sent', invoiceNumber: '999', issRate: 0, totalGross: 80,
            sessions: [{ session: session._id, appointment: appointmentId, payment: payment._id, grossAmount: 80 }],
        });

        await receiveInsuranceBatch(batch._id.toString(), { receivedDate: '2026-08-20', userId: new mongoose.Types.ObjectId().toString() });
        const afterFirst = await Payment.findById(payment._id).lean();

        const second = await receiveInsuranceBatch(batch._id.toString(), { receivedDate: '2026-08-21', userId: new mongoose.Types.ObjectId().toString() });
        expect(second.idempotent).toBe(true);

        const afterSecond = await Payment.findById(payment._id).lean();
        expect(afterSecond.financialDate.toISOString()).toBe(afterFirst.financialDate.toISOString());
        expect(afterSecond.insurance.receivedAt.toISOString()).toBe(afterFirst.insurance.receivedAt.toISOString());
    });

    it('atomicidade: falha em um Payment do lote não deixa NENHUM payment parcialmente recebido', async () => {
        const appointmentId1 = await insertAppointmentFixture();
        const appointmentId2 = await insertAppointmentFixture();
        const session1 = await Session.create({
            patient: new mongoose.Types.ObjectId(), doctor: new mongoose.Types.ObjectId(),
            appointmentId: appointmentId1, date: new Date('2026-08-05T12:00:00Z'), status: 'completed',
            paymentMethod: 'convenio', sessionType: 'psicologia', sessionValue: 80,
        });
        const session2 = await Session.create({
            patient: new mongoose.Types.ObjectId(), doctor: new mongoose.Types.ObjectId(),
            appointmentId: appointmentId2, date: new Date('2026-08-06T12:00:00Z'), status: 'completed',
            paymentMethod: 'convenio', sessionType: 'psicologia', sessionValue: 80,
        });
        const goodPayment = await Payment.create(basePaymentFields({ session: session1._id, appointment: appointmentId1 }));
        // Payment corrompido inserido via driver raw (bypassa os hooks/guardas
        // de escrita) simulando um registro que escapou das guardas — o que
        // este teste prova é que MESMO ASSIM a transação não deixa o lote
        // parcialmente recebido, não que essa corrupção é criável hoje.
        const corruptedPaymentDoc = { ...basePaymentFields({ session: session2._id, appointment: appointmentId2 }), _id: new mongoose.Types.ObjectId(), isFromPackage: true, kind: 'package_consumed' };
        await Payment.collection.insertOne(corruptedPaymentDoc);

        const batch = await InsuranceBatch.create({
            batchNumber: `LOT-TESTE-${Date.now()}`,
            insuranceProvider: 'unimed-teste',
            startDate: new Date('2026-08-01'), endDate: new Date('2026-08-31'),
            status: 'sent', invoiceNumber: '999', issRate: 0, totalGross: 160,
            sessions: [
                { session: session1._id, appointment: appointmentId1, payment: goodPayment._id, grossAmount: 80 },
                { session: session2._id, appointment: appointmentId2, payment: corruptedPaymentDoc._id, grossAmount: 80 },
            ],
        });

        await expect(receiveInsuranceBatch(batch._id.toString(), {
            receivedDate: '2026-08-20',
            userId: new mongoose.Types.ObjectId().toString(),
        })).rejects.toThrow();

        const reloadedGood = await Payment.findById(goodPayment._id).lean();
        expect(reloadedGood.status).toBe('billed');
        expect(reloadedGood.financialDate).toBeFalsy();

        const reloadedBatch = await InsuranceBatch.findById(batch._id).lean();
        expect(reloadedBatch.status).toBe('sent');
        expect(reloadedBatch.receivedAt).toBeFalsy();
    });
});

describe('Não regressão — modelo 1 (particular pré-pago)', () => {
    it('consumo de pacote continua isFromPackage:true e nunca é transicionado para billed', async () => {
        const pkg = await Package.create({
            patient: new mongoose.Types.ObjectId(), doctor: new mongoose.Types.ObjectId(),
            model: 'prepaid', paymentType: 'full', type: 'therapy',
            specialty: 'psicologia', sessionType: 'psicologia', date: new Date('2026-08-01'),
            durationMonths: 1, sessionsPerWeek: 1,
            totalSessions: 10, sessionsDone: 1, sessionValue: 80, totalValue: 800,
        });
        const payment = await Payment.create({
            patient: new mongoose.Types.ObjectId(), amount: 80,
            paymentDate: new Date('2026-08-01T12:00:00Z'), paymentMethod: 'convenio',
            billingType: 'particular', status: 'pending_billing',
            isFromPackage: true, kind: 'package_consumed', package: pkg._id,
        });

        // Consumo de pacote nunca deveria ser levado a 'billed' (isso é
        // exclusivo de convênio faturado por NF) — a guarda nova bloqueia,
        // confirmando que o modelo prepaid nunca passa por esse caminho.
        await expect(transitionPaymentStatus(payment._id.toString(), 'billed', { silent: true }))
            .rejects.toMatchObject({ code: 'PAYMENT_IS_PACKAGE_CONSUMPTION' });

        const reloaded = await Payment.findById(payment._id).lean();
        expect(reloaded.isFromPackage).toBe(true);
        expect(reloaded.financialDate).toBeFalsy();
    });
});

describe('Não regressão — modelo 2 (particular por sessão)', () => {
    it('Payment individual de sessão continua podendo ser pago normalmente (paid)', async () => {
        const pkg = await Package.create({
            patient: new mongoose.Types.ObjectId(), doctor: new mongoose.Types.ObjectId(),
            model: 'per_session', paymentType: 'per-session', type: 'therapy',
            specialty: 'psicologia', sessionType: 'psicologia', date: new Date('2026-08-01'),
            durationMonths: 1, sessionsPerWeek: 1,
            totalSessions: 10, sessionsDone: 1, sessionValue: 80, totalValue: 800,
        });
        const payment = await Payment.create({
            patient: new mongoose.Types.ObjectId(), amount: 80,
            paymentDate: new Date('2026-08-01T12:00:00Z'), paymentMethod: 'pix',
            billingType: 'particular', status: 'pending',
            isFromPackage: false, kind: 'session_payment', package: pkg._id,
        });

        const result = await transitionPaymentStatus(payment._id.toString(), 'paid', { silent: true, paidAt: new Date('2026-08-10') });
        expect(result.changed).toBe(true);

        const reloaded = await Payment.findById(payment._id).lean();
        expect(reloaded.status).toBe('paid');
        expect(reloaded.financialDate).toBeTruthy();
    });
});

describe('Não regressão — modelo 3 (liminar pré-paga)', () => {
    it('Payment billingType=liminar nunca é avaliado pela query de elegibilidade de createBatch (fora de escopo por construção)', async () => {
        const appointmentId = await insertAppointmentFixture();
        // Sessão marcada paymentMethod='convenio' (o sinal que createBatch usa
        // pra elegibilidade) mesmo sendo na verdade financiada por liminar —
        // simula o cenário mais adverso possível: mesmo se a sessão parecer
        // elegível, o Payment vinculado sendo billingType='liminar' faz com
        // que a query de Payment.find({billingType:'convenio',...}) não o
        // encontre, então ele nunca é avaliado pela guarda nem entra no lote.
        const session = await Session.create({
            patient: new mongoose.Types.ObjectId(), doctor: new mongoose.Types.ObjectId(),
            appointmentId, date: new Date('2026-08-05T12:00:00Z'), status: 'completed',
            paymentMethod: 'convenio', sessionType: 'psicologia', sessionValue: 80,
        });
        // Payment de consumo de liminar — mesma assinatura "perigosa"
        // (isFromPackage:true, kind='package_consumed') do bug de convênio,
        // mas billingType='liminar'. createBatch só busca billingType='convenio',
        // então este Payment nunca é considerado "corrompido" nem eligível.
        await Payment.create({
            patient: new mongoose.Types.ObjectId(), amount: 80, session: session._id,
            paymentDate: new Date('2026-08-01T12:00:00Z'), paymentMethod: 'liminar_credit',
            billingType: 'liminar', status: 'consumed',
            isFromPackage: true, kind: 'package_consumed',
        });

        // Nenhum Payment convenio vinculado a essa sessão -> createBatch não
        // encontra nenhum candidato a "corrompido" nem levanta erro por causa
        // do Payment liminar (ele é invisível pra essa query).
        const batch = await createBatch({
            insuranceProvider: 'unimed-teste',
            startDate: '2026-08-01', endDate: '2026-08-31',
            userId: new mongoose.Types.ObjectId(),
            sessionIds: [session._id.toString()],
        });

        expect(batch.sessions).toHaveLength(1);
        expect(batch.sessions[0].payment).toBeFalsy();
    });
});
