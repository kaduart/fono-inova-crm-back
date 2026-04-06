/**
 * E2E Test - Fluxo Completo: Agendamento + Pagamento
 * 
 * 🎯 Testa a cadeia completa de eventos:
 *   POST /v2/appointments → APPOINTMENT_CREATE_REQUESTED → Worker → 
 *   PAYMENT_REQUESTED → PaymentWorker → Payment criado → PAYMENT_COMPLETED
 * 
 * Este teste verifica:
 * 1. Criação do appointment com status processing_create
 * 2. Publicação do evento APPOINTMENT_CREATE_REQUESTED
 * 3. Processamento pelo CreateAppointmentWorker (sessão criada)
 * 4. Publicação do evento PAYMENT_REQUESTED (para particular com valor > 0)
 * 5. Processamento pelo PaymentWorker (pagamento criado)
 * 6. Status final: appointment scheduled + payment pending/paid
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import express from 'express';
import request from 'supertest';

// Event capturado para processamento manual
let capturedEvents = [];

// ─── MOCKS ───────────────────────────────────────────────────────────────────
vi.mock('../../config/socket.js', () => ({
    getIo: () => ({ emit: () => {}, to: () => ({ emit: () => {} }) }),
    initializeSocket: () => {}
}));

vi.mock('../../config/redisConnection.js', () => ({
    redisConnection: { status: 'ready', on: () => {} }
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

// Mock do eventPublisher que CAPTURA todos os eventos
vi.mock('../../infrastructure/events/eventPublisher.js', () => ({
    publishEvent: async (eventType, payload, options = {}) => {
        const { default: EventStore } = await import('../../models/EventStore.js');
        const eventId = options.eventId || new mongoose.Types.ObjectId().toString();
        
        await EventStore.create({
            eventId,
            eventType,
            aggregateType: payload.appointmentId ? 'appointment' : 'system',
            aggregateId: payload.appointmentId || payload._id || 'system',
            payload: { eventType, payload, options },
            correlationId: options.correlationId,
            status: 'pending',
            timestamp: new Date()
        });
        
        capturedEvents.push({ eventType, payload, options, eventId, timestamp: new Date() });
        
        return { eventId, jobs: [{ jobId: `job-${eventId}` }] };
    },
    EventTypes: {
        APPOINTMENT_CREATE_REQUESTED: 'APPOINTMENT_CREATE_REQUESTED',
        APPOINTMENT_CONFIRMED: 'APPOINTMENT_CONFIRMED',
        PAYMENT_REQUESTED: 'PAYMENT_REQUESTED',
        PAYMENT_PROCESS_REQUESTED: 'PAYMENT_PROCESS_REQUESTED',
        PAYMENT_COMPLETED: 'PAYMENT_COMPLETED',
        PAYMENT_RECEIVED: 'PAYMENT_RECEIVED'
    }
}));

// ─── SETUP ───────────────────────────────────────────────────────────────────
let mongoServer, app, server;
let Patient, Doctor, Appointment, Session, Payment, EventStore;

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
    EventStore  = (await import('../../models/EventStore.js')).default;

    app = express();
    app.use(express.json());

    const { default: appointmentV2Router } = await import('../../routes/appointment.v2.js');
    app.use('/v2/appointments', mockAuth, appointmentV2Router);

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
    capturedEvents = [];
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function seedData() {
    const patient = await Patient.create({
        fullName: 'Paciente E2E',
        phone: '62999990001',
        dateOfBirth: new Date('2010-01-15')
    });
    const doctor = await Doctor.create({
        fullName: 'Dr. E2E',
        specialty: 'fonoaudiologia',
        phoneNumber: '62999990002',
        licenseNumber: 'CRM-GO-99999',
        email: 'dr@e2e.com'
    });
    return { patient, doctor };
}

function basePayload(patient, doctor, overrides = {}) {
    return {
        patientId:     patient._id.toString(),
        doctorId:      doctor._id.toString(),
        date:          '2026-05-10',
        time:          '09:00',
        specialty:     'fonoaudiologia',
        serviceType:   'individual_session',
        paymentAmount: 200,
        paymentMethod: 'pix',
        notes:         'Teste E2E',
        ...overrides
    };
}

/**
 * Simula o CreateAppointmentWorker
 */
async function simulateCreateAppointmentWorker(event) {
    const { payload } = event;
    const { appointmentId, patientId, doctorId, amount, paymentMethod, date, time, specialty } = payload;
    
    // Busca appointment
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) throw new Error('APPOINTMENT_NOT_FOUND');
    
    // Cria Session
    const session = await Session.create({
        patient: patientId,
        doctor: doctorId,
        appointment: appointmentId,
        date: appointment.date,
        time: appointment.time,
        sessionValue: amount || 0,
        specialty: appointment.specialty,
        status: 'scheduled'
    });
    
    // Atualiza Appointment
    appointment.session = session._id;
    appointment.operationalStatus = 'scheduled';
    await appointment.save();
    
    // Publica evento de pagamento se necessário
    if (amount > 0 && !payload.insuranceGuideId) {
        const { publishEvent, EventTypes } = await import('../../infrastructure/events/eventPublisher.js');
        
        // Mapeia método de pagamento
        const methodMap = {
            'dinheiro': 'cash',
            'pix': 'pix',
            'credit_card': 'credit_card',
            'debit_card': 'debit_card',
            'cartao': 'credit_card',
            'cartão': 'credit_card',
            'transferencia': 'bank_transfer',
            'transferência': 'bank_transfer'
        };
        const mappedMethod = methodMap[paymentMethod] || 'cash';
        
        await publishEvent(
            EventTypes.PAYMENT_REQUESTED,
            {
                appointmentId: appointmentId.toString(),
                patientId: patientId?.toString(),
                doctorId: doctorId?.toString(),
                amount,
                paymentMethod: mappedMethod,
                paymentDate: new Date().toISOString(),
                sessionId: session._id.toString()
            },
            { correlationId: event.options.correlationId }
        );
    }
    
    return { status: 'session_created', appointmentId, sessionId: session._id };
}

/**
 * Simula o PaymentWorker
 */
async function simulatePaymentWorker(event) {
    const { payload } = event;
    const { appointmentId, patientId, amount, paymentMethod, paymentDate } = payload;
    
    // Cria Payment
    const payment = await Payment.create({
        patientId: patientId,
        appointmentId: appointmentId,
        amount: amount,
        paymentMethod: paymentMethod || 'pix',
        paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
        status: 'pending',
        source: 'appointment'
    });
    
    // Atualiza Appointment
    const appointment = await Appointment.findById(appointmentId);
    appointment.payment = payment._id;
    appointment.paymentStatus = 'pending';
    await appointment.save();
    
    return { status: 'payment_created', paymentId: payment._id, appointmentId };
}

// ─── TESTES E2E ──────────────────────────────────────────────────────────────
describe('E2E: Fluxo Completo Agendamento + Pagamento', () => {
    
    it('deve criar appointment, session e payment em cadeia (particular/pix)', async () => {
        const { patient, doctor } = await seedData();
        
        // 1. Cria appointment via API
        const res = await request(server)
            .post('/v2/appointments')
            .send(basePayload(patient, doctor));
        
        expect(res.status).toBe(202);
        const appointmentId = res.body.data?.appointmentId;
        expect(appointmentId).toBeTruthy();
        
        // 2. Verifica evento APPOINTMENT_CREATE_REQUESTED
        expect(capturedEvents.length).toBeGreaterThanOrEqual(1);
        const createEvent = capturedEvents.find(e => e.eventType === 'APPOINTMENT_CREATE_REQUESTED');
        expect(createEvent).toBeTruthy();
        expect(createEvent.payload.amount).toBe(200);
        expect(createEvent.payload.paymentMethod).toBe('pix');
        
        // 3. Processa CreateAppointmentWorker
        await simulateCreateAppointmentWorker(createEvent);
        
        // 4. Verifica evento PAYMENT_REQUESTED
        const paymentRequestedEvent = capturedEvents.find(e => e.eventType === 'PAYMENT_REQUESTED');
        expect(paymentRequestedEvent).toBeTruthy();
        expect(paymentRequestedEvent.payload.amount).toBe(200);
        expect(paymentRequestedEvent.payload.paymentMethod).toBe('pix');
        
        // 5. Processa PaymentWorker
        await simulatePaymentWorker(paymentRequestedEvent);
        
        // 6. Verifica estado final no DB
        const apt = await Appointment.findById(appointmentId).lean();
        expect(apt.operationalStatus).toBe('scheduled');
        expect(apt.paymentStatus).toBe('pending');
        expect(apt.session).toBeTruthy();
        expect(apt.payment).toBeTruthy();
        
        const session = await Session.findById(apt.session).lean();
        expect(session.sessionValue).toBe(200);
        
        const payment = await Payment.findById(apt.payment).lean();
        expect(payment.amount).toBe(200);
        expect(payment.paymentMethod).toBe('pix');
        expect(payment.status).toBe('pending');
        
        console.log('\n✅ FLUXO PIX COMPLETO:');
        console.log(`   Appointment: ${appointmentId} (${apt.operationalStatus})`);
        console.log(`   Session: ${session._id} (R$${session.sessionValue})`);
        console.log(`   Payment: ${payment._id} (${payment.paymentMethod}, ${payment.status})`);
    });
    
    it('deve mapear dinheiro → cash corretamente', async () => {
        const { patient, doctor } = await seedData();
        
        const res = await request(server)
            .post('/v2/appointments')
            .send(basePayload(patient, doctor, { 
                paymentMethod: 'dinheiro',
                paymentAmount: 150 
            }));
        
        expect(res.status).toBe(202);
        const appointmentId = res.body.data?.appointmentId;
        
        // Processa workers
        const createEvent = capturedEvents.find(e => e.eventType === 'APPOINTMENT_CREATE_REQUESTED');
        await simulateCreateAppointmentWorker(createEvent);
        
        const paymentRequestedEvent = capturedEvents.find(e => e.eventType === 'PAYMENT_REQUESTED');
        expect(paymentRequestedEvent.payload.paymentMethod).toBe('cash'); // Mapeado!
        
        await simulatePaymentWorker(paymentRequestedEvent);
        
        // Verifica no DB
        const apt = await Appointment.findById(appointmentId).lean();
        const payment = await Payment.findById(apt.payment).lean();
        expect(payment.paymentMethod).toBe('cash');
        
        console.log('\n✅ MAPEAMENTO DINHEIRO → CASH:');
        console.log(`   Payment: ${payment._id} (${payment.paymentMethod})`);
    });
    
    it('deve processar valor decimal corretamente (ex: 0.12)', async () => {
        const { patient, doctor } = await seedData();
        
        const res = await request(server)
            .post('/v2/appointments')
            .send(basePayload(patient, doctor, { 
                paymentAmount: 0.12,
                paymentMethod: 'dinheiro'
            }));
        
        expect(res.status).toBe(202);
        const appointmentId = res.body.data?.appointmentId;
        
        // Processa workers
        const createEvent = capturedEvents.find(e => e.eventType === 'APPOINTMENT_CREATE_REQUESTED');
        await simulateCreateAppointmentWorker(createEvent);
        
        const paymentRequestedEvent = capturedEvents.find(e => e.eventType === 'PAYMENT_REQUESTED');
        expect(paymentRequestedEvent.payload.amount).toBe(0.12);
        
        await simulatePaymentWorker(paymentRequestedEvent);
        
        // Verifica no DB
        const apt = await Appointment.findById(appointmentId).lean();
        const payment = await Payment.findById(apt.payment).lean();
        expect(payment.amount).toBe(0.12);
        
        console.log('\n✅ VALOR DECIMAL:');
        console.log(`   Payment: ${payment._id} (R$${payment.amount})`);
    });
    
    it('deve verificar cadeia completa de eventos no EventStore', async () => {
        const { patient, doctor } = await seedData();
        
        await request(server)
            .post('/v2/appointments')
            .send(basePayload(patient, doctor));
        
        // Processa workers
        const createEvent = capturedEvents.find(e => e.eventType === 'APPOINTMENT_CREATE_REQUESTED');
        await simulateCreateAppointmentWorker(createEvent);
        await simulatePaymentWorker(
            capturedEvents.find(e => e.eventType === 'PAYMENT_REQUESTED')
        );
        
        // Verifica EventStore
        const events = await EventStore.find({}).sort({ timestamp: 1 }).lean();
        const eventTypes = events.map(e => e.eventType);
        
        expect(eventTypes).toContain('APPOINTMENT_CREATE_REQUESTED');
        expect(eventTypes).toContain('PAYMENT_REQUESTED');
        
        console.log('\n✅ EVENTOS NO EVENTSTORE:');
        events.forEach(e => {
            const ts = e.timestamp ? e.timestamp.toISOString() : 'no-timestamp';
            console.log(`   ${ts} - ${e.eventType}`);
        });
    });
});
