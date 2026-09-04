/**
 * 🎯 SINAL + SALDO — testes de integração (Payment.paymentRole)
 *
 * Cobre o cenário obrigatório: consulta particular de R$500, sinal de R$50
 * recebido no pré-agendamento, saldo de R$450 pago depois.
 *
 * Usa MongoMemoryReplSet (não MongoMemoryServer): createDepositAndBalancePayments
 * e appointmentHybridService.create() rodam dentro de transações multi-documento.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Payment from '../../models/Payment.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import FinancialLedger from '../../models/FinancialLedger.js';
import {
    createDepositAndBalancePayments,
    computeAppointmentBalance,
    findDepositPayment,
    findBalancePayment,
    PAYMENT_ROLE,
} from '../../domain/payment/depositBalance.js';
import { ParticularHandler } from '../../services/completeSession/handlers/particularHandler.js';
import { calculateCashForDashboard, invalidateUFSCache } from '../../services/unifiedFinancialService.v2.js';
import { appointmentHybridService } from '../../services/appointmentHybridService.js';

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongod.getUri());
    await Payment.init();
    await FinancialLedger.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await Payment.deleteMany({});
    await Appointment.deleteMany({});
    await Session.deleteMany({});
    await FinancialLedger.collection.deleteMany({});
    invalidateUFSCache();
    vi.restoreAllMocks();
});

function ids() {
    return {
        patientId: new mongoose.Types.ObjectId(),
        doctorId: new mongoose.Types.ObjectId(),
        appointmentId: new mongoose.Types.ObjectId(),
        sessionId: new mongoose.Types.ObjectId(),
    };
}

async function withTransaction(fn) {
    const session = await mongoose.startSession();
    let result;
    try {
        await session.withTransaction(async () => {
            result = await fn(session);
        });
    } finally {
        await session.endSession();
    }
    return result;
}

describe('createDepositAndBalancePayments', () => {
    it('cria exatamente 2 Payments: sinal R$50 pago e saldo R$450 pendente', async () => {
        const { patientId, doctorId, appointmentId, sessionId } = ids();

        const { depositPayment, balancePayment, created } = await withTransaction((session) =>
            createDepositAndBalancePayments({
                patientId, doctorId, appointmentId, sessionId,
                billingType: 'particular',
                sessionValue: 500,
                depositAmount: 50,
                depositPaymentMethod: 'pix',
                balancePaymentMethod: 'pix',
                correlationId: `test_${appointmentId}`,
            }, session)
        );

        expect(created).toBe(true);
        expect(depositPayment.amount).toBe(50);
        expect(depositPayment.status).toBe('paid');
        expect(depositPayment.paymentRole).toBe(PAYMENT_ROLE.DEPOSIT);
        expect(depositPayment.kind).toBe('session_payment');

        expect(balancePayment.amount).toBe(450);
        expect(balancePayment.status).toBe('pending');
        expect(balancePayment.paymentRole).toBe(PAYMENT_ROLE.BALANCE);
        expect(balancePayment.kind).toBe('session_payment');

        const all = await Payment.find({ appointment: appointmentId });
        expect(all).toHaveLength(2);
    });

    it('retry (mesmo appointment+billingType) não cria um terceiro Payment', async () => {
        const { patientId, doctorId, appointmentId, sessionId } = ids();
        const params = {
            patientId, doctorId, appointmentId, sessionId,
            billingType: 'particular',
            sessionValue: 500,
            depositAmount: 50,
            correlationId: `retry_${appointmentId}`,
        };

        await withTransaction((session) => createDepositAndBalancePayments(params, session));
        const second = await withTransaction((session) => createDepositAndBalancePayments(params, session));

        expect(second.created).toBe(false);
        const all = await Payment.find({ appointment: appointmentId });
        expect(all).toHaveLength(2);
    });

    it('duas chamadas concorrentes (sessões separadas) não duplicam sinal nem saldo', async () => {
        const { patientId, doctorId, appointmentId, sessionId } = ids();
        const params = {
            patientId, doctorId, appointmentId, sessionId,
            billingType: 'particular',
            sessionValue: 500,
            depositAmount: 50,
            correlationId: `concurrent_${appointmentId}`,
        };

        await Promise.allSettled([
            withTransaction((session) => createDepositAndBalancePayments(params, session)),
            withTransaction((session) => createDepositAndBalancePayments(params, session)),
        ]);

        const all = await Payment.find({ appointment: appointmentId });
        const deposits = all.filter((p) => p.paymentRole === PAYMENT_ROLE.DEPOSIT);
        const balances = all.filter((p) => p.paymentRole === PAYMENT_ROLE.BALANCE);
        expect(deposits).toHaveLength(1);
        expect(balances).toHaveLength(1);
    });

    it('credita o ledger (payment_received) só para o sinal, não para o saldo ainda pendente', async () => {
        const { patientId, doctorId, appointmentId, sessionId } = ids();
        await withTransaction((session) =>
            createDepositAndBalancePayments({
                patientId, doctorId, appointmentId, sessionId,
                billingType: 'particular',
                sessionValue: 500,
                depositAmount: 50,
                correlationId: `ledger_${appointmentId}`,
            }, session)
        );

        const deposit = await findDepositPayment({ appointmentId, billingType: 'particular' });
        const credits = await FinancialLedger.find({ payment: deposit._id, type: 'payment_received' }).lean();
        expect(credits).toHaveLength(1);
        expect(credits[0].amount).toBe(50);

        const balance = await findBalancePayment({ appointmentId, billingType: 'particular' });
        const balanceCredits = await FinancialLedger.find({ payment: balance._id, type: 'payment_received' }).lean();
        expect(balanceCredits).toHaveLength(0);
    });

    it('migra recebimento parcial legado de R$50 para deposit e cria saldo R$450 sem duplicar o ledger', async () => {
        const { patientId, doctorId, appointmentId, sessionId } = ids();
        const paidAt = new Date('2026-09-04T13:18:25-03:00');

        const legacyPayment = await Payment.create({
            patient: patientId,
            doctor: doctorId,
            appointment: appointmentId,
            session: sessionId,
            amount: 50,
            paymentDate: paidAt,
            paidAt,
            financialDate: paidAt,
            paymentMethod: 'pix',
            status: 'paid',
            serviceType: 'consultation',
            billingType: 'particular',
            kind: 'session_payment',
            paymentRole: PAYMENT_ROLE.STANDARD,
        });
        await FinancialLedger.create({
            type: 'payment_received',
            direction: 'credit',
            amount: 50,
            patient: patientId,
            appointment: appointmentId,
            session: sessionId,
            payment: legacyPayment._id,
            correlationId: `legacy_${legacyPayment._id}`,
            occurredAt: paidAt,
        });

        const result = await withTransaction((session) => createDepositAndBalancePayments({
            patientId,
            doctorId,
            appointmentId,
            sessionId,
            billingType: 'particular',
            sessionValue: 500,
            depositAmount: 50,
            depositPaymentMethod: 'pix',
            balancePaymentMethod: 'pix',
            correlationId: `legacy_conversion_${appointmentId}`,
        }, session));

        expect(result.depositPayment._id.toString()).toBe(legacyPayment._id.toString());
        expect(result.depositPayment.paymentRole).toBe(PAYMENT_ROLE.DEPOSIT);
        expect(result.depositPayment.amount).toBe(50);
        expect(result.depositPayment.status).toBe('paid');
        expect(result.balancePayment.paymentRole).toBe(PAYMENT_ROLE.BALANCE);
        expect(result.balancePayment.amount).toBe(450);
        expect(result.balancePayment.status).toBe('pending');

        const allPayments = await Payment.find({ appointment: appointmentId }).sort({ amount: 1 });
        expect(allPayments).toHaveLength(2);
        expect(allPayments.map((payment) => payment.amount)).toEqual([50, 450]);
        const credits = await FinancialLedger.find({ appointment: appointmentId, type: 'payment_received' });
        expect(credits).toHaveLength(1);
        expect(credits[0].amount).toBe(50);
    });
});

describe('Caixa Real reflete o sinal na data do sinal (sem esperar a conclusão da sessão)', () => {
    it('Caixa Real = 50 antes da consulta; sobe pra 500 só depois do saldo pago', async () => {
        const { patientId, doctorId, appointmentId, sessionId } = ids();
        await withTransaction((session) =>
            createDepositAndBalancePayments({
                patientId, doctorId, appointmentId, sessionId,
                billingType: 'particular',
                sessionValue: 500,
                depositAmount: 50,
                correlationId: `cash_${appointmentId}`,
            }, session)
        );

        const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const end = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const cashBefore = await calculateCashForDashboard(start, end);
        expect(cashBefore.total).toBe(50);

        // Paga o saldo
        const balance = await findBalancePayment({ appointmentId, billingType: 'particular' });
        await Payment.findByIdAndUpdate(balance._id, {
            $set: { status: 'paid', paidAt: new Date(), financialDate: new Date() },
        });
        invalidateUFSCache();

        const cashAfter = await calculateCashForDashboard(start, end);
        expect(cashAfter.total).toBe(500);
    });
});

describe('computeAppointmentBalance', () => {
    it('saldo = 450 antes de pagar o restante; 0 depois', async () => {
        const { patientId, doctorId, appointmentId, sessionId } = ids();
        await withTransaction((session) =>
            createDepositAndBalancePayments({
                patientId, doctorId, appointmentId, sessionId,
                billingType: 'particular',
                sessionValue: 500,
                depositAmount: 50,
                correlationId: `balance_${appointmentId}`,
            }, session)
        );

        const before = await computeAppointmentBalance({ appointmentId, billingType: 'particular', sessionValue: 500 });
        expect(before.paidTotal).toBe(50);
        expect(before.remainingAmount).toBe(450);

        const balance = await findBalancePayment({ appointmentId, billingType: 'particular' });
        await Payment.findByIdAndUpdate(balance._id, { $set: { status: 'paid' } });

        const after = await computeAppointmentBalance({ appointmentId, billingType: 'particular', sessionValue: 500 });
        expect(after.paidTotal).toBe(500);
        expect(after.remainingAmount).toBe(0);
    });

    it('nunca fica negativo mesmo se pago a mais (nunca deveria acontecer, mas não pode quebrar o cálculo)', async () => {
        const { patientId, doctorId, appointmentId, sessionId } = ids();
        await withTransaction((session) =>
            createDepositAndBalancePayments({
                patientId, doctorId, appointmentId, sessionId,
                billingType: 'particular',
                sessionValue: 500,
                depositAmount: 500,
                correlationId: `overpaid_${appointmentId}`,
            }, session)
        );
        const result = await computeAppointmentBalance({ appointmentId, billingType: 'particular', sessionValue: 500 });
        expect(result.remainingAmount).toBe(0);
    });
});

describe('ParticularHandler.buildPayment nunca sobrescreve o sinal', () => {
    async function setupDepositScenario() {
        const { patientId, doctorId, appointmentId, sessionId } = ids();
        const { balancePayment } = await withTransaction((session) =>
            createDepositAndBalancePayments({
                patientId, doctorId, appointmentId, sessionId,
                billingType: 'particular',
                sessionValue: 500,
                depositAmount: 50,
                correlationId: `handler_${appointmentId}`,
            }, session)
        );
        return { patientId, doctorId, appointmentId, sessionId, balancePayment };
    }

    it('ao concluir a sessão, cobra só o saldo (450) — nunca 500 nem duplica o sinal', async () => {
        const { patientId, appointmentId, sessionId, balancePayment } = await setupDepositScenario();

        const result = await withTransaction(async (mongoSession) => {
            const appointmentUpdate = { $set: {} };
            const ctx = {
                appointment: {
                    payment: balancePayment._id,
                    patient: { _id: patientId, fullName: 'Paciente Teste' },
                    paymentMethod: 'pix',
                    billingType: 'particular',
                },
                appointmentId,
                sessionId,
                sessionValue: 500, // valor CHEIO da consulta — o handler precisa descontar o sinal sozinho
                packageId: null,
                packageData: null,
                mongoSession,
                userId: null,
                isBalanceOrigin: false,
                sessionDoc: { status: 'scheduled' },
                splitMethods: [],
                paymentMethod: undefined,
            };
            return ParticularHandler.buildPayment(appointmentUpdate, ctx);
        });

        expect(result.status).toBe('paid');
        expect(result.amount).toBe(450);
        expect(result.paymentRole).toBe(PAYMENT_ROLE.BALANCE);

        // O sinal continua intocado: 50, pago, mesmo _id
        const deposit = await findDepositPayment({ appointmentId, billingType: 'particular' });
        expect(deposit.amount).toBe(50);
        expect(deposit.status).toBe('paid');
    });
});

describe('Fluxo legado sem sinal continua funcionando (paymentRole=standard)', () => {
    it('appointmentHybridService.create sem depositAmount cria 1 único Payment standard', async () => {
        const { patientId, doctorId } = ids();

        const result = await withTransaction((session) =>
            appointmentHybridService.create({
                patientId,
                doctorId,
                date: '2026-09-10',
                time: '09:00',
                specialty: 'fonoaudiologia',
                serviceType: 'individual_session',
                billingType: 'particular',
                paymentMethod: 'pix',
                amount: 200,
                userId: null,
                operationalStatus: 'pre_agendado',
            }, session)
        );

        const payments = await Payment.find({ appointment: result.appointmentId });
        expect(payments).toHaveLength(1);
        expect(payments[0].paymentRole).toBe(PAYMENT_ROLE.STANDARD);
        expect(payments[0].amount).toBe(200);

        const appt = await Appointment.findById(result.appointmentId).lean();
        expect(appt.sessionValue).toBe(200);
        expect(appt.payment?.toString()).toBe(payments[0]._id.toString());
    });

    it('appointmentHybridService.create COM depositAmount cria sinal+saldo e appointment.payment aponta pro saldo', async () => {
        const { patientId, doctorId } = ids();

        const result = await withTransaction((session) =>
            appointmentHybridService.create({
                patientId,
                doctorId,
                date: '2026-09-10',
                time: '10:00',
                specialty: 'neuroped',
                serviceType: 'consultation',
                billingType: 'particular',
                paymentMethod: 'pix',
                amount: 500,
                depositAmount: 50,
                userId: null,
                operationalStatus: 'pre_agendado',
            }, session)
        );

        const payments = await Payment.find({ appointment: result.appointmentId });
        expect(payments).toHaveLength(2);

        const appt = await Appointment.findById(result.appointmentId).lean();
        expect(appt.sessionValue).toBe(500);

        const balance = payments.find((p) => p.paymentRole === PAYMENT_ROLE.BALANCE);
        const deposit = payments.find((p) => p.paymentRole === PAYMENT_ROLE.DEPOSIT);
        expect(appt.payment?.toString()).toBe(balance._id.toString());
        expect(deposit.amount).toBe(50);
        expect(balance.amount).toBe(450);
    });
});
