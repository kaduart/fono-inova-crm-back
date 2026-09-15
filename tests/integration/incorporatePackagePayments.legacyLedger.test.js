/**
 * 🧪 incorporatePackagePayments() não pode ser bloqueado por lançamentos
 * antigos e quebrados no PatientBalance do paciente (achado 2026-09-15,
 * caso Julia Boarati: 5 transações legadas sem `description` travavam a
 * criação de QUALQUER pacote novo, mesmo sem relação com elas).
 *
 * Antes da correção, o bloco de quitação usava `patientBalance.save()`,
 * que faz o Mongoose revalidar o array `transactions` inteiro. Agora usa
 * `PatientBalance.updateOne()` atômico com `runValidators` — valida só a
 * movimentação nova.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../services/financialGuard/index.js', () => ({
    default: { execute: vi.fn().mockResolvedValue({}) }
}));

import '../../models/PatientsView.js';
import PatientBalance from '../../models/PatientBalance.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import Package from '../../models/Package.js';
import { incorporatePackagePayments } from '../../services/package/incorporatePackagePayments.js';

describe('Integração: incorporatePackagePayments() não é bloqueado por ledger legado quebrado', () => {
    let mongoReplSet;
    const PATIENT_ID = new mongoose.Types.ObjectId();
    const DOCTOR_ID = new mongoose.Types.ObjectId();

    beforeAll(async () => {
        mongoReplSet = await MongoMemoryReplSet.create({ replSet: { count: 1, dbName: 'crm_test' } });
        await mongoose.connect(mongoReplSet.getUri());

        await Patient.create({
            _id: PATIENT_ID,
            fullName: 'Paciente Teste Ledger',
            dateOfBirth: new Date('1990-01-01'),
            phone: '11999999999'
        });

        await Doctor.create({
            _id: DOCTOR_ID,
            fullName: 'Doutor Teste',
            specialty: 'fonoaudiologia',
            phoneNumber: '11988888888',
            licenseNumber: 'CRM-99999',
            email: 'doctor-ledger@test.com'
        });
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await mongoReplSet.stop();
    });

    beforeEach(async () => {
        await PatientBalance.deleteMany({ patient: PATIENT_ID });
        await Appointment.deleteMany({ patient: PATIENT_ID });
        await Session.deleteMany({ patient: PATIENT_ID });
        await Payment.deleteMany({ patient: PATIENT_ID });
        await Package.deleteMany({ patient: PATIENT_ID });
    });

    async function createRetroactiveTrio({ amount = 160 } = {}) {
        const appointment = new Appointment({
            patient: PATIENT_ID,
            doctor: DOCTOR_ID,
            date: new Date('2026-09-15T12:00:00.000Z'),
            time: '10:40',
            specialty: 'fonoaudiologia',
            operationalStatus: 'completed',
            billingType: 'particular'
        });
        appointment._fromCompleteService = true;
        await appointment.save();

        const session = new Session({
            patient: PATIENT_ID,
            doctor: DOCTOR_ID,
            appointmentId: appointment._id,
            date: appointment.date,
            time: '10:40',
            sessionType: 'fonoaudiologia',
            status: 'completed',
            sessionValue: amount
        });
        session._fromCompleteService = true;
        await session.save();
        await Appointment.updateOne({ _id: appointment._id }, { $set: { session: session._id } });
        const payment = await Payment.create({
            patient: PATIENT_ID,
            doctor: DOCTOR_ID,
            appointment: appointment._id,
            session: session._id,
            amount,
            paymentDate: new Date(),
            paymentMethod: 'pix',
            billingType: 'particular',
            kind: 'session_payment',
            status: 'pending'
        });
        return { appointment, session, payment };
    }

    it('quita a sessão selecionada mesmo com 5 lançamentos antigos sem description no mesmo PatientBalance', async () => {
        const { appointment, session, payment } = await createRetroactiveTrio({ amount: 160 });

        // Reproduz exatamente o achado real: transações legadas inseridas via
        // $push cru (sem runValidators), sem `description` — schema exige o
        // campo, então isso só é possível via updateOne sem validação, como
        // era o balanceWorker.js antes da correção.
        await PatientBalance.collection.insertOne({
            patient: PATIENT_ID,
            currentBalance: 1000,
            totalDebited: 1000,
            totalCredited: 0,
            transactions: [
                { _id: new mongoose.Types.ObjectId(), type: 'debit', amount: 200, isPaid: false, transactionDate: new Date() },
                { _id: new mongoose.Types.ObjectId(), type: 'debit', amount: 200, isPaid: false, transactionDate: new Date() },
                { _id: new mongoose.Types.ObjectId(), type: 'debit', amount: 200, isPaid: false, transactionDate: new Date() },
                { _id: new mongoose.Types.ObjectId(), type: 'debit', amount: 200, isPaid: false, transactionDate: new Date() },
                { _id: new mongoose.Types.ObjectId(), type: 'debit', amount: 200, isPaid: false, transactionDate: new Date() }
                // nenhum tem `description` — exatamente o caso Julia Boarati
            ],
            createdAt: new Date(),
            updatedAt: new Date()
        });

        const pkg = await Package.create({
            patient: PATIENT_ID,
            doctor: DOCTOR_ID,
            durationMonths: 1,
            sessionsPerWeek: 2,
            sessionType: 'fonoaudiologia',
            specialty: 'fonoaudiologia',
            date: new Date('2026-09-15T12:00:00.000Z'),
            totalSessions: 8,
            sessionValue: 160,
            totalValue: 1280,
            totalPaid: 0,
            balance: 1280,
            financialStatus: 'unpaid',
            model: 'prepaid',
            paymentType: 'full',
            billingModel: 'particular'
        });

        const mongoSession = await mongoose.startSession();
        await mongoSession.startTransaction();

        let result;
        let thrown = null;
        try {
            result = await incorporatePackagePayments(pkg, [payment._id], {
                mongoSession,
                userId: new mongoose.Types.ObjectId(),
                paymentMethod: 'cartao_credito',
                paymentDate: '2026-09-15',
                requireCompleted: true
            });
            await mongoSession.commitTransaction();
        } catch (err) {
            thrown = err;
            await mongoSession.abortTransaction();
        } finally {
            await mongoSession.endSession();
        }

        // 🎯 Antes da correção: isso lançava
        // "PatientBalance validation failed: transactions.N.description: ..."
        expect(thrown).toBeNull();
        expect(result.settledCount).toBe(1);
        expect(result.totalSettled).toBe(160);

        // Os 5 lançamentos antigos continuam exatamente como estavam —
        // nada financeiro neles foi alterado (não fazia parte da seleção).
        const balance = await PatientBalance.findOne({ patient: PATIENT_ID });
        const untouchedLegacy = balance.transactions.filter(t => !t.description && t.type === 'debit');
        expect(untouchedLegacy).toHaveLength(5);
        untouchedLegacy.forEach(t => expect(t.amount).toBe(200));

        // O pagamento retroativo selecionado foi de fato quitado.
        const updatedPayment = await Payment.findById(payment._id);
        expect(updatedPayment.status).toBe('paid');
        expect(updatedPayment.package.toString()).toBe(pkg._id.toString());
    });
});
