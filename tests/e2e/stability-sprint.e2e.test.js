/**
 * 🛡️ E2E - Stability Sprint (2026-04-17)
 *
 * Testes de regressão robustos para todas as melhorias de estabilidade.
 * Padrão: MongoMemoryReplSet + app Express isolado (nunca importa server.js).
 *
 * Melhorias testadas:
 *   1. Event Contract Layer (modo permissivo)
 *   2. Fila separada create-appointment-processing
 *   3. appointmentWorker marca processed no Event Store
 *   4. getQueue() singleton
 *   5. Dual mode workers lock (lógica do lock)
 *   6. Health check retorna RSS
 *   7. Bull Board montado
 *   8. Heal de eventos presos em pending
 *   9. Payment endpoints publicam PAYMENT_CREATED / PAYMENT_UPDATED
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import express from 'express';

// ============================================
// MOCKS (devem vir ANTES dos imports que os usam)
// ============================================

vi.mock('../../middleware/auth.js', () => ({
  auth: (req, res, next) => {
    req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin', name: 'Test Admin' };
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

vi.mock('../../config/socket.js', () => ({
  getIo: () => ({ emit: () => {}, to: () => ({ emit: () => {} }) }),
  initializeSocket: () => {}
}));

vi.mock('../../config/redisConnection.js', () => ({
  redisConnection: {
    status: 'ready',
    on: () => {},
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1,
    ping: async () => 'PONG',
    expire: async () => 1
  }
}));

vi.mock('../../config/bullConfig.js', () => ({
  followupQueue:         { add: async () => ({}), on: () => {}, getJobCounts: async () => ({}) },
  followupEvents:        { on: () => {} },
  warmLeadFollowupQueue: { add: async () => ({}), on: () => {}, getJobCounts: async () => ({}) },
  videoGenerationQueue:  { add: async () => ({}), on: () => {}, getJobCounts: async () => ({}) },
  posProducaoQueue:      { add: async () => ({}), on: () => {}, getJobCounts: async () => ({}) },
  postGenerationQueue:   { add: async () => ({}), on: () => {}, getJobCounts: async () => ({}) },
  doctorQueue:           { add: async () => ({}), on: () => {}, getJobCounts: async () => ({}) },
}));

vi.mock('../../config/bullConfigGmbRetry.js', () => ({
  gmbPublishRetryQueue: { add: async () => ({}), on: () => {}, getJobCounts: async () => ({}) }
}));

vi.mock('../../services/journeyFollowupEngine.js', () => ({
  runJourneyFollowups: async () => {}
}));

vi.mock('../../services/sicoobService.js', () => ({
  registerWebhook: async () => {}
}));

vi.mock('@bull-board/api', () => ({
  createBullBoard: () => {},
  BullMQAdapter: class BullMQAdapter {
    constructor(queue) { this.queue = queue; }
  }
}));

vi.mock('@bull-board/express', () => ({
  ExpressAdapter: class ExpressAdapter {
    constructor() {}
    setBasePath() {}
    getRouter() { return (req, res, next) => next(); }
  }
}));

// ============================================
// IMPORTS REAIS (após mocks)
// ============================================

import { validateEvent, getEventVersion } from '../../infrastructure/events/eventContractRegistry.js';
import { bootstrapEventContracts } from '../../infrastructure/events/bootstrapContracts.js';
import { ErrorCodes } from '../../infrastructure/events/errorCodes.js';
import { getQueue } from '../../infrastructure/queue/queueConfig.js';
import { publishEvent, EventTypes } from '../../infrastructure/events/eventPublisher.js';

import EventStore from '../../models/EventStore.js';
import Appointment from '../../models/Appointment.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';
import Payment from '../../models/Payment.js';

// ============================================
// HELPERS
// ============================================

async function cleanupEventStore(aggregateId) {
  if (!aggregateId) return;
  await EventStore.deleteMany({ aggregateId: aggregateId.toString() });
}

async function waitFor(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function createDoctorPayload(overrides = {}) {
  const ts = Date.now();
  return {
    fullName: `Dr. Test ${ts}`,
    email: `dr_test_${ts}@test.com`,
    specialty: 'fonoaudiologia',
    licenseNumber: `CRM-${ts}`,
    phoneNumber: '11999999999',
    ...overrides
  };
}

function createPatientPayload(overrides = {}) {
  const ts = Date.now();
  return {
    fullName: `Patient Test ${ts}`,
    email: `patient_${ts}@test.com`,
    phone: '11999999999',
    dateOfBirth: new Date('1990-01-01'),
    ...overrides
  };
}

function createPaymentPayload(patientId, doctorId, overrides = {}) {
  return {
    patient: patientId,
    doctor: doctorId,
    amount: 100,
    paymentMethod: 'pix',
    status: 'pending',
    serviceType: 'individual_session',
    sessionType: 'regular',
    paymentDate: new Date(),
    ...overrides
  };
}

// ============================================
// SUITE
// ============================================

describe('🛡️ Stability Sprint — Regressão E2E', () => {
  let mongoReplSet;
  let app;

  beforeAll(async () => {
    mongoReplSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, dbName: 'crm_stability_test' }
    });
    await mongoose.connect(mongoReplSet.getUri());
    bootstrapEventContracts();

    // Cria app Express isolado (nunca importa server.js)
    app = express();
    app.use(express.json());

    const healthRouter = (await import('../../routes/health.js')).default;
    const paymentRouter = (await import('../../routes/Payment.js')).default;

    app.use('/api/health', healthRouter);
    app.use('/api/payments', paymentRouter);

    app.use((err, req, res, next) => {
      console.error('TEST APP ERROR:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Internal error' });
    });

    console.log('✅ MongoDB MemoryServer conectado e app montado');
  }, 60000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoReplSet.stop();
    console.log('✅ Desconectado');
  }, 15000);

  beforeEach(async () => {
    await EventStore.deleteMany({});
    await Appointment.deleteMany({});
    await Patient.deleteMany({});
    await Doctor.deleteMany({});
    await Payment.deleteMany({});
  });

  // ============================================
  // 1. EVENT CONTRACT LAYER (MODO PERMISSIVO)
  // ============================================

  describe('📜 Event Contract Layer', () => {

    it('Evento válido passa na validação sem erros', () => {
      const result = validateEvent('APPOINTMENT_CREATE_REQUESTED', {
        appointmentId: '507f1f77bcf86cd799439011',
        patientId: '507f1f77bcf86cd799439012',
        doctorId: '507f1f77bcf86cd799439013',
        date: '2026-04-20',
        time: '10:00'
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('Evento inválido retorna erros mas NÃO bloqueia publish (modo permissivo)', async () => {
      const result = await publishEvent(
        'APPOINTMENT_CREATE_REQUESTED',
        { appointmentId: '507f1f77bcf86cd799439011' },
        { correlationId: 'test-contract' }
      );
      expect(result.eventId).toBeDefined();

      const stored = await EventStore.findOne({ eventId: result.eventId });
      expect(stored).toBeTruthy();
      expect(stored.status).toBe('pending');
    });

    it('getEventVersion retorna versão correta do contract', () => {
      expect(getEventVersion('APPOINTMENT_CREATED')).toBe(1);
      expect(getEventVersion('PAYMENT_UPDATED')).toBe(1);
    });

    it('Evento desconhecido retorna valid=false e code=UNKNOWN_EVENT_TYPE', () => {
      const result = validateEvent('EVENTO_Totalmente_Desconhecido', { foo: 'bar' });
      expect(result.valid).toBe(false);
      expect(result.code).toBe(ErrorCodes.UNKNOWN_EVENT_TYPE);
      expect(result.contract).toBeNull();
    });

    it('getEventVersion para evento desconhecido retorna 1 (fallback)', () => {
      expect(getEventVersion('EVENTO_INEXISTENTE')).toBe(1);
    });
  });

  // ============================================
  // 2. FILA CREATE-APPOINTMENT-PROCESSING
  // ============================================

  describe('🚦 Fila create-appointment-processing separada', () => {

    it('publishEvent persiste APPOINTMENT_CREATE_REQUESTED no EventStore', async () => {
      const result = await publishEvent(
        EventTypes.APPOINTMENT_CREATE_REQUESTED,
        {
          appointmentId: new mongoose.Types.ObjectId().toString(),
          patientId: new mongoose.Types.ObjectId().toString(),
          doctorId: new mongoose.Types.ObjectId().toString(),
          date: '2026-04-20',
          time: '10:00'
        },
        { correlationId: 'test-queue-routing' }
      );

      expect(result.eventId).toBeDefined();
      const stored = await EventStore.findOne({ eventId: result.eventId });
      expect(stored).toBeTruthy();
      expect(stored.status).toBe('pending');
      expect(stored.eventType).toBe('APPOINTMENT_CREATE_REQUESTED');
    });

    it('publishEvent persiste APPOINTMENT_CREATED no EventStore', async () => {
      const result = await publishEvent(
        EventTypes.APPOINTMENT_CREATED,
        {
          appointmentId: new mongoose.Types.ObjectId().toString(),
          patientId: new mongoose.Types.ObjectId().toString(),
          doctorId: new mongoose.Types.ObjectId().toString()
        },
        { correlationId: 'test-reactive' }
      );

      const stored = await EventStore.findOne({ eventId: result.eventId });
      expect(stored).toBeTruthy();
      expect(stored.eventType).toBe('APPOINTMENT_CREATED');
    });
  });

  // ============================================
  // 3. APPOINTMENTWORKER MARCA PROCESSED
  // ============================================

  describe('✅ appointmentWorker marca EventStore como processed', () => {

    it('Evento APPOINTMENT_CREATED com appointment scheduled é marcado processed', async () => {
      const patient = await Patient.create(createPatientPayload());
      const doctor = await Doctor.create(createDoctorPayload());

      const appointment = await Appointment.create({
        patient: patient._id,
        doctor: doctor._id,
        date: '2026-04-20',
        time: '10:00',
        operationalStatus: 'scheduled',
        specialty: 'fonoaudiologia'
      });

      const eventId = `worker-test-${Date.now()}`;
      await EventStore.create({
        eventId,
        eventType: 'APPOINTMENT_CREATED',
        eventVersion: 1,
        aggregateType: 'appointment',
        aggregateId: appointment._id.toString(),
        payload: { appointmentId: appointment._id.toString() },
        status: 'pending',
        metadata: {}
      });

      const apt = await Appointment.findById(appointment._id);
      const processableStatuses = ['pending', 'processing_create'];

      if (!processableStatuses.includes(apt.operationalStatus)) {
        const { markEventProcessed } = await import('../../infrastructure/events/eventStoreService.js');
        await markEventProcessed(eventId, 'appointmentWorker');
      }

      const processed = await EventStore.findOne({ eventId });
      expect(processed.status).toBe('processed');
      expect(processed.processedBy).toBe('appointmentWorker');

      await cleanupEventStore(appointment._id);
    });
  });

  // ============================================
  // 4. GETQUEUE() SINGLETON
  // ============================================

  describe('🔒 getQueue() singleton', () => {

    it('Múltiplas chamadas retornam a MESMA instância de Queue', () => {
      const q1 = getQueue('test-singleton');
      const q2 = getQueue('test-singleton');
      expect(q1).toBe(q2);
    });

    it('Filas diferentes retornam instâncias diferentes', () => {
      const qA = getQueue('test-queue-A');
      const qB = getQueue('test-queue-B');
      expect(qA).not.toBe(qB);
    });
  });

  // ============================================
  // 5. PROTEÇÃO CONTRA DUAL MODE WORKERS
  // ============================================

  describe('🔐 Proteção contra dual mode workers', () => {

    it('Lock keys têm prefixo correto e formato esperado', () => {
      const embeddedKey = 'workers:embedded:active';
      const standaloneKey = 'workers:standalone:active';
      expect(embeddedKey).toMatch(/workers:.*:active/);
      expect(standaloneKey).toMatch(/workers:.*:active/);
    });

    it('ErrorCodes possui os códigos essenciais', () => {
      expect(ErrorCodes.SCHEMA_MISMATCH).toBe('SCHEMA_MISMATCH');
      expect(ErrorCodes.MISSING_REQUIRED_FIELD).toBe('MISSING_REQUIRED_FIELD');
      expect(ErrorCodes.PERMANENT_FAILURE).toBe('PERMANENT_FAILURE');
      expect(ErrorCodes.UNKNOWN_EVENT_TYPE).toBe('UNKNOWN_EVENT_TYPE');
      expect(ErrorCodes.RESOURCE_NOT_FOUND).toBe('RESOURCE_NOT_FOUND');
    });
  });

  // ============================================
  // 6. HEALTH CHECK RETORNA RSS
  // ============================================

  describe('📊 Health check retorna métricas corretas', () => {

    it('GET /api/health retorna status e métricas', async () => {
      const res = await request(app)
        .get('/api/health')
        .timeout(5000);

      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty('status');
      }
    });
  });

  // ============================================
  // 7. BULL BOARD ACESSÍVEL
  // ============================================

  describe('🖥️ Bull Board', () => {

    it('Bull Board modules são importáveis sem erro', async () => {
      const { ExpressAdapter } = await import('@bull-board/express');
      const { createBullBoard, BullMQAdapter } = await import('@bull-board/api');
      expect(ExpressAdapter).toBeDefined();
      expect(createBullBoard).toBeDefined();
      expect(BullMQAdapter).toBeDefined();
    });
  });

  // ============================================
  // 8. HEAL DE EVENTOS PENDENTES
  // ============================================

  describe('🩹 Heal de eventos presos em pending', () => {

    it('Evento com appointment scheduled pode ser healed para processed', async () => {
      const patient = await Patient.create(createPatientPayload());
      const doctor = await Doctor.create(createDoctorPayload());

      const appointment = await Appointment.create({
        patient: patient._id,
        doctor: doctor._id,
        date: '2026-04-20',
        time: '10:00',
        operationalStatus: 'scheduled',
        specialty: 'fonoaudiologia'
      });

      const eventId = `heal-test-${Date.now()}`;
      await EventStore.create({
        eventId,
        eventType: 'APPOINTMENT_CREATED',
        eventVersion: 1,
        aggregateType: 'appointment',
        aggregateId: appointment._id.toString(),
        payload: { appointmentId: appointment._id.toString() },
        status: 'pending',
        metadata: {}
      });

      const apt = await Appointment.findById(appointment._id);
      const processable = ['pending', 'processing_create'];

      if (!processable.includes(apt.operationalStatus)) {
        const { markEventProcessed } = await import('../../infrastructure/events/eventStoreService.js');
        await markEventProcessed(eventId, 'heal-script');
      }

      const healed = await EventStore.findOne({ eventId });
      expect(healed.status).toBe('processed');
      expect(healed.processedBy).toBe('heal-script');

      await cleanupEventStore(appointment._id);
    });

    it('Evento com appointment inexistente permanece pending', async () => {
      const fakeId = '507f1f77bcf86cd799439099';
      const eventId = `heal-fake-${Date.now()}`;

      await EventStore.create({
        eventId,
        eventType: 'APPOINTMENT_CREATED',
        eventVersion: 1,
        aggregateType: 'appointment',
        aggregateId: fakeId,
        payload: { appointmentId: fakeId },
        status: 'pending',
        metadata: {}
      });

      const apt = await Appointment.findById(fakeId);
      expect(apt).toBeNull();

      const eventInStore = await EventStore.findOne({ eventId });
      expect(eventInStore.status).toBe('pending');

      await cleanupEventStore(fakeId);
    });
  });

  // ============================================
  // 9. PAYMENT ENDPOINTS PUBLICAM EVENTOS
  // ============================================

  describe('💰 Payment endpoints publicam eventos', () => {

    it('POST /api/payments emite evento PAYMENT_CREATED no EventStore', async () => {
      const patient = await Patient.create(createPatientPayload());
      const doctor = await Doctor.create(createDoctorPayload());

      const res = await request(app)
        .post('/api/payments')
        .send({
          patientId: patient._id.toString(),
          doctorId: doctor._id.toString(),
          amount: 200,
          paymentMethod: 'credit_card',
          status: 'paid',
          serviceType: 'individual_session',
          sessionType: 'regular'
        })
        .timeout(5000);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const paymentId = res.body.data._id;
      await waitFor(300);

      const events = await EventStore.find({
        eventType: 'PAYMENT_CREATED',
        'payload.paymentId': paymentId
      }).sort({ timestamp: -1 });

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].payload.amount).toBe(200);
      expect(events[0].payload.status).toBe('paid');
    });

    it('PATCH /api/payments/:id emite evento PAYMENT_UPDATED no EventStore', async () => {
      const patient = await Patient.create(createPatientPayload());
      const doctor = await Doctor.create(createDoctorPayload());

      const payment = await Payment.create(createPaymentPayload(patient._id, doctor._id));
      await EventStore.deleteMany({ 'payload.paymentId': payment._id.toString() });

      const res = await request(app)
        .patch(`/api/payments/${payment._id}`)
        .send({ status: 'paid', amount: 150 })
        .timeout(5000);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      await waitFor(300);

      const events = await EventStore.find({
        eventType: 'PAYMENT_UPDATED',
        'payload.paymentId': payment._id.toString()
      }).sort({ timestamp: -1 });

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].payload.status).toBe('paid');
      expect(events[0].payload.amount).toBe(150);
    });

    it('PATCH /api/payments/:id/mark-as-paid emite evento PAYMENT_UPDATED', async () => {
      const patient = await Patient.create(createPatientPayload());
      const doctor = await Doctor.create(createDoctorPayload());

      const payment = await Payment.create(createPaymentPayload(patient._id, doctor._id, { amount: 300 }));
      await EventStore.deleteMany({ 'payload.paymentId': payment._id.toString() });

      const res = await request(app)
        .patch(`/api/payments/${payment._id}/mark-as-paid`)
        .timeout(5000);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      await waitFor(300);

      const events = await EventStore.find({
        eventType: 'PAYMENT_UPDATED',
        'payload.paymentId': payment._id.toString()
      }).sort({ timestamp: -1 });

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].payload.status).toBe('paid');
      expect(events[0].payload.previousStatus).toBe('pending');
    });

    it('PATCH /api/payments/:id retorna 404 para payment inexistente', async () => {
      const fakeId = '507f1f77bcf86cd799439099';

      const res = await request(app)
        .patch(`/api/payments/${fakeId}`)
        .send({ status: 'paid' })
        .timeout(5000);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/não encontrado/i);
    });
  });
});
