/**
 * Regression Test: PATCH /v2/payments/:id deve sincronizar método de pagamento no Appointment
 *
 * 🎯 Cenário: usuário edita um pagamento de pix → dinheiro pela tela financeira.
 *   - O Payment deve ficar como dinheiro/cash
 *   - A Session vinculada deve ficar como dinheiro
 *   - O Appointment vinculado deve ter paymentMethod e paymentForms atualizados
 *
 * Issue: a alteração persistia no Payment, mas a página não refletia porque a UI
 * lê também do Appointment.paymentMethod e o PATCH não sincronizava esse campo.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
    redisConnection: { status: 'ready', on: () => {} },
    bullMqConnection: { status: 'ready', on: () => {} },
    safeRedis: {
        get: async () => null,
        set: async () => 'OK',
        del: async () => 0
    }
}));

vi.mock('../../config/bullConfig.js', () => ({
    followupQueue:         { add: async () => ({}), on: () => {} },
    followupEvents:        { on: () => {} },
    videoGenerationQueue:  { add: async () => ({}), on: () => {} },
    videoGenerationEvents: { on: () => {} }
}));

vi.mock('../../services/journeyFollowupEngine.js', () => ({
    runJourneyFollowups: async () => {}
}));

vi.mock('../../services/sicoobService.js', () => ({
    registerWebhook: async () => {}
}));

vi.mock('../../middleware/amandaAuth.js', () => ({
    flexibleAuth: (_req, _res, next) => next()
}));

vi.mock('../../middleware/auth.js', () => ({
    auth: (req, _res, next) => {
        req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin' };
        next();
    },
    authorize: () => (_req, _res, next) => next()
}));

vi.mock('../../infrastructure/events/eventPublisher.js', () => ({
    publishEvent: async () => ({ eventId: `evt-${Date.now()}`, jobs: [] }),
    EventTypes: {
        PAYMENT_UPDATED: 'PAYMENT_UPDATED',
        PAYMENT_STATUS_CHANGED: 'PAYMENT_STATUS_CHANGED'
    }
}));

// ─── SETUP ───────────────────────────────────────────────────────────────────
let mongoServer, app, server;
let Patient, Doctor, Appointment, Session, Payment;

const mockAuth = (req, _res, next) => {
    req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin' };
    next();
};

beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongoServer.getUri());

    Patient     = (await import('../../models/Patient.js')).default;
    Doctor      = (await import('../../models/Doctor.js')).default;
    Appointment = (await import('../../models/Appointment.js')).default;
    Session     = (await import('../../models/Session.js')).default;
    Payment     = (await import('../../models/Payment.js')).default;

    app = express();
    app.use(express.json());

    const { default: paymentV2Router } = await import('../../routes/payment.v2.js');
    app.use('/v2/payments', mockAuth, paymentV2Router);

    server = app.listen(0);
}, 60_000);

afterAll(async () => {
    if (server) server.close();
    await mongoose.disconnect();
    await mongoServer.stop();
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function seed() {
    const patient = await Patient.create({
        fullName: 'REGRESSION_PAYMENT_PATCH',
        dateOfBirth: new Date('2015-01-01'),
        phone: '11999999999'
    });

    const doctor = await Doctor.create({
        fullName: 'Dr. Teste',
        specialty: 'fonoaudiologia',
        email: 'dr.teste@example.com',
        licenseNumber: '12345-CRM',
        phoneNumber: '11999999999'
    });

    const appointment = await Appointment.create({
        patient: patient._id,
        doctor: doctor._id,
        date: '2026-08-04',
        time: '18:00',
        serviceType: 'individual_session',
        sessionType: 'fonoaudiologia',
        specialty: 'fonoaudiologia',
        operationalStatus: 'scheduled',
        clinicalStatus: 'completed',
        paymentMethod: 'pix',
        billingType: 'particular',
        sessionValue: 180
    });

    const session = await Session.create({
        patient: patient._id,
        doctor: doctor._id,
        appointmentId: appointment._id,
        date: new Date('2026-08-04T12:00:00.000Z'),
        time: '18:00',
        sessionType: 'fonoaudiologia',
        serviceType: 'session',
        sessionValue: 180,
        status: 'completed',
        paymentStatus: 'paid',
        isPaid: true,
        paymentMethod: 'pix',
        completedAt: new Date()
    });

    appointment.session = session._id;
    await appointment.save();

    const payment = await Payment.create({
        patient: patient._id,
        patientId: patient._id.toString(),
        doctor: doctor._id,
        appointment: appointment._id,
        appointmentId: appointment._id.toString(),
        session: session._id,
        amount: 180,
        paymentMethod: 'pix',
        status: 'paid',
        paidAt: new Date(),
        paymentDate: new Date(),
        financialDate: new Date(),
        serviceType: 'session',
        kind: 'session_payment',
        billingType: 'particular'
    });

    return { patient, doctor, appointment, session, payment };
}

// ─── TESTES ──────────────────────────────────────────────────────────────────
describe('PATCH /v2/payments/:id sincroniza método no Appointment', () => {
    it('deve refletir pix → dinheiro no Payment, Session e Appointment', async () => {
        const { appointment, session, payment } = await seed();

        const res = await request(server)
            .patch(`/v2/payments/${payment._id}`)
            .send({ amount: 180, financialDate: '2026-08-04', paymentMethod: 'dinheiro' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.paymentMethod).toBe('dinheiro');

        // Payment
        const updatedPayment = await Payment.findById(payment._id).lean();
        expect(updatedPayment.paymentMethod).toBe('dinheiro');

        // Session
        const updatedSession = await Session.findById(session._id).lean();
        expect(updatedSession.paymentMethod).toBe('dinheiro');

        // Appointment — regression target
        const updatedAppointment = await Appointment.findById(appointment._id).lean();
        expect(updatedAppointment.paymentMethod).toBe('dinheiro');
        expect(updatedAppointment.paymentForms).toHaveLength(1);
        expect(updatedAppointment.paymentForms[0].method).toBe('dinheiro');
        expect(updatedAppointment.paymentForms[0].amount).toBe(180);
    });
});
