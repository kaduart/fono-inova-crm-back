/**
 * 🧪 Testes E2E - Fluxo Completo: Débito → Pacote → Quitação (V2)
 *
 * Fluxo testado:
 * 1. Criar agendamento avulso (V2)
 * 2. Completar agendamento → criar débito no balance
 * 3. Criar pacote (V2) selecionando o débito
 * 4. Verificar se débito foi quitado
 * 5. Verificar se appointment foi marcado como pago
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import express from 'express';
import moment from 'moment-timezone';

// Mock auth
vi.mock('../../middleware/auth.js', () => ({
    auth: (req, res, next) => {
        req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin' };
        next();
    },
    authorize: () => (req, res, next) => next()
}));

vi.mock('../../middleware/amandaAuth.js', () => ({
    flexibleAuth: (req, res, next) => {
        req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin' };
        next();
    }
}));

import { vi } from 'vitest';

let mongoReplSet;
let app;

let Patient, Doctor, Package, Appointment, Session, Payment, PatientBalance;

beforeAll(async () => {
    mongoReplSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, dbName: 'crm_test' }
    });
    await mongoose.connect(mongoReplSet.getUri());

    await import('../../models/PatientsView.js');
    Patient = (await import('../../models/Patient.js')).default;
    Doctor = (await import('../../models/Doctor.js')).default;
    Package = (await import('../../models/Package.js')).default;
    Appointment = (await import('../../models/Appointment.js')).default;
    Session = (await import('../../models/Session.js')).default;
    Payment = (await import('../../models/Payment.js')).default;
    PatientBalance = (await import('../../models/PatientBalance.js')).default;

    app = express();
    app.use(express.json());

    const patientV2Router = (await import('../../routes/patient.v2.js')).default;
    const doctorRouter = (await import('../../routes/doctor.js')).default;
    const appointmentV2Router = (await import('../../routes/appointment.v2.js')).default;
    const packageV2Router = (await import('../../routes/package.v2.js')).default;
    const paymentRouter = (await import('../../routes/Payment.js')).default;

    app.use('/api/v2/patients', patientV2Router);
    app.use('/api/doctors', doctorRouter);
    app.use('/api/v2/appointments', appointmentV2Router);
    app.use('/api/v2/packages', packageV2Router);
    app.use('/api/payments', paymentRouter);

    app.use((err, req, res, next) => {
        console.error('TEST APP ERROR:', err);
        res.status(err.status || 500).json({ error: err.message || 'Internal error' });
    });
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoReplSet.stop();
});

describe('E2E: Fluxo Débito → Pacote → Quitação (V2)', () => {
    let patientId;
    let doctorId;
    let appointmentId;
    let packageId;

    beforeAll(async () => {
        const patientRes = await request(app)
            .post('/api/v2/patients')
            .send({ fullName: 'Paciente Teste E2E', phone: '61999999999', email: 'teste-e2e@test.com', dateOfBirth: '1990-01-01' });
        expect(patientRes.status).toBe(201);
        patientId = patientRes.body.data.patientId;

        const doctorRes = await request(app)
            .post('/api/doctors')
            .send({ fullName: 'Dr. Teste E2E', specialty: 'fonoaudiologia', email: 'dr-teste@test.com', licenseNumber: '12345', phoneNumber: '61999999999' });
        expect(doctorRes.status).toBe(201);
        doctorId = doctorRes.body.doctor._id;
    });

    it('deve criar agendamento e gerar débito ao completar', async () => {

        const tomorrow = moment().add(1, 'day').format('YYYY-MM-DD');

        const apptRes = await request(app)
            .post('/api/v2/appointments')
            .send({
                patientId,
                doctorId,
                date: tomorrow,
                time: '14:00',
                specialty: 'fonoaudiologia',
                sessionValue: 130,
                paymentMethod: 'pix',
                addToBalance: true
            });

        expect(apptRes.status).toBe(201);
        appointmentId = apptRes.body.data?.appointmentId || apptRes.body.appointment?._id;

        // Completar agendamento
        const completeRes = await request(app)
            .patch(`/api/v2/appointments/${appointmentId}/complete`)
            .send({ addToBalance: true });

        expect(completeRes.status).toBe(200);

        // Verificar se débito foi criado no balance
        const balance = await PatientBalance.findOne({ patient: patientId });
        expect(balance).toBeTruthy();
        expect(balance.transactions.length).toBe(1);
        expect(balance.transactions[0].type).toBe('debit');
        expect(balance.transactions[0].amount).toBe(130);
        expect(balance.currentBalance).toBe(130);
    });

    it('deve listar débitos pendentes por especialidade', async () => {
        // O teste anterior já criou o débito
        const balance = await PatientBalance.findOne({ patient: patientId });
        expect(balance).toBeTruthy();
        const fonoDebits = balance.transactions.filter(t =>
            t.type === 'debit' && t.specialty === 'fonoaudiologia' && !t.isPaid
        );
        expect(fonoDebits.length).toBe(1);
        expect(fonoDebits[0].amount).toBe(130);
    });

    it('deve criar pacote e quitar débitos selecionados', async () => {
        const balanceBefore = await PatientBalance.findOne({ patient: patientId });
        const debitId = balanceBefore.transactions[0]._id.toString();

        const tomorrow = moment().add(1, 'day').format('YYYY-MM-DD');

        // Criar pacote V2 selecionando o débito
        const packageRes = await request(app)
            .post('/api/v2/packages')
            .send({
                patientId,
                doctorId,
                specialty: 'fonoaudiologia',
                sessionType: 'fonoaudiologia',
                sessionValue: 130,
                totalSessions: 5,
                durationMonths: 1,
                sessionsPerWeek: 1,
                calculationMode: 'sessions',
                type: 'package',
                model: 'prepaid',
                date: tomorrow,
                time: '10:00',
                schedule: [
                    { date: moment().add(1, 'day').format('YYYY-MM-DD'), time: '10:00' },
                    { date: moment().add(8, 'day').format('YYYY-MM-DD'), time: '10:00' },
                    { date: moment().add(15, 'day').format('YYYY-MM-DD'), time: '10:00' },
                    { date: moment().add(22, 'day').format('YYYY-MM-DD'), time: '10:00' },
                    { date: moment().add(29, 'day').format('YYYY-MM-DD'), time: '10:00' },
                ],
                selectedDebts: [debitId],
                payments: [{ amount: 650, method: 'pix', date: moment().format('YYYY-MM-DD'), description: 'Pagamento integral' }]
            });

        expect(packageRes.status).toBe(201);
        packageId = packageRes.body.data.packageId;

        // Verificar se débito foi quitado
        const balanceAfter = await PatientBalance.findOne({ patient: patientId });
        const settledDebit = balanceAfter.transactions.find(t => t._id.toString() === debitId);
        expect(settledDebit.settledByPackageId.toString()).toBe(packageId);
        expect(settledDebit.isPaid).toBe(true);

        // Verificar se crédito foi criado
        const credit = balanceAfter.transactions.find(t => t.type === 'credit');
        expect(credit).toBeTruthy();
        expect(credit.amount).toBe(130);

        // Verificar saldo atualizado
        expect(balanceAfter.currentBalance).toBe(0); // 130 débito - 130 crédito
    });

    it('não deve permitir quitar débito já quitado', async () => {
        const balance = await PatientBalance.findOne({ patient: patientId });
        const settledDebitId = balance.transactions.find(t => t.settledByPackageId)._id;

        const tomorrow = moment().add(1, 'day').format('YYYY-MM-DD');

        const packageRes = await request(app)
            .post('/api/v2/packages')
            .send({
                patientId,
                doctorId,
                specialty: 'fonoaudiologia',
                sessionType: 'fonoaudiologia',
                sessionValue: 130,
                totalSessions: 5,
                durationMonths: 1,
                sessionsPerWeek: 1,
                calculationMode: 'sessions',
                type: 'package',
                model: 'prepaid',
                date: tomorrow,
                time: '15:00',
                schedule: [
                    { date: moment().add(2, 'day').format('YYYY-MM-DD'), time: '15:00' },
                    { date: moment().add(9, 'day').format('YYYY-MM-DD'), time: '15:00' },
                    { date: moment().add(16, 'day').format('YYYY-MM-DD'), time: '15:00' },
                    { date: moment().add(23, 'day').format('YYYY-MM-DD'), time: '15:00' },
                    { date: moment().add(30, 'day').format('YYYY-MM-DD'), time: '15:00' },
                ],
                selectedDebts: [settledDebitId],
                payments: [{ amount: 650, method: 'pix', date: moment().format('YYYY-MM-DD'), description: 'Pagamento integral' }]
            });

        expect(packageRes.status).toBe(400);
    });

    it('deve filtrar corretamente após quitação', async () => {
        const balance = await PatientBalance.findOne({ patient: patientId });
        const fonoDebits = balance.transactions.filter(t =>
            t.type === 'debit' && t.specialty === 'fonoaudiologia' && !t.isPaid
        );
        expect(fonoDebits.length).toBe(0);
    });
});
