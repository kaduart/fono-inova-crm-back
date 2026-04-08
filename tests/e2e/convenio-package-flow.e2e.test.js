/**
 * E2E Test - Criação de Pacote de Convênio
 * 
 * 🎯 Validação: POST /api/convenio-packages deve criar pacote com payments
 * 
 * ⚠️ REGRESSÃO: Bug onde Payment era criado com campos errados (patientId vs patient)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import express from 'express';
import request from 'supertest';

// ─── MOCKS ───────────────────────────────────────────────────────────────────
vi.mock('../../config/socket.js', () => ({
    getIo: () => ({ emit: () => {}, to: () => ({ emit: () => {} }) }),
    initializeSocket: () => {}
}));

vi.mock('../../config/redisConnection.js', () => ({
    redisConnection: { status: 'ready', on: () => {} }
}));

vi.mock('../../config/bullConfig.js', () => ({
    followupQueue: { add: async () => ({}), on: () => {} },
    followupEvents: { on: () => {} },
    videoGenerationQueue: { add: async () => ({}), on: () => {} },
    videoGenerationEvents: { on: () => {} }
}));

vi.mock('../../services/journeyFollowupEngine.js', () => ({
    runJourneyFollowups: async () => {}
}));

vi.mock('../../services/syncService.js', () => ({
    syncEvent: async () => {}
}));

vi.mock('../../domains/billing/services/PackageProjectionService.js', () => ({
    buildPackageView: async () => {}
}));

vi.mock('../../middleware/amandaAuth.js', () => ({
    flexibleAuth: (_req, _res, next) => next()
}));

// ─── SETUP ───────────────────────────────────────────────────────────────────
let mongoServer, app, server;
let Patient, Doctor, InsuranceGuide, Package, Session, Appointment, Payment;

const mockAuth = (req, _res, next) => {
    req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin' };
    next();
};

beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongoServer.getUri());

    Patient = (await import('../../models/Patient.js')).default;
    Doctor = (await import('../../models/Doctor.js')).default;
    InsuranceGuide = (await import('../../models/InsuranceGuide.js')).default;
    Package = (await import('../../models/Package.js')).default;
    Session = (await import('../../models/Session.js')).default;
    Appointment = (await import('../../models/Appointment.js')).default;
    Payment = (await import('../../models/Payment.js')).default;

    app = express();
    app.use(express.json());

    // Importa rotas
    const { default: convenioRoutes } = await import('../../routes/convenioPackages.js');
    app.use('/api/convenio-packages', mockAuth, convenioRoutes);

    server = app.listen(0);
}, 60_000);

afterAll(async () => {
    if (server) server.close();
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    const cols = mongoose.connection.collections;
    for (const key in cols) await cols[key].deleteMany({});
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function seedData() {
    const patient = await Patient.create({
        fullName: 'Paciente Convênio Teste',
        phone: '62999990001',
        dateOfBirth: new Date('2010-01-15')
    });

    const doctor = await Doctor.create({
        fullName: 'Dr. Convênio Teste',
        specialty: 'fonoaudiologia',
        phoneNumber: '62999990002',
        licenseNumber: 'CRM-GO-99999',
        email: 'dr@convenio.com'
    });

    const guide = await InsuranceGuide.create({
        number: 'GUIA-2026-001',
        insurance: 'unimed',
        patientId: patient._id,
        doctorId: doctor._id,
        specialty: 'fonoaudiologia',
        totalSessions: 10,
        usedSessions: 0,
        remaining: 10,
        status: 'active',
        expiresAt: new Date('2026-12-31')
    });

    return { patient, doctor, guide };
}

// ─── TESTES CRÍTICOS ─────────────────────────────────────────────────────────
describe('🚨 CRÍTICO: Criação de Pacote de Convênio', () => {

    it('POST /api/convenio-packages cria pacote com payments válidos', async () => {
        // Arrange
        const { patient, doctor, guide } = await seedData();

        const payload = {
            patientId: patient._id.toString(),
            doctorId: doctor._id.toString(),
            insuranceGuideId: guide._id.toString(),
            selectedSlots: [
                { date: '2026-04-08', time: '09:00' },
                { date: '2026-04-10', time: '10:00' }
            ]
        };

        // Act
        const response = await request(server)
            .post('/api/convenio-packages')
            .send(payload);

        // Assert - Resposta
        expect(response.status).toBe(201);
        expect(response.body.success).toBe(true);
        expect(response.body.package).toBeTruthy();
        expect(response.body.package.type).toBe('convenio');

        // Assert - Pacote criado
        const pkg = await Package.findById(response.body.package._id);
        expect(pkg).toBeTruthy();
        expect(pkg.patient.toString()).toBe(patient._id.toString());
        expect(pkg.type).toBe('convenio');
        expect(pkg.insuranceGuide.toString()).toBe(guide._id.toString());

        // Assert - Sessions criadas
        const sessions = await Session.find({ package: pkg._id });
        expect(sessions).toHaveLength(2);
        expect(sessions[0].patient.toString()).toBe(patient._id.toString());
        expect(sessions[0].doctor.toString()).toBe(doctor._id.toString());

        // Assert - Appointments criados
        const appointments = await Appointment.find({ package: pkg._id });
        expect(appointments).toHaveLength(2);

        // 🎯 CRÍTICO: Payments devem ter os campos corretos
        const payments = await Payment.find({ package: pkg._id });
        expect(payments).toHaveLength(2);

        for (const payment of payments) {
            // INVARIANTE: Campos obrigatórios devem estar presentes
            expect(payment.patient).toBeTruthy(); // ❌ Era o bug: patientId vs patient
            expect(payment.patient.toString()).toBe(patient._id.toString());

            expect(payment.session).toBeTruthy(); // ❌ Era o bug: sessionId vs session
            expect(payment.appointment).toBeTruthy(); // ❌ Era o bug: appointmentId vs appointment
            expect(payment.package).toBeTruthy(); // ❌ Era o bug: packageId vs package

            expect(payment.billingType).toBe('convenio');
            expect(payment.status).toBe('pending');
            expect(payment.amount).toBeGreaterThanOrEqual(0);
        }

        console.log('✅ Pacote de convênio criado com sucesso:', {
            packageId: pkg._id.toString(),
            sessions: sessions.length,
            appointments: appointments.length,
            payments: payments.length
        });
    });

    it('rejeita criação quando guia não existe', async () => {
        const { patient, doctor } = await seedData();

        const payload = {
            patientId: patient._id.toString(),
            doctorId: doctor._id.toString(),
            insuranceGuideId: new mongoose.Types.ObjectId().toString(),
            selectedSlots: [{ date: '2026-04-08', time: '09:00' }]
        };

        const response = await request(server)
            .post('/api/convenio-packages')
            .send(payload);

        expect(response.status).toBe(404);
        expect(response.body.success).toBe(false);
        expect(response.body.errorCode).toBe('GUIDE_NOT_FOUND');
    });

    it('rejeita criação quando guia já foi convertida', async () => {
        const { patient, doctor, guide } = await seedData();

        // Marca guia como já convertida
        guide.packageId = new mongoose.Types.ObjectId();
        await guide.save();

        const payload = {
            patientId: patient._id.toString(),
            doctorId: doctor._id.toString(),
            insuranceGuideId: guide._id.toString(),
            selectedSlots: [{ date: '2026-04-08', time: '09:00' }]
        };

        const response = await request(server)
            .post('/api/convenio-packages')
            .send(payload);

        expect(response.status).toBe(409);
        expect(response.body.success).toBe(false);
        expect(response.body.errorCode).toBe('GUIDE_ALREADY_CONVERTED');
    });

    it('rejeita criação quando tenta agendar mais sessões que o disponível', async () => {
        const { patient, doctor, guide } = await seedData();

        // Guia tem apenas 10 sessões
        const payload = {
            patientId: patient._id.toString(),
            doctorId: doctor._id.toString(),
            insuranceGuideId: guide._id.toString(),
            selectedSlots: Array(15).fill(null).map((_, i) => ({
                date: `2026-04-${String(i + 1).padStart(2, '0')}`,
                time: '09:00'
            }))
        };

        const response = await request(server)
            .post('/api/convenio-packages')
            .send(payload);

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.errorCode).toBe('INSUFFICIENT_SESSIONS');
    });

    it('rejeita criação quando patientId não corresponde à guia', async () => {
        const { doctor, guide } = await seedData();
        const outroPatient = await Patient.create({
            fullName: 'Outro Paciente',
            phone: '62999998888',
            dateOfBirth: new Date('2010-01-15')
        });

        const payload = {
            patientId: outroPatient._id.toString(), // Paciente diferente
            doctorId: doctor._id.toString(),
            insuranceGuideId: guide._id.toString(),
            selectedSlots: [{ date: '2026-04-08', time: '09:00' }]
        };

        const response = await request(server)
            .post('/api/convenio-packages')
            .send(payload);

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
    });

    it('campos do Payment estão corretos no banco', async () => {
        const { patient, doctor, guide } = await seedData();

        const payload = {
            patientId: patient._id.toString(),
            doctorId: doctor._id.toString(),
            insuranceGuideId: guide._id.toString(),
            selectedSlots: [{ date: '2026-04-08', time: '09:00' }]
        };

        await request(server)
            .post('/api/convenio-packages')
            .send(payload);

        const payment = await Payment.findOne({ billingType: 'convenio' });

        // Valida tipos dos campos
        expect(payment.patient).toBeInstanceOf(mongoose.Types.ObjectId);
        expect(payment.session).toBeInstanceOf(mongoose.Types.ObjectId);
        expect(payment.appointment).toBeInstanceOf(mongoose.Types.ObjectId);
        expect(payment.package).toBeInstanceOf(mongoose.Types.ObjectId);

        // Valida estrutura do insurance (se existir no schema)
        if (payment.insurance) {
            expect(payment.insurance.provider).toBe('unimed');
            expect(payment.insurance.status).toBe('pending_billing');
        }
    });
});
