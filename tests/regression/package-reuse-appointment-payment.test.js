/**
 * 🚨 REGRESSÃO — Zion Bug
 *
 * Cenário:
 * 1. Paciente tem sessão avulsa agendada com payment pending
 * 2. Cria pacote reutilizando esse appointment (appointmentId)
 * 3. Valida que:
 *    - payment antigo foi convertido para 'converted_to_package'
 *    - appointment.payment foi limpo (null)
 *    - appointment.isPaid está correto (prepaid vs per-session)
 *    - session sincroniza isPaid + paymentStatus
 *    - não gera ghost payment / dívida fantasma
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import express from 'express';
import moment from 'moment-timezone';
import { buildDateTime } from '../../utils/datetime.js';
import jwt from 'jsonwebtoken';

// Mock do middleware de auth
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

let mongoReplSet;
let app;

let Patient, Doctor, Package, Session, Payment, Appointment;

beforeAll(async () => {
    process.env.JWT_SECRET = 'zion-test-secret-123';
    mongoReplSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, dbName: 'crm_test_zion' }
    });
    await mongoose.connect(mongoReplSet.getUri());

    Patient = (await import('../../models/Patient.js')).default;
    Doctor = (await import('../../models/Doctor.js')).default;
    Package = (await import('../../models/Package.js')).default;
    Session = (await import('../../models/Session.js')).default;
    Payment = (await import('../../models/Payment.js')).default;
    Appointment = (await import('../../models/Appointment.js')).default;

    // Dependências obrigatórias
    await import('../../models/PatientsView.js');
    await import('../../models/PatientBalance.js');
    await import('../../models/FinancialLedger.js');
    await import('../../models/MedicalEvent.js');
    await import('../../models/FinancialEvent.js');

    app = express();
    app.use(express.json());

    const packageV2Router = (await import('../../routes/package.v2.js')).default;
    app.use('/api/v2/packages', packageV2Router);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoReplSet.stop();
});

beforeEach(async () => {
    // Limpeza manual controlada — evita race com transações abertas
    const collections = ['appointments', 'sessions', 'payments', 'packages', 'patients', 'doctors', 'patientsviews', 'patientbalances', 'financialedgers', 'medicalevents'];
    for (const name of collections) {
        try {
            const col = mongoose.connection.collection(name);
            if (col) await col.deleteMany({});
        } catch (e) { /* ignore */ }
    }
});

// =============================================================================
// HELPERS
// =============================================================================
async function createPatient(name = 'Paciente Zion') {
    return await Patient.create({ fullName: name, phone: '62999999999', dateOfBirth: '2015-01-01' });
}

async function createDoctor(name = 'Dr. Zion') {
    const suffix = Math.random().toString(36).substring(7);
    return await Doctor.create({
        fullName: name,
        specialty: 'fonoaudiologia',
        email: `dr_${suffix}@teste.com`,
        licenseNumber: `CRM-${suffix}`,
        phoneNumber: '62999999999'
    });
}

async function createAvulsoAppointment(patient, doctor, dateStr, timeStr) {
    const date = buildDateTime(dateStr, timeStr);
    const appt = await Appointment.create({
        patient: patient._id,
        patientName: patient.fullName,
        doctor: doctor._id,
        date,
        time: timeStr,
        duration: 40,
        specialty: 'fonoaudiologia',
        serviceType: 'individual_session',
        operationalStatus: 'scheduled',
        clinicalStatus: 'pending',
        paymentStatus: 'pending',
        paymentOrigin: 'individual',
        billingType: 'particular',
        sessionValue: 150,
        isPaid: false
    });

    const session = await Session.create({
        patient: patient._id,
        doctor: doctor._id,
        date,
        time: timeStr,
        specialty: 'fonoaudiologia',
        sessionType: 'fonoaudiologia',
        status: 'scheduled',
        paymentStatus: 'pending',
        isPaid: false,
        sessionValue: 150,
        appointmentId: appt._id
    });

    appt.session = session._id;
    await appt.save();

    const payment = await Payment.create({
        patient: patient._id,
        doctor: doctor._id,
        appointment: appt._id,
        appointmentId: appt._id.toString(),
        session: session._id,
        amount: 150,
        paymentDate: date,
        paymentMethod: 'pix',
        status: 'pending',
        kind: 'session_payment',
        serviceType: 'individual_session',
        billingType: 'particular'
    });

    appt.payment = payment._id;
    await appt.save();

    return { appointment: appt, session, payment };
}

// =============================================================================
// TESTES
// =============================================================================

describe('🚨 REGRESSÃO — Zion Bug (sessão avulsa → pacote)', () => {
    it('deve converter payment avulso e limpar vínculo ao reutilizar appointment em pacote PRÉ-PAGO', async () => {
        const patient = await createPatient();
        const doctor = await createDoctor();
        const today = moment().add(2, 'days').format('YYYY-MM-DD');
        const time = '09:00';

        const { appointment, session, payment } = await createAvulsoAppointment(patient, doctor, today, time);

        const payload = {
            patientId: patient._id.toString(),
            doctorId: doctor._id.toString(),
            specialty: 'fonoaudiologia',
            sessionType: 'fonoaudiologia',
            sessionValue: 150,
            totalSessions: 1,
            totalValue: 150,
            type: 'package',
            model: 'prepaid',
            paymentMethod: 'pix',
            durationMonths: 1,
            sessionsPerWeek: 1,
            appointmentId: appointment._id.toString(),
            schedule: [
                { date: today, time }
            ],
            payments: [{ amount: 150, method: 'pix', date: today }]
        };

        const res = await request(app)
            .post('/api/v2/packages')
            .set('Authorization', `Bearer ${jwt.sign({ _id: new mongoose.Types.ObjectId().toString(), role: 'admin' }, 'zion-test-secret-123')}`)
            .send(payload)
            .expect(201);

        expect(res.body.success).toBe(true);
        const packageId = res.body.data.packageId;

        // ── 1. Payment antigo deve estar convertido ──
        const oldPayment = await Payment.findById(payment._id);
        expect(oldPayment.status).toBe('converted_to_package');
        expect(oldPayment.package.toString()).toBe(packageId);
        expect(oldPayment.convertedAt).toBeInstanceOf(Date);

        // ── 2. Appointment reutilizado deve estar limpo ──
        const reusedAppt = await Appointment.findById(appointment._id);
        expect(reusedAppt.package.toString()).toBe(packageId);
        expect(reusedAppt.payment).toBeNull();
        expect(reusedAppt.isPaid).toBe(true);
        expect(reusedAppt.paymentStatus).toBe('package_paid');
        expect(reusedAppt.paymentOrigin).toBe('package_prepaid');
        expect(reusedAppt.serviceType).toBe('package_session');
        expect(reusedAppt.billingType).toBe('particular');

        // ── 3. Session sincronizada ──
        const updatedSession = await Session.findById(session._id);
        expect(updatedSession.package.toString()).toBe(packageId);
        expect(updatedSession.isPaid).toBe(true);
        expect(updatedSession.paymentStatus).toBe('package_paid');

        // ── 4. NÃO deve existir dívida fantasma no patientBalance ──
        const PatientBalance = (await import('../../models/PatientBalance.js')).default;
        const balance = await PatientBalance.findOne({ patient: patient._id });
        if (balance) {
            const ghostDebits = balance.transactions.filter(t =>
                t.type === 'debit' &&
                !t.isPaid &&
                !t.settledByPackageId
            );
            expect(ghostDebits).toHaveLength(0);
        }
    });

    it('deve converter payment avulso e limpar vínculo ao reutilizar appointment em pacote PER-SESSION', async () => {
        const patient = await createPatient();
        const doctor = await createDoctor();
        const today = moment().add(2, 'days').format('YYYY-MM-DD');
        const time = '10:00';

        const { appointment, session, payment } = await createAvulsoAppointment(patient, doctor, today, time);

        const payload = {
            patientId: patient._id.toString(),
            doctorId: doctor._id.toString(),
            specialty: 'fonoaudiologia',
            sessionType: 'fonoaudiologia',
            sessionValue: 150,
            totalSessions: 1,
            totalValue: 150,
            type: 'package',
            model: 'per_session',
            paymentMethod: 'pix',
            durationMonths: 1,
            sessionsPerWeek: 1,
            appointmentId: appointment._id.toString(),
            schedule: [
                { date: today, time }
            ]
        };

        const res = await request(app)
            .post('/api/v2/packages')
            .set('Authorization', `Bearer ${jwt.sign({ _id: new mongoose.Types.ObjectId().toString(), role: 'admin' }, 'zion-test-secret-123')}`)
            .send(payload)
            .expect(201);

        expect(res.body.success).toBe(true);
        const packageId = res.body.data.packageId;

        // ── 1. Payment antigo convertido ──
        const oldPayment = await Payment.findById(payment._id);
        expect(oldPayment.status).toBe('converted_to_package');
        expect(oldPayment.package.toString()).toBe(packageId);

        // ── 2. Appointment reutilizado ──
        const reusedAppt = await Appointment.findById(appointment._id);
        expect(reusedAppt.package.toString()).toBe(packageId);
        expect(reusedAppt.payment).toBeNull();
        expect(reusedAppt.isPaid).toBe(false);
        expect(reusedAppt.paymentStatus).toBe('unpaid');
        expect(reusedAppt.paymentOrigin).toBe('auto_per_session');

        // ── 3. Session sincronizada (não paga ainda) ──
        const updatedSession = await Session.findById(session._id);
        expect(updatedSession.package.toString()).toBe(packageId);
        expect(updatedSession.isPaid).toBe(false);
        expect(updatedSession.paymentStatus).toBe('unpaid');
    });

    it('NÃO deve converter payment se ele estiver vinculado a outro appointment (blindagem multi-vínculo)', async () => {
        const patient = await createPatient();
        const doctor = await createDoctor();
        const today = moment().add(2, 'days').format('YYYY-MM-DD');
        const time = '11:00';

        const { appointment, session, payment } = await createAvulsoAppointment(patient, doctor, today, time);

        // Cria um SEGUNDO appointment apontando pro MESMO payment (cenário legacy corrompido)
        const secondAppt = await Appointment.create({
            patient: patient._id,
            patientName: patient.fullName,
            doctor: doctor._id,
            date: moment(today).add(1, 'day').toDate(),
            time: '12:00',
            duration: 40,
            specialty: 'fonoaudiologia',
            serviceType: 'individual_session',
            operationalStatus: 'scheduled',
            paymentStatus: 'pending',
            billingType: 'particular',
            sessionValue: 150,
            isPaid: false,
            payment: payment._id
        });

        const payload = {
            patientId: patient._id.toString(),
            doctorId: doctor._id.toString(),
            specialty: 'fonoaudiologia',
            sessionType: 'fonoaudiologia',
            sessionValue: 150,
            totalSessions: 1,
            totalValue: 150,
            type: 'package',
            model: 'prepaid',
            paymentMethod: 'pix',
            durationMonths: 1,
            sessionsPerWeek: 1,
            appointmentId: appointment._id.toString(),
            schedule: [
                { date: today, time }
            ],
            payments: [{ amount: 150, method: 'pix', date: today }]
        };

        const res = await request(app)
            .post('/api/v2/packages')
            .set('Authorization', `Bearer ${jwt.sign({ _id: new mongoose.Types.ObjectId().toString(), role: 'admin' }, 'zion-test-secret-123')}`)
            .send(payload)
            .expect(201);

        expect(res.body.success).toBe(true);

        // ── Payment NÃO deve ter sido convertido porque está vinculado a 2 appointments ──
        const oldPayment = await Payment.findById(payment._id);
        expect(oldPayment.status).toBe('pending');
        expect(oldPayment.package).toBeNull();

        // ── Mas o appointment reutilizado ainda deve estar limpo ──
        const reusedAppt = await Appointment.findById(appointment._id);
        expect(reusedAppt.payment).toBeNull();
        expect(reusedAppt.package).toBeTruthy();
    });

    it('deve reutilizar 1 appointment existente e criar os demais quando totalSessions > 1', async () => {
        const patient = await createPatient();
        const doctor = await createDoctor();
        const today = moment().add(2, 'days').format('YYYY-MM-DD');
        const time = '16:00';

        const { appointment } = await createAvulsoAppointment(patient, doctor, today, time);

        const payload = {
            patientId: patient._id.toString(),
            doctorId: doctor._id.toString(),
            specialty: 'fonoaudiologia',
            sessionType: 'fonoaudiologia',
            sessionValue: 150,
            totalSessions: 4,
            totalValue: 600,
            type: 'package',
            model: 'prepaid',
            paymentMethod: 'pix',
            durationMonths: 1,
            sessionsPerWeek: 1,
            appointmentId: appointment._id.toString(),
            schedule: [
                { date: today, time },
                { date: moment(today).add(7, 'days').format('YYYY-MM-DD'), time },
                { date: moment(today).add(14, 'days').format('YYYY-MM-DD'), time },
                { date: moment(today).add(21, 'days').format('YYYY-MM-DD'), time }
            ],
            payments: [{ amount: 600, method: 'pix', date: today }]
        };

        const res = await request(app)
            .post('/api/v2/packages')
            .set('Authorization', `Bearer ${jwt.sign({ _id: new mongoose.Types.ObjectId().toString(), role: 'admin' }, 'zion-test-secret-123')}`)
            .send(payload)
            .expect(201);

        expect(res.body.success).toBe(true);
        const packageId = res.body.data.packageId;

        // ── Deve ter exatamente 4 appointments no pacote ──
        const packageAppointments = await Appointment.find({ package: packageId });
        expect(packageAppointments).toHaveLength(4);

        // ── O appointment reutilizado deve estar entre eles ──
        const reused = packageAppointments.find(a => a._id.toString() === appointment._id.toString());
        expect(reused).toBeTruthy();
        expect(reused.serviceType).toBe('package_session');

        // ── Deve ter 4 sessions ──
        const packageSessions = await Session.find({ package: packageId });
        expect(packageSessions).toHaveLength(4);
    });
});
