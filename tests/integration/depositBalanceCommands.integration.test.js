/**
 * 🎯 SINAL + SALDO — testes de integração de comandos reais (não mocks)
 *
 * Complementa tests/integration/depositBalance.integration.test.js: aquele
 * arquivo testa domain/payment/depositBalance.js isoladamente; este exercita
 * os COMANDOS reais (update/cancel/restore/delete Appointment, conclusão real
 * de sessão via completeSessionV2) e as funções financeiras canônicas
 * (Caixa Real, Meta Realizada, Produção, A Receber) ponta a ponta.
 *
 * Usa MongoMemoryReplSet — Mongo real em memória, sem mocks.
 *
 * ⚠️ ACHADO PRÉ-EXISTENTE (não causado por esta feature — reproduzido também
 * na baseline sem nenhum patch, ver relatório): utils/transactionRetry.js
 * chama `session.abortTransaction()` incondicionalmente no catch, mesmo
 * quando o erro veio de `commitTransaction()` (não da operação em si). Um
 * WriteConflict (code 112, TransientTransactionError — genuinamente
 * retryable) na hora do commit faz o driver rejeitar o abortTransaction()
 * subsequente ("Cannot call abortTransaction after calling commitTransaction"),
 * mascarando o erro retryable original antes da lógica de retry rodar.
 * deleteAppointmentCommand.execute() aciona isso de forma determinística sob
 * este harness (MongoMemoryReplSet de 1 nó + escritas rápidas em sequência no
 * mesmo Appointment/Session/Payment). retryDeleteWorkaround() abaixo é um
 * contorno *do lado do teste* — NÃO um patch em utils/transactionRetry.js,
 * que é infra compartilhada fora do escopo desta feature.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let Appointment, Session, Payment, Doctor, Patient, FinancialLedger;
let appointmentHybridService, completeSessionV2;
let updateAppointmentCommand, cancelAppointmentCommand, restoreCanceledAppointmentCommand, deleteAppointmentCommand;
let depositBalance;
let calculateCashForDashboard, calculateMetaRealizada, calculateProduction, invalidateUFSCache;
let calculatePendentesEngine;

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongoServer.getUri());

    Appointment = (await import('../../models/Appointment.js')).default;
    Session = (await import('../../models/Session.js')).default;
    Payment = (await import('../../models/Payment.js')).default;
    Doctor = (await import('../../models/Doctor.js')).default;
    Patient = (await import('../../models/Patient.js')).default;
    FinancialLedger = (await import('../../models/FinancialLedger.js')).default;
    await Payment.init();
    await FinancialLedger.init();

    appointmentHybridService = (await import('../../services/appointmentHybridService.js')).appointmentHybridService;
    completeSessionV2 = (await import('../../services/completeSessionService.v2.js')).completeSessionV2;

    updateAppointmentCommand = await import('../../services/appointment/commands/updateAppointmentCommand.js');
    cancelAppointmentCommand = await import('../../services/appointment/commands/cancelAppointmentCommand.js');
    restoreCanceledAppointmentCommand = await import('../../services/appointment/commands/restoreCanceledAppointmentCommand.js');
    deleteAppointmentCommand = await import('../../services/appointment/commands/deleteAppointmentCommand.js');
    depositBalance = await import('../../domain/payment/depositBalance.js');

    const ufs = await import('../../services/unifiedFinancialService.v2.js');
    calculateCashForDashboard = ufs.calculateCashForDashboard;
    calculateMetaRealizada = ufs.calculateMetaRealizada;
    calculateProduction = ufs.calculateProduction;
    invalidateUFSCache = ufs.invalidateUFSCache;

    const fe = await import('../../services/financialEngine.js');
    calculatePendentesEngine = fe.calculatePendentesEngine;
}, 90000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    await Appointment.deleteMany({});
    await Session.deleteMany({});
    await Payment.deleteMany({});
    await Doctor.deleteMany({});
    await Patient.deleteMany({});
    await FinancialLedger.collection.deleteMany({});
    invalidateUFSCache();
});

const FAKE_USER = { _id: new mongoose.Types.ObjectId() };

/**
 * Contorno de teste pro bug pré-existente de utils/transactionRetry.js (ver
 * comentário no topo do arquivo) — deleteAppointmentCommand.execute() usa
 * runTransactionWithRetry por baixo, que mascara um WriteConflict retryable
 * genuíno com "Cannot call abortTransaction after calling commitTransaction".
 * Retry aqui, do lado do teste, sem tocar infra compartilhada fora de escopo.
 */
async function executeDeleteWithWorkaround(id, user, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try {
            return await deleteAppointmentCommand.execute(id, user);
        } catch (err) {
            const isMaskedRetryable = /Cannot call abortTransaction after calling commitTransaction/.test(err.message || '');
            if (isMaskedRetryable && i < attempts - 1) {
                await new Promise((r) => setTimeout(r, 20 * (i + 1)));
                continue;
            }
            throw err;
        }
    }
}

async function createDoctor() {
    return Doctor.create({
        fullName: 'Dr. Neuroped Teste',
        email: `doc_${Date.now()}_${Math.random()}@teste.com`,
        phoneNumber: '62999999999',
        licenseNumber: `CRM-${Math.floor(Math.random() * 100000)}`,
        specialty: 'neuroped',
        active: true,
    });
}

async function createPatient() {
    return Patient.create({
        fullName: 'Paciente Sinal Teste',
        phone: '11999998888',
        dateOfBirth: '1990-05-15',
    });
}

/** Cria um pré-agendamento particular com sinal via o fluxo real de criação (appointmentHybridService). */
async function createAppointmentWithDeposit({ doctor, patient, date = '2026-09-10', time = '09:00', amount = 500, depositAmount = 50 }) {
    // Mesmo padrão de services/appointment/commands/createAppointmentCommand.js
    // em produção — runTransactionWithRetry (não gestão manual de session), pra
    // não introduzir diferença de comportamento entre teste e produção.
    const { runTransactionWithRetry } = await import('../../utils/transactionRetry.js');
    return runTransactionWithRetry((mongoSession) =>
        appointmentHybridService.create({
            patientId: patient._id,
            doctorId: doctor._id,
            date,
            time,
            specialty: 'neuroped',
            serviceType: 'consultation',
            billingType: 'particular',
            paymentMethod: 'pix',
            amount,
            depositAmount,
            userId: FAKE_USER._id,
            operationalStatus: 'pre_agendado',
        }, mongoSession)
    );
}

describe('Matriz financeira completa: Caixa Real, Meta Realizada, Produção, A Receber', () => {
    it('cenário obrigatório — R$500, sinal R$50: valores exatos antes/depois da conclusão e do saldo', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId, sessionId } = await createAppointmentWithDeposit({ doctor, patient, date: '2026-09-10' });

        const start = new Date('2026-09-01T00:00:00-03:00');
        const end = new Date('2026-09-30T23:59:59-03:00');

        // ─── ANTES da conclusão ───────────────────────────────────────────
        const cashBefore = await calculateCashForDashboard(start, end);
        const metaBefore = await calculateMetaRealizada(start, end);
        const producaoBefore = await calculateProduction(start, end);

        expect(cashBefore.total).toBe(50);
        expect(metaBefore.total).toBe(50);
        expect(producaoBefore.total ?? producaoBefore.byType?.total ?? 0).toBe(0);

        // ─── Conclui a sessão SEM receber o saldo (fiado/addToBalance) —
        // fluxo real, não mock. Sem addToBalance, particularHandler cobra o
        // saldo NO ATO (sub-caso "pago no ato"); com addToBalance:true, o
        // saldo vira uma dívida pendente — é o cenário "conclusão antes de
        // receber o saldo" explicitamente pedido.
        await completeSessionV2(appointmentId, {
            userId: FAKE_USER._id,
            addToBalance: true,
            balanceAmount: 450,
            balanceDescription: 'Saldo da consulta após sinal',
        });
        invalidateUFSCache();

        const cashAfterComplete = await calculateCashForDashboard(start, end);
        const metaAfterComplete = await calculateMetaRealizada(start, end);
        const producaoAfterComplete = await calculateProduction(start, end);
        const pendentesAfterComplete = await calculatePendentesEngine({ startDate: start, endDate: end });

        // Produção reconhece os R$500 assim que a sessão é concluída — mesmo
        // com o saldo ainda pendente.
        expect(producaoAfterComplete.total).toBe(500);
        // Caixa/Meta NÃO sobem sozinhos na conclusão — só o sinal (R$50) entrou até aqui.
        expect(cashAfterComplete.total).toBe(50);
        expect(metaAfterComplete.total).toBe(50);
        // A Receber: R$450 em aberto (o saldo virou fiado, não foi pago).
        expect(pendentesAfterComplete.total).toBe(450);

        const balance = await depositBalance.findBalancePayment({ appointmentId, billingType: 'particular' });
        expect(balance.amount).toBe(450);
        expect(balance.status).toBe('pending'); // fiado — particularHandler NUNCA marca paid sozinho

        // O sinal continua intocado (50, paid) — particularHandler nunca o encontrou/sobrescreveu.
        const deposit = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        expect(deposit.amount).toBe(50);
        expect(deposit.status).toBe('paid');

        // ─── Recebimento do saldo, dias depois (via via canônica) ─────────
        const { transitionPaymentStatus } = await import('../../services/paymentStatusService.js');
        await transitionPaymentStatus(balance._id, 'paid', {
            paidAt: new Date('2026-09-20T12:00:00-03:00'),
            financialDate: new Date('2026-09-20T12:00:00-03:00'),
            reason: 'saldo_recebido_teste',
        });
        const { recordPaymentReceived } = await import('../../services/financialLedgerService.js');
        const balanceAfterPaid = await Payment.findById(balance._id);
        await recordPaymentReceived(balanceAfterPaid, { correlationId: `balance_received_${balance._id}` });
        invalidateUFSCache();

        const cashAfterBalance = await calculateCashForDashboard(start, end);
        const metaAfterBalance = await calculateMetaRealizada(start, end);
        const producaoAfterBalance = await calculateProduction(start, end);
        const pendentesAfterBalance = await calculatePendentesEngine({ startDate: start, endDate: end });

        expect(cashAfterBalance.total).toBe(500);
        expect(metaAfterBalance.total).toBe(500);
        // Produção não duplica — a sessão já tinha sido reconhecida na conclusão.
        expect(producaoAfterBalance.total).toBe(500);
        // A Receber zera — nada mais em aberto pra essa consulta.
        expect(pendentesAfterBalance.total).toBe(0);
    }, 30000);

    it('sinal e saldo pagos em MESES diferentes ficam cada um na sua data financeira, sem vazar pro mês do outro', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();

        const mongoSession = await mongoose.startSession();
        let created;
        await mongoSession.withTransaction(async () => {
            created = await appointmentHybridService.create({
                patientId: patient._id,
                doctorId: doctor._id,
                date: '2026-09-10',
                time: '09:00',
                specialty: 'neuroped',
                serviceType: 'consultation',
                billingType: 'particular',
                paymentMethod: 'pix',
                amount: 500,
                depositAmount: 50,
                depositPaidAt: '2026-08-05T12:00:00-03:00', // sinal em AGOSTO
                userId: FAKE_USER._id,
                operationalStatus: 'pre_agendado',
            }, mongoSession);
        });
        await mongoSession.endSession();

        const balance = await depositBalance.findBalancePayment({ appointmentId: created.appointmentId, billingType: 'particular' });
        // Saldo pago em SETEMBRO
        await Payment.findByIdAndUpdate(balance._id, {
            $set: { status: 'paid', paidAt: new Date('2026-09-20T12:00:00-03:00'), financialDate: new Date('2026-09-20T12:00:00-03:00') },
        });
        invalidateUFSCache();

        const august = await calculateCashForDashboard(new Date('2026-08-01T00:00:00-03:00'), new Date('2026-08-31T23:59:59-03:00'));
        const september = await calculateCashForDashboard(new Date('2026-09-01T00:00:00-03:00'), new Date('2026-09-30T23:59:59-03:00'));

        expect(august.total).toBe(50);
        expect(september.total).toBe(450);
    });

    it('ledger tem exatamente 2 créditos payment_received (R$50 e R$450), vinculados aos respectivos Payments', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient });

        await completeSessionV2(appointmentId, { userId: FAKE_USER._id, paymentMethod: 'pix' });

        const deposit = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        const balance = await depositBalance.findBalancePayment({ appointmentId, billingType: 'particular' });

        const credits = await FinancialLedger.find({
            payment: { $in: [deposit._id, balance._id] },
            type: 'payment_received',
        }).lean();

        expect(credits).toHaveLength(2);
        const byPayment = Object.fromEntries(credits.map(c => [c.payment.toString(), c.amount]));
        expect(byPayment[deposit._id.toString()]).toBe(50);
        expect(byPayment[balance._id.toString()]).toBe(450);
    }, 20000);
});

describe('updateAppointmentCommand — edição de valor total só toca o saldo', () => {
    it('editar consulta de R$500 adicionando sinal de R$50 não repassa o total ao Payment do sinal', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const created = await appointmentHybridService.create({
            patientId: patient._id,
            doctorId: doctor._id,
            date: '2026-09-10',
            time: '09:00',
            specialty: 'neuroped',
            serviceType: 'consultation',
            billingType: 'particular',
            paymentMethod: 'pix',
            amount: 500,
            operationalStatus: 'pre_agendado',
            userId: FAKE_USER._id,
        });

        await updateAppointmentCommand.execute(created.appointmentId, {
            sessionValue: 500,
            depositAmount: 50,
            depositPaymentMethod: 'pix',
            depositPaidAt: new Date('2026-09-04T13:18:25-03:00'),
        }, FAKE_USER);

        const payments = await Payment.find({ appointment: created.appointmentId });
        const deposit = payments.find(payment => payment.paymentRole === 'deposit');
        const balance = payments.find(payment => payment.paymentRole === 'balance');
        const appointment = await Appointment.findById(created.appointmentId);

        expect(payments).toHaveLength(2);
        expect(deposit.amount).toBe(50);
        expect(deposit.status).toBe('paid');
        expect(balance.amount).toBe(450);
        expect(balance.status).toBe('pending');
        expect(appointment.payment.toString()).toBe(balance._id.toString());
    });

    it('edição genérica nunca infla Payment já pago de R$50 para o total de R$500', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const created = await appointmentHybridService.create({
            patientId: patient._id,
            doctorId: doctor._id,
            date: '2026-09-10',
            time: '09:00',
            specialty: 'neuroped',
            serviceType: 'consultation',
            billingType: 'particular',
            paymentMethod: 'pix',
            amount: 500,
            operationalStatus: 'pre_agendado',
            userId: FAKE_USER._id,
        });

        await Payment.findByIdAndUpdate(created.paymentId, {
            $set: {
                amount: 50,
                status: 'paid',
                paidAt: new Date('2026-09-04T13:18:25-03:00'),
                financialDate: new Date('2026-09-04T13:18:25-03:00'),
                paymentRole: 'standard',
            },
        });

        await updateAppointmentCommand.execute(created.appointmentId, { sessionValue: 500 }, FAKE_USER);

        const paymentAfter = await Payment.findById(created.paymentId);
        expect(paymentAfter.amount).toBe(50);
        expect(paymentAfter.status).toBe('paid');
    });

    it('sinal pago permanece R$50; total 500→600 muda só o saldo pra R$550; Appointment.payment aponta pro saldo', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient });

        const depositBefore = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        expect(depositBefore.amount).toBe(50);

        await updateAppointmentCommand.execute(appointmentId, { sessionValue: 600 }, FAKE_USER);

        const depositAfter = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        const balanceAfter = await depositBalance.findBalancePayment({ appointmentId, billingType: 'particular' });
        const apptAfter = await Appointment.findById(appointmentId);

        expect(depositAfter.amount).toBe(50);
        expect(depositAfter.status).toBe('paid');
        expect(depositAfter.updatedAt.getTime()).toBe(depositBefore.updatedAt.getTime()); // nem tocado
        expect(balanceAfter.amount).toBe(550);
        expect(apptAfter.sessionValue).toBe(600);
        // Appointment.payment SEMPRE aponta pro saldo, nunca pro sinal.
        expect(apptAfter.payment.toString()).toBe(balanceAfter._id.toString());
        expect(apptAfter.payment.toString()).not.toBe(depositAfter._id.toString());
    });

    it('reduzir o total abaixo do sinal já pago é rejeitado (DEPOSIT_EXCEEDS_NEW_TOTAL); nenhuma alteração parcial persiste', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient }); // total 500, sinal 50

        const depositBefore = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        const balanceBefore = await depositBalance.findBalancePayment({ appointmentId, billingType: 'particular' });
        const apptBefore = await Appointment.findById(appointmentId).lean();

        await expect(
            updateAppointmentCommand.execute(appointmentId, { sessionValue: 30, paymentMethod: 'dinheiro' }, FAKE_USER)
        ).rejects.toMatchObject({ code: 'DEPOSIT_EXCEEDS_NEW_TOTAL', status: 409 });

        // Nada mudou — nem o Appointment, nem o sinal, nem o saldo, nem o paymentMethod
        // que seria alterado no mesmo update (prova de atomicidade: a transação
        // aborta por completo, não deixa a mudança de sessionValue meio-aplicada).
        const depositAfter = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        const balanceAfter = await depositBalance.findBalancePayment({ appointmentId, billingType: 'particular' });
        const apptAfter = await Appointment.findById(appointmentId).lean();

        expect(depositAfter.amount).toBe(depositBefore.amount);
        expect(balanceAfter.amount).toBe(balanceBefore.amount);
        expect(balanceAfter.paymentMethod).toBe(balanceBefore.paymentMethod);
        expect(apptAfter.sessionValue).toBe(apptBefore.sessionValue);
        expect(apptAfter.updatedAt.getTime()).toBe(apptBefore.updatedAt.getTime());
    });
});

describe('cancelAppointmentCommand / restoreCanceledAppointmentCommand — sinal + saldo', () => {
    it('cancelamento cancela os DOIS Payments (sinal e saldo) e reverte o crédito do sinal no ledger', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient });

        const deposit = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        const balance = await depositBalance.findBalancePayment({ appointmentId, billingType: 'particular' });

        const mongoSession = await mongoose.startSession();
        await mongoSession.withTransaction(async () => {
            await cancelAppointmentCommand.executeWithSession(
                appointmentId,
                { reason: 'Paciente desistiu' },
                FAKE_USER,
                mongoSession
            );
        });
        await mongoSession.endSession();

        const depositAfter = await Payment.findById(deposit._id);
        const balanceAfter = await Payment.findById(balance._id);
        expect(depositAfter.status).toBe('canceled');
        expect(balanceAfter.status).toBe('canceled');

        // O sinal tinha sido creditado no ledger (paid) — cancelar precisa reverter esse crédito.
        const reversal = await FinancialLedger.findOne({ payment: deposit._id, type: 'reversal' }).lean();
        expect(reversal).toBeTruthy();
        expect(reversal.amount).toBe(50);
    });

    it('restauração traz os DOIS Payments de volta (nenhum fica perdido em canceled)', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient });

        const deposit = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        const balance = await depositBalance.findBalancePayment({ appointmentId, billingType: 'particular' });

        const mongoSession = await mongoose.startSession();
        await mongoSession.withTransaction(async () => {
            await cancelAppointmentCommand.executeWithSession(appointmentId, { reason: 'teste' }, FAKE_USER, mongoSession);
        });

        const canceledAppt = await Appointment.findById(appointmentId).populate('session payment package').session(mongoSession);

        await mongoSession.withTransaction(async () => {
            const result = await restoreCanceledAppointmentCommand.executeWithSession(
                canceledAppt,
                { reason: 'Reativação de teste' },
                FAKE_USER,
                mongoSession
            );
            expect(result.paymentsRestored).toBe(2);
        });
        await mongoSession.endSession();

        const depositAfter = await Payment.findById(deposit._id);
        const balanceAfter = await Payment.findById(balance._id);

        // Nenhum dos dois fica perdido em 'canceled' — os dois voltam pra 'pending'
        // (nunca 'paid' sozinho — mesma cautela já usada pro caso de 1 Payment).
        expect(depositAfter.status).toBe('pending');
        expect(balanceAfter.status).toBe('pending');
        expect(depositAfter.canceledAt).toBeNull();
        expect(balanceAfter.canceledAt).toBeNull();
    });
});

describe('deleteAppointmentCommand — sinal + saldo', () => {
    it('exclusão sem sinal pago: os dois Payments (pending) são removidos, sem órfão', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient });

        const deposit = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        const balance = await depositBalance.findBalancePayment({ appointmentId, billingType: 'particular' });

        // Simula sinal ainda não confirmado por engano nenhum — força pending pra
        // testar o ramo "sem dinheiro real" da exclusão (hard-delete seguro).
        await Payment.findByIdAndUpdate(deposit._id, { $set: { status: 'pending', paidAt: null, financialDate: null } });

        await executeDeleteWithWorkaround(appointmentId, FAKE_USER);

        const remaining = await Payment.find({
            $or: [{ appointment: appointmentId }, { appointmentId: appointmentId.toString() }],
        });
        expect(remaining).toHaveLength(0);
        expect(await Appointment.findById(appointmentId)).toBeNull();
    });

    it('EXCLUSÃO DE PRÉ-AGENDAMENTO COM SINAL PAGO: o sinal NUNCA é hard-deleted — vira canceled, ledger continua apontando pra um Payment existente', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient });

        const deposit = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        const balance = await depositBalance.findBalancePayment({ appointmentId, billingType: 'particular' });
        expect(deposit.status).toBe('paid'); // sinal real, dinheiro já entrou

        const creditBefore = await FinancialLedger.findOne({ payment: deposit._id, type: 'payment_received' }).lean();
        expect(creditBefore).toBeTruthy();

        await executeDeleteWithWorkaround(appointmentId, FAKE_USER);

        // O Appointment some, mas o Payment do sinal CONTINUA EXISTINDO no banco —
        // só muda de status. Nunca hard-delete de dinheiro real.
        const depositAfter = await Payment.findById(deposit._id);
        expect(depositAfter).not.toBeNull();
        expect(depositAfter.status).toBe('canceled');

        // O saldo (nunca foi pago) é seguro remover fisicamente — sem dinheiro real por trás.
        const balanceAfter = await Payment.findById(balance._id);
        expect(balanceAfter).toBeNull();

        // 🛡️ FinancialLedger nunca fica apontando pra um Payment removido: o
        // crédito original do sinal continua existindo E continua resolvendo
        // pra um Payment que ainda existe no banco (canceled, não deletado).
        const creditAfter = await FinancialLedger.findOne({ _id: creditBefore._id }).lean();
        expect(creditAfter).toBeTruthy();
        const paymentStillExists = await Payment.findById(creditAfter.payment).lean();
        expect(paymentStillExists).not.toBeNull();

        // E o cancelamento deve ter dado baixa (reversão) desse crédito — não
        // deixa o ledger com um "payment_received" ativo pra um Payment cancelado.
        const reversal = await FinancialLedger.findOne({ payment: deposit._id, type: 'reversal' }).lean();
        expect(reversal).toBeTruthy();
        expect(reversal.amount).toBe(50);

        expect(await Appointment.findById(appointmentId)).toBeNull();
    });
});

describe('recomputeAppointmentPaymentState — recálculo usado na exclusão de Payment via rota admin', () => {
    it('excluir o saldo (pending) não rebaixa o appointment quando o sinal continua pago', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient });

        const deposit = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        const balance = await depositBalance.findBalancePayment({ appointmentId, billingType: 'particular' });

        // appointment.payment hoje aponta pro saldo — simula ele sendo removido
        // (equivalente ao passo 3 da rota DELETE /api/v2/payments/:id)
        await Payment.deleteOne({ _id: balance._id });
        const { primary, paymentStatus, isPaid } = await depositBalance.recomputeAppointmentPaymentState(appointmentId, balance._id);

        // Sobrou só o sinal — mas sinal sozinho NUNCA significa "consulta paga":
        // vira o novo `primary` só porque é o único que resta, com paymentStatus
        // refletindo o status real dele (paid), não uma regressão pra "pending".
        expect(primary._id.toString()).toBe(deposit._id.toString());
        expect(paymentStatus).toBe('paid');
        expect(isPaid).toBe(true);

        const apptAfter = await Appointment.findById(appointmentId);
        expect(apptAfter.payment.toString()).toBe(deposit._id.toString());
        expect(apptAfter.isPaid).toBe(true);
    });

    it('excluir um Payment quando não sobra nenhum outro: appointment volta pra pending/unpaid, payment=null', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient, depositAmount: 0 });

        // Sem depositAmount, é o fluxo legado: 1 Payment standard.
        const standard = await Payment.findOne({ appointment: appointmentId });
        await Payment.deleteOne({ _id: standard._id });

        const { primary, paymentStatus, isPaid } = await depositBalance.recomputeAppointmentPaymentState(appointmentId, standard._id);
        expect(primary).toBeNull();
        expect(paymentStatus).toBe('pending');
        expect(isPaid).toBe(false);

        const apptAfter = await Appointment.findById(appointmentId);
        expect(apptAfter.payment).toBeNull();
    });
});

describe('Contrato: depositAmount > 0 não significa "dinheiro recebido" por si só', () => {
    it('o único jeito de um Payment contar em Caixa Real é status=paid — um deposit hipotético status=pending não conta', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const start = new Date('2026-09-01T00:00:00-03:00');
        const end = new Date('2026-09-30T23:59:59-03:00');

        // O domínio não tem um estado "sinal solicitado" — createDepositAndBalancePayments
        // SEMPRE cria o deposit já com status='paid' (contrato: só é chamado quando a
        // secretária confirma que o dinheiro já entrou — ver depositBalance.js e o rótulo
        // "Valor recebido agora" na UI). Simulamos aqui, por fora do fluxo normal, um
        // Payment role=deposit que NUNCA foi confirmado (status='pending') — pra provar
        // que MESMO SE alguém o criasse assim, ele não vaza pro Caixa/Meta.
        await Payment.create({
            patient: patient._id,
            doctor: doctor._id,
            amount: 50,
            paymentDate: new Date('2026-09-05'),
            paymentMethod: 'pix',
            status: 'pending', // "solicitado", nunca confirmado
            billingType: 'particular',
            kind: 'session_payment',
            paymentRole: 'deposit',
        });

        const cash = await calculateCashForDashboard(start, end);
        const meta = await calculateMetaRealizada(start, end);
        expect(cash.total).toBe(0);
        expect(meta.total).toBe(0);
    });

    it('createDepositAndBalancePayments sempre cria o deposit com status=paid e paidAt/financialDate preenchidos — nunca "pending"', async () => {
        const patientId = new mongoose.Types.ObjectId();
        const doctorId = new mongoose.Types.ObjectId();
        const appointmentId = new mongoose.Types.ObjectId();
        const sessionId = new mongoose.Types.ObjectId();

        const session = await mongoose.startSession();
        let deposit;
        await session.withTransaction(async (s) => {
            const result = await depositBalance.createDepositAndBalancePayments({
                patientId, doctorId, appointmentId, sessionId,
                billingType: 'particular', sessionValue: 500, depositAmount: 50,
                correlationId: `contract_${appointmentId}`,
            }, s);
            deposit = result.depositPayment;
        });
        await session.endSession();

        expect(deposit.status).toBe('paid');
        expect(deposit.paidAt).toBeInstanceOf(Date);
        expect(deposit.financialDate).toBeInstanceOf(Date);
    });
});

describe('registro de sinal durante a edicao', () => {
    it('registra o primeiro sinal sem criar uma terceira obrigacao', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient, depositAmount: 0 });

        const updateResult = await updateAppointmentCommand.execute(appointmentId, {
            depositAmount: 50,
            depositPaymentMethod: 'pix',
        }, FAKE_USER);

        const payments = await Payment.find({ appointment: appointmentId });
        const deposit = payments.find((payment) => payment.paymentRole === 'deposit');
        const balance = payments.find((payment) => payment.paymentRole === 'balance');
        const appointment = await Appointment.findById(appointmentId).lean();
        const credits = await FinancialLedger.find({ payment: deposit._id, type: 'payment_received' });

        expect(payments).toHaveLength(2);
        expect(deposit).toMatchObject({ amount: 50, status: 'paid', paymentMethod: 'pix' });
        expect(balance).toMatchObject({ amount: 450, status: 'pending' });
        expect(appointment.sessionValue).toBe(500);
        expect(appointment.payment.toString()).toBe(balance._id.toString());
        expect(appointment.paymentStatus).toBe('partial');
        expect(credits).toHaveLength(1);
        expect(credits[0].amount).toBe(50);
        expect(updateResult.data.depositAmount).toBe(50);
        expect(updateResult.data.remainingAmount).toBe(450);
        expect(updateResult.data.payment.amount).toBe(450);
        expect(updateResult.data.payment.status).toBe('pending');
    });

    it('retry nao duplica Payments nem o credito do sinal', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient, depositAmount: 0 });
        const payload = { depositAmount: 50, depositPaymentMethod: 'pix' };

        await updateAppointmentCommand.execute(appointmentId, payload, FAKE_USER);
        await updateAppointmentCommand.execute(appointmentId, payload, FAKE_USER);

        const payments = await Payment.find({ appointment: appointmentId });
        const deposit = payments.find((payment) => payment.paymentRole === 'deposit');
        const credits = await FinancialLedger.find({ payment: deposit._id, type: 'payment_received' });

        expect(payments).toHaveLength(2);
        expect(credits).toHaveLength(1);
    });

    it('nao sobrescreve um sinal que ja entrou no caixa', async () => {
        const doctor = await createDoctor();
        const patient = await createPatient();
        const { appointmentId } = await createAppointmentWithDeposit({ doctor, patient });

        await expect(updateAppointmentCommand.execute(appointmentId, {
            depositAmount: 80,
            depositPaymentMethod: 'pix',
        }, FAKE_USER)).rejects.toMatchObject({ code: 'DEPOSIT_ALREADY_RECEIVED', status: 409 });

        const deposit = await depositBalance.findDepositPayment({ appointmentId, billingType: 'particular' });
        expect(deposit.amount).toBe(50);
    });
});
