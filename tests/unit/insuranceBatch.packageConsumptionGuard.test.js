/**
 * 🛡️ Guarda contra consumo de pacote virando recebível de convênio (2026-08-26)
 *
 * Contexto: a auditoria de 37 Payments com isFromPackage=true + billingType=
 * 'convenio' (scripts/maintenance/audit-convenio-isfrompackage-2026-08-26.mjs)
 * confirmou a origem histórica (corrigir-backfill-abril.js), mas o fluxo ATIVO
 * services/insuranceBatchService.js (createBatch/sendBatch) ainda podia
 * reproduzir a mesma classe de bug hoje: nem a query de elegibilidade de
 * createBatch, nem o updateMany/batchTransitionStatus de sendBatch, checavam
 * isFromPackage/kind='package_consumed' antes de marcar 'billed' — só o
 * Payment.pre('save') pegava, e só na transição posterior para 'paid'
 * (financialDate), gerando o crash tardio em /receive
 * (PACKAGE_PAYMENT_CANNOT_HAVE_FINANCIAL_DATE) sem contexto do lote de origem.
 *
 * services/billingSubmission/paymentBillingInvariants.js (fluxo novo,
 * BillingSubmissionService) já tinha essa guarda — não precisa de teste aqui.
 *
 * Usa MongoDB real em memória porque o comportamento sob teste envolve hooks
 * do Mongoose (pre-save) e queries reais (find/updateMany), não just lógica
 * pura.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import Appointment from '../../models/Appointment.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import { transitionPaymentStatus } from '../../services/paymentStatusService.js';
import { createBatch, sendBatch } from '../../services/insuranceBatchService.js';

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
    await Session.deleteMany({});
    await InsuranceBatch.deleteMany({});
    await Appointment.deleteMany({});
});

function basePaymentFields(overrides = {}) {
    return {
        patient: new mongoose.Types.ObjectId(),
        amount: 80,
        paymentDate: new Date('2026-08-01T12:00:00Z'),
        paymentMethod: 'convenio',
        billingType: 'convenio',
        status: 'pending_billing',
        ...overrides,
    };
}

describe('paymentStatusService.transitionPaymentStatus — guarda de consumo de pacote', () => {
    it('lança PAYMENT_IS_PACKAGE_CONSUMPTION ao tentar billed com isFromPackage=true', async () => {
        const payment = await Payment.create(basePaymentFields({ isFromPackage: true, kind: 'package_consumed' }));

        await expect(
            transitionPaymentStatus(payment._id.toString(), 'billed', { silent: true })
        ).rejects.toMatchObject({ code: 'PAYMENT_IS_PACKAGE_CONSUMPTION' });

        const reloaded = await Payment.findById(payment._id).lean();
        expect(reloaded.status).toBe('pending_billing');
    });

    it('lança mesmo com isFromPackage=false quando kind=package_consumed (mesma assinatura do bug do backfill)', async () => {
        const payment = await Payment.create(basePaymentFields({ isFromPackage: false, kind: 'package_consumed' }));

        await expect(
            transitionPaymentStatus(payment._id.toString(), 'billed', { silent: true })
        ).rejects.toMatchObject({ code: 'PAYMENT_IS_PACKAGE_CONSUMPTION' });
    });

    it('NÃO regressão: Payment de convênio normal (session_payment) ainda transiciona para billed', async () => {
        const payment = await Payment.create(basePaymentFields({ isFromPackage: false, kind: 'session_payment' }));

        const result = await transitionPaymentStatus(payment._id.toString(), 'billed', { silent: true });
        expect(result.changed).toBe(true);

        const reloaded = await Payment.findById(payment._id).lean();
        expect(reloaded.status).toBe('billed');
        expect(reloaded.insurance.status).toBe('billed');
    });
});

describe('insuranceBatchService.createBatch — tudo ou nada, nunca exclui em silêncio', () => {
    it('recusa a criação do lote INTEIRO (erro estruturado com IDs) se qualquer sessão tiver Payment de consumo de pacote', async () => {
        const goodSession = await Session.create({
            patient: new mongoose.Types.ObjectId(),
            doctor: new mongoose.Types.ObjectId(),
            date: new Date('2026-08-05T12:00:00Z'),
            status: 'completed',
            paymentMethod: 'convenio',
            sessionType: 'psicologia',
            insuranceBillingProcessed: true,
            sessionValue: 80,
        });
        const badSession = await Session.create({
            patient: new mongoose.Types.ObjectId(),
            doctor: new mongoose.Types.ObjectId(),
            date: new Date('2026-08-05T12:00:00Z'),
            status: 'completed',
            paymentMethod: 'convenio',
            sessionType: 'psicologia',
            insuranceBillingProcessed: true,
            sessionValue: 80,
        });

        await Payment.create(basePaymentFields({ session: goodSession._id, isFromPackage: false, kind: 'session_payment' }));
        const badPayment = await Payment.create(basePaymentFields({ session: badSession._id, isFromPackage: true, kind: 'package_consumed' }));

        await expect(createBatch({
            insuranceProvider: 'unimed-teste',
            startDate: '2026-08-01',
            endDate: '2026-08-31',
            userId: new mongoose.Types.ObjectId(),
            sessionIds: [goodSession._id.toString(), badSession._id.toString()],
        })).rejects.toMatchObject({
            code: 'PAYMENT_IS_PACKAGE_CONSUMPTION',
            offendingPaymentIds: [badPayment._id.toString()],
        });

        // Nenhum lote foi criado — nem parcial, nem com a sessão boa sozinha.
        const batches = await InsuranceBatch.find({}).lean();
        expect(batches).toHaveLength(0);
    });

    it('cria o lote normalmente quando nenhuma sessão tem Payment de consumo de pacote', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        await Appointment.collection.insertOne({ _id: appointmentId, specialty: 'psicologia', channel: 'manual' });

        const goodSession = await Session.create({
            patient: new mongoose.Types.ObjectId(),
            doctor: new mongoose.Types.ObjectId(),
            appointmentId,
            date: new Date('2026-08-05T12:00:00Z'),
            status: 'completed',
            paymentMethod: 'convenio',
            sessionType: 'psicologia',
            insuranceBillingProcessed: true,
            sessionValue: 80,
        });
        await Payment.create(basePaymentFields({ session: goodSession._id, isFromPackage: false, kind: 'session_payment' }));

        const batch = await createBatch({
            insuranceProvider: 'unimed-teste',
            startDate: '2026-08-01',
            endDate: '2026-08-31',
            userId: new mongoose.Types.ObjectId(),
            sessionIds: [goodSession._id.toString()],
        });

        expect(batch.sessions).toHaveLength(1);
        expect(batch.sessions[0].session.toString()).toBe(goodSession._id.toString());
    });
});

describe('insuranceBatchService.sendBatch — recusa lote com consumo de pacote vinculado', () => {
    it('lança erro e não envia o lote se algum payment vinculado for consumo de pacote', async () => {
        const session = await Session.create({
            patient: new mongoose.Types.ObjectId(),
            doctor: new mongoose.Types.ObjectId(),
            date: new Date('2026-08-05T12:00:00Z'),
            status: 'completed',
            paymentMethod: 'convenio',
            sessionType: 'psicologia',
            sessionValue: 80,
        });
        const badPayment = await Payment.create(basePaymentFields({ session: session._id, isFromPackage: true, kind: 'package_consumed' }));

        // Simula um lote 'ready' já existente (ex.: criado antes deste fix)
        // com o payment corrompido vinculado — inserido direto para não
        // depender da lógica (já corrigida) de createBatch.
        const batch = await InsuranceBatch.create({
            batchNumber: `LOT-TESTE-${Date.now()}`,
            insuranceProvider: 'unimed-teste',
            startDate: new Date('2026-08-01'),
            endDate: new Date('2026-08-31'),
            status: 'ready',
            sessions: [{
                session: session._id,
                appointment: new mongoose.Types.ObjectId(),
                payment: badPayment._id,
                grossAmount: 80,
            }],
        });

        await expect(sendBatch(batch._id.toString(), new mongoose.Types.ObjectId())).rejects.toThrow(
            /consumo de pacote/
        );

        const reloadedBatch = await InsuranceBatch.findById(batch._id).lean();
        expect(reloadedBatch.status).toBe('ready');
    });
});
