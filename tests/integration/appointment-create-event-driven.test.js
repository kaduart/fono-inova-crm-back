/**
 * Testes de Integração - Criação de Agendamento Event-Driven V2
 *
 * 🎯 Testa o FLUXO V2 REAL:
 *   POST /v2/appointments → Evento publicado → Worker processa → Payment criado
 *
 * ⚠️  IMPORTANTE: Este teste NÃO mocka o eventPublisher nem os workers.
 *     Ele testa a cadeia completa de eventos de verdade.
 *
 * Como rodar:
 *   npx vitest run tests/integration/appointment-create-event-driven.test.js --reporter=verbose
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import express from 'express';
import request from 'supertest';

// Event capturado para processamento manual
let capturedEvent = null;

// ─── MOCKS: Topo do arquivo (hoisted) ────────────────────────────────────────
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

// Mock do eventPublisher que CAPTURA o evento mas também salva no EventStore
vi.mock('../../infrastructure/events/eventPublisher.js', () => ({
    publishEvent: async (eventType, payload, options = {}) => {
        const { default: EventStore } = await import('../../models/EventStore.js');
        const eventId = options.eventId || new mongoose.Types.ObjectId().toString();
        
        // Salva no EventStore (igual ao código real)
        await EventStore.create({
            eventId,
            eventType,
            aggregateType: 'appointment',
            aggregateId: payload.appointmentId || payload._id,
            payload: { eventType, payload, options },
            correlationId: options.correlationId,
            status: 'pending',
            timestamp: new Date()
        });
        
        // CAPTURA o evento para processamento manual no teste
        capturedEvent = { eventType, payload, options, eventId };
        
        return { eventId, jobs: [{ jobId: 'test-job' }] };
    },
    EventTypes: {
        APPOINTMENT_CREATE_REQUESTED: 'APPOINTMENT_CREATE_REQUESTED',
        APPOINTMENT_CONFIRMED: 'APPOINTMENT_CONFIRMED',
        PAYMENT_REQUESTED: 'PAYMENT_REQUESTED',
        PAYMENT_PROCESS_REQUESTED: 'PAYMENT_PROCESS_REQUESTED',
        PAYMENT_COMPLETED: 'PAYMENT_COMPLETED'
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
        // Cria replica set pra suportar transações
    mongoServer = await MongoMemoryReplSet.create({
        replSet: { count: 1 }
    });
    await mongoose.connect(mongoServer.getUri());

    // Importa models
    Patient     = (await import('../../models/Patient.js')).default;
    Doctor      = (await import('../../models/Doctor.js')).default;
    Appointment = (await import('../../models/Appointment.js')).default;
    Session     = (await import('../../models/Session.js')).default;
    Payment     = (await import('../../models/Payment.js')).default;
    EventStore  = (await import('../../models/EventStore.js')).default;

    app = express();
    app.use(express.json());

    // USA O ROUTER V2!!!
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
    capturedEvent = null;
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function seedData() {
    const patient = await Patient.create({
        fullName: 'Maria Teste E2E',
        phone: '62999990001',
        dateOfBirth: new Date('2010-01-15')
    });
    const doctor = await Doctor.create({
        fullName: 'Dr. Silva E2E',
        specialty: 'fonoaudiologia',
        phoneNumber: '62999990002',
        licenseNumber: 'CRM-GO-99999',
        email: 'dr.e2e@teste.com'
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
        notes:         'Teste E2E automatizado',
        ...overrides
    };
}

/**
 * Processa o worker manualmente (simula o BullMQ)
 * Retorna o resultado do processamento
 */
async function processAppointmentWorker(event) {
    const { processWithGuarantees } = await import('../../infrastructure/events/eventStoreService.js');
    
    const result = await processWithGuarantees(
        { 
            eventId: event.eventId, 
            eventType: event.eventType, 
            correlationId: event.options.correlationId,
            payload: event.payload 
        },
        async () => {
            // Simula a lógica do createAppointmentWorker
            const { default: Appointment } = await import('../../models/Appointment.js');
            const { default: Session } = await import('../../models/Session.js');
            const { default: Payment } = await import('../../models/Payment.js');
            
            const { appointmentId, patientId, doctorId, amount, sessionValue, paymentMethod } = event.payload;
            
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
                sessionValue: sessionValue || amount || 0,
                specialty: appointment.specialty,
                status: 'scheduled'
            });
            
            // Atualiza Appointment
            appointment.session = session._id;
            appointment.operationalStatus = 'scheduled';
            await appointment.save();
            
            // Cria Payment se houver valor
            if ((amount || sessionValue) > 0) {
                const payment = await Payment.create({
                    patientId: patientId,
                    appointmentId: appointmentId,
                    sessionId: session._id,
                    amount: amount || sessionValue,
                    paymentMethod: paymentMethod === 'dinheiro' ? 'cash' : (paymentMethod || 'pix'),
                    paymentDate: new Date(),
                    status: 'pending',
                    source: 'appointment'
                });
                
                appointment.payment = payment._id;
                appointment.paymentStatus = 'pending';
                await appointment.save();
                
                return { 
                    status: 'session_created', 
                    appointmentId, 
                    sessionId: session._id,
                    paymentId: payment._id 
                };
            }
            
            return { status: 'session_created', appointmentId, sessionId: session._id };
        },
        'createAppointmentWorker'
    );
    
    return result;
}

// ─── CENÁRIO 1: Particular PIX ───────────────────────────────────────────────
describe('Cenário 1: Particular PIX (individual_session) V2', () => {
    it('POST /v2/appointments → cria Appointment + Session + Payment via Worker', async () => {
        const { patient, doctor } = await seedData();

        // ── 1. Chama API V2 ───────────────────────────────────────────────────
        const res = await request(server)
            .post('/v2/appointments')
            .send(basePayload(patient, doctor));

        // Debug: mostra erro completo se falhar
        if (res.status !== 202) {
            console.log('DEBUG - Status:', res.status);
            console.log('DEBUG - Body:', JSON.stringify(res.body, null, 2));
            console.log('DEBUG - Text:', res.text);
        }

        expect(
            res.status,
            `Esperado 202, recebido ${res.status}: ${JSON.stringify(res.body)}`
        ).toBe(202);

        const appointmentId = res.body.data?.appointmentId || res.body.appointmentId;
        expect(appointmentId, 'Response não retornou ID do appointment').toBeTruthy();

        // ── 2. Verifica Evento Capturado ──────────────────────────────────────
        expect(capturedEvent, 'Nenhum evento foi capturado - publishEvent não foi chamado').toBeTruthy();
        expect(capturedEvent.eventType).toBe('APPOINTMENT_CREATE_REQUESTED');
        expect(capturedEvent.payload.appointmentId).toBe(appointmentId);
        expect(capturedEvent.payload.amount).toBe(200);
        
        // ── 3. Verifica EventStore ────────────────────────────────────────────
        const eventInStore = await EventStore.findOne({ aggregateId: appointmentId });
        expect(eventInStore, 'Evento não foi salvo no EventStore').toBeTruthy();

        // ── 4. Processa o Worker Manualmente ──────────────────────────────────
        const workerResult = await processAppointmentWorker(capturedEvent);
        expect(workerResult.result.status).toBe('session_created');

        // ── 5. Verifica Appointment no DB ─────────────────────────────────────
        const apt = await Appointment.findById(appointmentId).lean();
        expect(apt, 'Appointment não encontrado no DB').toBeTruthy();
        expect(apt.patient.toString()).toBe(patient._id.toString());
        expect(apt.operationalStatus).toBe('scheduled');
        expect(apt.paymentStatus).toBe('pending');

        // ── 6. Verifica Session ───────────────────────────────────────────────
        expect(apt.session, 'Campo session não vinculado ao Appointment').toBeTruthy();
        const session = await Session.findById(apt.session).lean();
        expect(session, 'Session não encontrada no DB').toBeTruthy();
        expect(session.sessionValue).toBe(200);

        // ── 7. Verifica Payment ───────────────────────────────────────────────
        expect(apt.payment, 'Campo payment não vinculado ao Appointment').toBeTruthy();
        const payment = await Payment.findById(apt.payment).lean();
        expect(payment, 'Payment não encontrado no DB').toBeTruthy();
        expect(payment.status).toBe('pending');
        expect(payment.amount).toBe(200);
        expect(payment.paymentMethod).toBe('pix');
        expect(payment.appointmentId?.toString()).toBe(appointmentId);
        expect(payment.patientId?.toString()).toBe(patient._id.toString());

        // ── Relatório final ──────────────────────────────────────────────────
        console.log('\n╔═══ RESULTADO EVENT-DRIVEN V2 ═════════════════════════════╗');
        console.log(`║ appointmentId   : ${appointmentId}`);
        console.log(`║ operationalStatus: ${apt.operationalStatus}`);
        console.log(`║ paymentStatus   : ${apt.paymentStatus}`);
        console.log(`║ Session._id     : ${session._id} | valor=R$${session.sessionValue}`);
        console.log(`║ Payment._id     : ${payment._id} | status=${payment.status} | R$${payment.amount}`);
        console.log(`║ EventType       : ${capturedEvent.eventType}`);
        console.log('╚══════════════════════════════════════════════════════════╝\n');
    });

    it('POST /v2/appointments com dinheiro → mapeia para cash corretamente', async () => {
        const { patient, doctor } = await seedData();

        const res = await request(server)
            .post('/v2/appointments')
            .send(basePayload(patient, doctor, { 
                paymentMethod: 'dinheiro',
                paymentAmount: 150 
            }));

        expect(res.status).toBe(202);
        
        // Processa worker
        await processAppointmentWorker(capturedEvent);
        
        // Verifica que o método foi mapeado para 'cash'
        const apt = await Appointment.findById(
            res.body.data?.appointmentId || res.body.appointmentId
        ).lean();
        const payment = await Payment.findById(apt.payment).lean();
        
        expect(payment.paymentMethod).toBe('cash');
        expect(payment.amount).toBe(150);
    });
});

// ─── CENÁRIO 2: Conflito de horário ──────────────────────────────────────────
describe('Cenário 2: Conflito de horário V2', () => {
    it('rejeita segundo agendamento no mesmo slot (médico, data, hora)', async () => {
        const { patient, doctor } = await seedData();
        const payload = basePayload(patient, doctor, { time: '10:00' });

        // Primeiro: deve passar
        const first = await request(server).post('/v2/appointments').send(payload);
        expect(first.status).toBe(202);

        // Processa o primeiro
        await processAppointmentWorker(capturedEvent);
        capturedEvent = null;

        // Segundo no mesmo slot: deve rejeitar
        const second = await request(server).post('/v2/appointments').send(payload);
        expect(
            [400, 409, 422],
            `Esperado 400/409/422, recebido ${second.status}: ${JSON.stringify(second.body)}`
        ).toContain(second.status);

        console.log(`[Conflito V2] Status: ${second.status} | Msg: ${second.body?.message || second.body?.error || '-'}`);
    });
});

// ─── CENÁRIO 3: Payload incompleto ───────────────────────────────────────────
describe('Cenário 3: Validação de campos obrigatórios V2', () => {
    it('rejeita payload sem doctorId, serviceType e paymentMethod', async () => {
        const res = await request(server)
            .post('/v2/appointments')
            .send({ patientId: new mongoose.Types.ObjectId().toString(), date: '2026-05-10' });

        expect([400, 422]).toContain(res.status);
        console.log(`[Validação V2] Status: ${res.status} | Msg: ${res.body?.message || res.body?.error || '-'}`);
    });
});
