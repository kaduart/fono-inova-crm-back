/**
 * 🧪 transitionPaymentStatus({ reconcilePatientBalance: true }) — reconciliação
 * canônica do débito de "sessão fiada" no PatientBalance quando um Payment
 * particular avulso é marcado 'paid' fora dos fluxos dedicados (pacote/
 * multi/register-debit).
 *
 * Achado real de produção: PATCH /api/v2/payments/:id marcava o Payment
 * como pago mas nunca tocava o PatientBalance — o débito ficava aberto pra
 * sempre mesmo com o dinheiro já recebido (caso Julia Boarati, 3 sessões
 * pagas sem baixa, 2026-09-15).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../infrastructure/queue/queueConfig.js', () => ({
    getQueue: () => ({ add: vi.fn() }),
    queues: {},
    redisConnection: { status: 'ready', on: () => {} }
}));

import PatientBalance from '../../models/PatientBalance.js';
import Payment from '../../models/Payment.js';
import { transitionPaymentStatus, reconcilePatientBalanceDebit } from '../../services/paymentStatusService.js';

describe('Integração: transitionPaymentStatus() concilia PatientBalance (reconcilePatientBalance: true)', () => {
    let mongoReplSet;
    const PATIENT_ID = new mongoose.Types.ObjectId();

    beforeAll(async () => {
        mongoReplSet = await MongoMemoryReplSet.create({ replSet: { count: 1, dbName: 'crm_test' } });
        await mongoose.connect(mongoReplSet.getUri());
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await mongoReplSet.stop();
    });

    beforeEach(async () => {
        await PatientBalance.deleteMany({ patient: PATIENT_ID });
        await Payment.deleteMany({ patient: PATIENT_ID });
    });

    async function makePendingPayment({ amount = 200, appointment = new mongoose.Types.ObjectId() } = {}) {
        return Payment.create({
            patient: PATIENT_ID,
            appointment,
            amount,
            paymentDate: new Date(),
            paymentMethod: 'pix',
            billingType: 'particular',
            kind: 'session_payment',
            status: 'pending'
        });
    }

    it('quita o débito correspondente (isPaid + credit) ao marcar Payment como paid, sem tocar totalDebited', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        const payment = await makePendingPayment({ amount: 200, appointment: appointmentId });

        const debitId = new mongoose.Types.ObjectId();
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 200,
            totalDebited: 200,
            totalCredited: 0,
            transactions: [
                { _id: debitId, type: 'debit', amount: 200, description: 'Sessão fiada', appointmentId, isPaid: false }
            ]
        });

        await transitionPaymentStatus(payment._id, 'paid', {
            reason: 'admin_manual_patch',
            reconcilePatientBalance: true
        });

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(balance.currentBalance).toBe(0);
        expect(balance.totalCredited).toBe(200);
        expect(balance.totalDebited).toBe(200); // nunca decrementado — histórico bruto

        const debit = balance.transactions.id(debitId);
        expect(debit.isPaid).toBe(true);
        expect(debit.paidAmount).toBe(200);

        const credit = balance.transactions.find(t => t.type === 'credit');
        expect(credit).toBeTruthy();
        expect(credit.amount).toBe(200);
        expect(credit.linkedDebitId.toString()).toBe(debitId.toString());
    });

    it('não gera crédito artificial quando não existe débito correspondente ao appointment do Payment', async () => {
        const payment = await makePendingPayment({ amount: 150 });
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 0,
            totalDebited: 0,
            totalCredited: 0,
            transactions: []
        });

        await transitionPaymentStatus(payment._id, 'paid', {
            reason: 'admin_manual_patch',
            reconcilePatientBalance: true
        });

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(balance.currentBalance).toBe(0);
        expect(balance.totalCredited).toBe(0);
        expect(balance.transactions).toHaveLength(0);
    });

    it('é idempotente: repetir a transição pro mesmo Payment não duplica a baixa', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        const payment = await makePendingPayment({ amount: 200, appointment: appointmentId });
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 200,
            totalDebited: 200,
            totalCredited: 0,
            transactions: [
                { type: 'debit', amount: 200, description: 'Sessão fiada', appointmentId, isPaid: false }
            ]
        });

        const opts = { reason: 'admin_manual_patch', reconcilePatientBalance: true };
        await transitionPaymentStatus(payment._id, 'paid', opts);
        // Retry da mesma transição (ex: dois cliques, retry de rede) — o Payment
        // já está 'paid', transitionPaymentStatus retorna changed:false e nem
        // chega a chamar a reconciliação de novo.
        await transitionPaymentStatus(payment._id, 'paid', opts);

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        const credits = balance.transactions.filter(t => t.type === 'credit');
        expect(credits).toHaveLength(1);
        expect(balance.currentBalance).toBe(0);
        expect(balance.totalCredited).toBe(200);
    });

    it('pula conciliação (não escolhe arbitrariamente) quando há mais de um débito aberto pro mesmo appointment', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        const payment = await makePendingPayment({ amount: 200, appointment: appointmentId });
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 400,
            totalDebited: 400,
            totalCredited: 0,
            transactions: [
                { type: 'debit', amount: 200, description: 'Sessão fiada', appointmentId, isPaid: false },
                { type: 'debit', amount: 200, description: 'Sessão fiada (duplicata)', appointmentId, isPaid: false }
            ]
        });

        await transitionPaymentStatus(payment._id, 'paid', {
            reason: 'admin_manual_patch',
            reconcilePatientBalance: true
        });

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        // Nada mudou — ambíguo demais pra decidir sozinho.
        expect(balance.currentBalance).toBe(400);
        expect(balance.totalCredited).toBe(0);
        expect(balance.transactions.every(t => !t.isPaid)).toBe(true);

        const updatedPayment = await Payment.findById(payment._id);
        expect(updatedPayment.status).toBe('paid'); // o Payment em si transiciona normalmente
    });

    it('não mexe no PatientBalance quando o Payment é de pacote (isFromPackage/package_consumed)', async () => {
        // Teste direto de reconcilePatientBalanceDebit() — sem passar pelos
        // hooks do model Payment, que tem uma guarda não-relacionada
        // (isFromPackage nunca pode ter financialDate) incompatível com
        // transitionPaymentStatus setando financialDate incondicionalmente
        // ao entrar em 'paid'. Pacote se concilia sozinho via
        // incorporatePackagePayments()/settlePendingDebitsForPrepaidPackage(),
        // nunca por aqui.
        const appointmentId = new mongoose.Types.ObjectId();
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 200,
            totalDebited: 200,
            totalCredited: 0,
            transactions: [
                { type: 'debit', amount: 200, description: 'Sessão fiada', appointmentId, isPaid: false }
            ]
        });

        const fakePackagePayment = {
            _id: new mongoose.Types.ObjectId(),
            patient: PATIENT_ID,
            appointment: appointmentId,
            amount: 160,
            billingType: 'particular',
            isFromPackage: true,
            kind: 'package_consumed'
        };

        const result = await reconcilePatientBalanceDebit(fakePackagePayment, { reason: 'package_settlement' });
        expect(result.reconciled).toBe(false);
        expect(result.why).toBe('package_payment_handled_elsewhere');

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(balance.currentBalance).toBe(200); // intocado
        expect(balance.transactions.every(t => !t.isPaid)).toBe(true);
    });

    it('NÃO quita integralmente um débito maior com um Payment que cobre só parte dele', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        const debitId = new mongoose.Types.ObjectId();
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 200,
            totalDebited: 200,
            totalCredited: 0,
            transactions: [
                { _id: debitId, type: 'debit', amount: 200, description: 'Sessão fiada', appointmentId, isPaid: false }
            ]
        });
        const payment = await makePendingPayment({ amount: 50, appointment: appointmentId });

        await transitionPaymentStatus(payment._id, 'paid', {
            reason: 'admin_manual_patch',
            reconcilePatientBalance: true
        });

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        const debit = balance.transactions.id(debitId);
        expect(debit.isPaid).toBe(false); // ainda deve R$150
        expect(debit.paidAmount).toBe(50);
        expect(balance.currentBalance).toBe(150);
        expect(balance.totalCredited).toBe(50);
    });

    it('sinal + saldo: dois Payments do mesmo appointment quitam progressivamente o MESMO débito, sem duplicar nem perder o segundo', async () => {
        // Cenário real documentado em FINANCIAL_SOURCE_OF_TRUTH.md — consulta
        // particular com sinal (deposit) + saldo (balance): 2 Payments
        // distintos pro mesmo appointment, nunca 1 Payment com paidAmount.
        const appointmentId = new mongoose.Types.ObjectId();
        const debitId = new mongoose.Types.ObjectId();
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 200,
            totalDebited: 200,
            totalCredited: 0,
            transactions: [
                { _id: debitId, type: 'debit', amount: 200, description: 'Sessão fiada', appointmentId, isPaid: false }
            ]
        });

        const deposit = await Payment.create({
            patient: PATIENT_ID, appointment: appointmentId, amount: 60,
            paymentDate: new Date(), paymentMethod: 'pix', billingType: 'particular',
            kind: 'session_payment', paymentRole: 'deposit', status: 'pending'
        });
        const balancePayment = await Payment.create({
            patient: PATIENT_ID, appointment: appointmentId, amount: 140,
            paymentDate: new Date(), paymentMethod: 'pix', billingType: 'particular',
            kind: 'session_payment', paymentRole: 'balance', status: 'pending'
        });

        await transitionPaymentStatus(deposit._id, 'paid', { reason: 'admin_manual_patch', reconcilePatientBalance: true });
        let balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        let debit = balance.transactions.id(debitId);
        expect(debit.isPaid).toBe(false);
        expect(debit.paidAmount).toBe(60);
        expect(balance.currentBalance).toBe(140);

        await transitionPaymentStatus(balancePayment._id, 'paid', { reason: 'admin_manual_patch', reconcilePatientBalance: true });
        balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        debit = balance.transactions.id(debitId);
        expect(debit.isPaid).toBe(true);
        expect(debit.paidAmount).toBe(200);
        expect(balance.currentBalance).toBe(0);
        expect(balance.totalCredited).toBe(200);
        expect(balance.transactions.filter(t => t.type === 'credit')).toHaveLength(2);
    });

    it('preserva vínculo mais específico: dois débitos no mesmo appointment, sessionId do Payment desempata', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        const sessionA = new mongoose.Types.ObjectId();
        const sessionB = new mongoose.Types.ObjectId();
        const debitA = new mongoose.Types.ObjectId();
        const debitB = new mongoose.Types.ObjectId();
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 400,
            totalDebited: 400,
            totalCredited: 0,
            transactions: [
                { _id: debitA, type: 'debit', amount: 200, description: 'Sessão A', appointmentId, sessionId: sessionA, isPaid: false },
                { _id: debitB, type: 'debit', amount: 200, description: 'Sessão B', appointmentId, sessionId: sessionB, isPaid: false }
            ]
        });
        const payment = await Payment.create({
            patient: PATIENT_ID, appointment: appointmentId, session: sessionB, amount: 200,
            paymentDate: new Date(), paymentMethod: 'pix', billingType: 'particular',
            kind: 'session_payment', status: 'pending'
        });

        await transitionPaymentStatus(payment._id, 'paid', { reason: 'admin_manual_patch', reconcilePatientBalance: true });

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        expect(balance.transactions.id(debitB).isPaid).toBe(true); // o específico (sessionId bate)
        expect(balance.transactions.id(debitA).isPaid).toBe(false); // o outro fica intocado
    });

    it('ATOMICIDADE: falha entre as duas escritas do PatientBalance não deixa Payment pago sem crédito', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        const debitId = new mongoose.Types.ObjectId();
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 200,
            totalDebited: 200,
            totalCredited: 0,
            transactions: [
                { _id: debitId, type: 'debit', amount: 200, description: 'Sessão fiada', appointmentId, isPaid: false }
            ]
        });
        const payment = await makePendingPayment({ amount: 200, appointment: appointmentId });

        // Injeta falha na SEGUNDA escrita (o $push do crédito) pra simular
        // queda de processo/erro de rede exatamente entre as duas operações
        // atômicas sequenciais que reconcilePatientBalanceDebit() faz.
        const originalUpdateOne = PatientBalance.updateOne.bind(PatientBalance);
        let call = 0;
        const spy = vi.spyOn(PatientBalance, 'updateOne').mockImplementation((...args) => {
            call += 1;
            if (call === 2) throw new Error('FALHA_INJETADA_ENTRE_ESCRITAS');
            return originalUpdateOne(...args);
        });

        const mongoSession = await mongoose.startSession();
        await mongoSession.startTransaction();
        let thrown = null;
        try {
            await transitionPaymentStatus(payment._id, 'paid', {
                reason: 'admin_manual_patch',
                reconcilePatientBalance: true,
                session: mongoSession
            });
            await mongoSession.commitTransaction();
        } catch (err) {
            thrown = err;
            await mongoSession.abortTransaction();
        } finally {
            await mongoSession.endSession();
            spy.mockRestore();
        }

        expect(thrown).not.toBeNull();
        expect(thrown.message).toBe('FALHA_INJETADA_ENTRE_ESCRITAS');

        // Tudo dentro da MESMA transação Mongo — abortou junto: nem o Payment
        // virou paid, nem o débito foi marcado, nem crédito nenhum foi criado.
        const finalPayment = await Payment.findById(payment._id);
        expect(finalPayment.status).toBe('pending');

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        const debit = balance.transactions.id(debitId);
        expect(debit.isPaid).toBe(false);
        expect(debit.paidAmount).toBe(0);
        expect(balance.transactions.filter(t => t.type === 'credit')).toHaveLength(0);
        expect(balance.currentBalance).toBe(200);
    });

    it('CONCORRÊNCIA REAL: duas transações concorrentes tentando pagar o MESMO Payment não duplicam a baixa', async () => {
        const appointmentId = new mongoose.Types.ObjectId();
        const debitId = new mongoose.Types.ObjectId();
        await PatientBalance.create({
            patient: PATIENT_ID,
            currentBalance: 200,
            totalDebited: 200,
            totalCredited: 0,
            transactions: [
                { _id: debitId, type: 'debit', amount: 200, description: 'Sessão fiada', appointmentId, isPaid: false }
            ]
        });
        const payment = await makePendingPayment({ amount: 200, appointment: appointmentId });

        const sessionA = await mongoose.startSession();
        const sessionB = await mongoose.startSession();
        await sessionA.startTransaction();
        await sessionB.startTransaction();

        const attempt = (session) => transitionPaymentStatus(payment._id, 'paid', {
            reason: 'admin_manual_patch',
            reconcilePatientBalance: true,
            session
        }).then(async () => {
            await session.commitTransaction();
            return { ok: true };
        }).catch(async (err) => {
            try { await session.abortTransaction(); } catch (_) { /* já abortou */ }
            return { ok: false, error: err };
        }).finally(() => session.endSession());

        // Dispara as DUAS ao mesmo tempo (Promise.all, não sequencial) —
        // ambas leem o Payment 'pending' no snapshot da própria transação
        // antes de qualquer uma commitar, genuinamente concorrentes.
        const [resultA, resultB] = await Promise.all([attempt(sessionA), attempt(sessionB)]);

        const outcomes = [resultA, resultB];
        const successes = outcomes.filter(o => o.ok);
        const failures = outcomes.filter(o => !o.ok);

        // MongoDB serializa conflito de escrita no mesmo documento: no
        // máximo uma comita com sucesso simultaneamente (a outra pode falhar
        // com WriteConflict, ou o driver pode retentar — o que NUNCA pode
        // acontecer é as duas aplicarem a baixa financeira duas vezes).
        expect(successes.length).toBeGreaterThanOrEqual(1);

        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        const credits = balance.transactions.filter(t => t.type === 'credit');
        expect(credits).toHaveLength(1); // nunca 2, mesmo com as duas rodando ao mesmo tempo
        expect(balance.currentBalance).toBe(0);
        expect(balance.totalCredited).toBe(200);

        const finalPayment = await Payment.findById(payment._id);
        expect(finalPayment.status).toBe('paid');
    });
});
