/**
 * E2E Test - Patch de segurança (2026-08-14)
 *
 * 🎯 Validação: dois caminhos que antes cancelavam/deletavam registros de
 * convênio automaticamente agora só DETECTAM e BLOQUEIAM com 409 — zero
 * mutação em qualquer estado financeiro (pending, billed, received/paid,
 * partial).
 *
 * ⚠️ REGRESSÃO evitada: o código anterior cancelava appointments de OUTRA
 * guia (mesmo paciente+doutor) e fazia hard-delete de payments pendentes ao
 * substituir um plano existente, sem checar se o Payment vinculado já tinha
 * avançado no ciclo de faturamento do convênio (Payment.insurance.status:
 * billed/received) ou se estava parcialmente pago (Payment.status: partial).
 *
 * Suite 1: POST /:id/generate-sessions — conflito de agenda com appointment
 *          de OUTRA guia deve retornar 409 e não tocar em nada, seja qual
 *          for o estado financeiro do registro conflitante.
 * Suite 2: POST /  — criar plano quando já existe um com Appointment/Session/
 *          Payment associado deve retornar 409 e não substituir/cancelar/
 *          deletar nada, seja qual for o estado financeiro dos registros.
 * Suite 3: POST /  — plano existente SEM nenhum registro associado continua
 *          podendo ser substituído (comportamento positivo preservado).
 * Suite 4: POST /  — preflight v2 detecta vínculo isolado por tipo (só Session,
 *          só Payment, Appointment em generatedAppointments sem insurancePlan,
 *          Appointment legado só com insuranceGuide) e por status (completed,
 *          canceled também bloqueiam).
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

vi.mock('../../middleware/auth.js', () => ({
  auth: (req, _res, next) => {
    req.user = { id: new mongoose.Types.ObjectId().toString(), role: 'admin' };
    next();
  },
  authorize: () => (_req, _res, next) => next()
}));

// ─── SETUP ───────────────────────────────────────────────────────────────────
let mongoServer, app, server;
let Patient, Doctor, Convenio, InsuranceGuide, InsurancePlan, Appointment, Session, Payment;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Convenio = (await import('../../models/Convenio.js')).default;
  InsuranceGuide = (await import('../../models/InsuranceGuide.js')).default;
  InsurancePlan = (await import('../../models/InsurancePlan.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Payment = (await import('../../models/Payment.js')).default;

  app = express();
  app.use(express.json());

  const { default: insurancePlansRoutes } = await import('../../routes/insurancePlans.v2.js');
  app.use('/api/v2/insurance-plans', insurancePlansRoutes);

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
const FINANCIAL_STATES = [
  {
    name: 'pending',
    payment: { status: 'pending', insurance: { status: 'pending' } }
  },
  {
    name: 'billed (faturado)',
    payment: { status: 'billed', insurance: { status: 'billed', billedAt: new Date('2026-07-01') } }
  },
  {
    name: 'received/paid (recebido)',
    payment: {
      status: 'paid',
      paidAt: new Date('2026-07-15'),
      insurance: { status: 'received', billedAt: new Date('2026-07-01'), receivedAt: new Date('2026-07-15'), receivedAmount: 80 }
    }
  },
  {
    name: 'partial (parcial)',
    payment: { status: 'partial', insurance: { status: 'billed', billedAt: new Date('2026-07-01') } }
  }
];

function nextWeekday(dayOfWeek) {
  const d = new Date();
  d.setDate(d.getDate() + ((dayOfWeek - d.getDay() + 7) % 7 || 7));
  d.setHours(0, 0, 0, 0);
  return d;
}

async function seedPatientAndDoctor() {
  const patient = await Patient.create({
    fullName: 'Paciente Patch Segurança',
    phone: '62999990099',
    dateOfBirth: new Date('2016-01-01')
  });
  const doctor = await Doctor.create({
    fullName: 'Dra. Patch Segurança',
    specialty: 'terapia_ocupacional',
    phoneNumber: '62999990098',
    licenseNumber: 'CRM-GO-77777',
    email: 'dra.patch@convenio.com'
  });
  await Convenio.create({
    code: 'unimed-patch-teste',
    name: 'Unimed Patch Teste',
    sessionValue: 80,
    active: true,
    guidePolicy: { renewalType: 'until_consumed', autoSuggestRenewal: false }
  });
  return { patient, doctor };
}

async function seedGuide(patient, doctor, overrides = {}) {
  return InsuranceGuide.create({
    number: overrides.number || `GUIA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    insurance: 'unimed-patch-teste',
    patientId: patient._id,
    doctorId: doctor._id,
    specialty: 'terapia_ocupacional',
    totalSessions: 10,
    usedSessions: 0,
    sessionValue: 80,
    status: 'active',
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 180),
    ...overrides
  });
}

/** Cria appointment + session + payment (trinca) num dado estado financeiro. */
async function seedTrio({ patient, doctor, guide, date, time, operationalStatus = 'pre_agendado', financialState, insurancePlan = null }) {
  // operationalStatus='completed' é bloqueado pelo guard de schema fora do
  // completeSessionService (models/Appointment.js) — para fixture de teste,
  // a flag `_fromCompleteService` autoriza explicitamente, mesma porta que o
  // serviço real usa.
  const appointmentDoc = new Appointment({
    patient: patient._id,
    doctor: doctor._id,
    specialty: 'terapia_ocupacional',
    date,
    time,
    billingType: 'convenio',
    paymentMethod: 'convenio',
    insuranceGuide: guide._id,
    insurancePlan,
    insuranceProvider: guide.insurance,
    sessionValue: 80,
    insuranceValue: 80,
    operationalStatus,
    clinicalStatus: 'pending',
    status: operationalStatus,
    serviceType: 'session',
    sessionType: 'terapia_ocupacional',
    duration: 40,
    metadata: { origin: { source: 'insurance_plan' } }
  });
  if (operationalStatus === 'completed') appointmentDoc._fromCompleteService = true;
  const appointment = await appointmentDoc.save();

  const session = await Session.create({
    patient: patient._id,
    doctor: doctor._id,
    specialty: 'terapia_ocupacional',
    date,
    time,
    sessionType: 'terapia_ocupacional',
    serviceType: 'session',
    sessionValue: 80,
    appointmentId: appointment._id,
    appointment: appointment._id,
    paymentMethod: 'convenio',
    status: operationalStatus === 'pre_agendado' || operationalStatus === 'scheduled' ? 'scheduled' : operationalStatus,
    isPaid: false,
    insuranceGuide: guide._id
  });

  const payment = await Payment.create({
    patient: patient._id,
    doctor: doctor._id,
    appointment: appointment._id,
    session: session._id,
    specialty: 'terapia_ocupacional',
    amount: financialState.payment.status === 'paid' ? 80 : 0,
    paymentDate: date,
    paidAt: financialState.payment.paidAt,
    paymentMethod: 'convenio',
    billingType: 'convenio',
    status: financialState.payment.status,
    insurance: {
      provider: guide.insurance,
      grossAmount: 80,
      ...financialState.payment.insurance
    },
    insuranceGuide: guide._id,
    insurancePlan,
    kind: 'session_payment'
  });

  await Appointment.findByIdAndUpdate(appointment._id, { session: session._id, payment: payment._id });

  return { appointment, session, payment };
}

async function snapshotTrio({ appointment, session, payment }) {
  return {
    appointment: await Appointment.findById(appointment._id).lean(),
    session: await Session.findById(session._id).lean(),
    payment: await Payment.findById(payment._id).lean()
  };
}

// ─── SUITE 1 — generate-sessions nunca cancela registro de OUTRA guia ─────────
describe('🔒 POST /:id/generate-sessions — conflito cross-guide bloqueia, nunca cancela', () => {
  for (const financialState of FINANCIAL_STATES) {
    it(`estado financeiro "${financialState.name}": 409 + zero mutação no registro da guia antiga`, async () => {
      const { patient, doctor } = await seedPatientAndDoctor();

      // Guia A (antiga) com um appointment travando terça 09:00
      const guideA = await seedGuide(patient, doctor, { number: 'GUIA-A-ANTIGA' });
      const conflictDate = nextWeekday(2); // terça
      const trio = await seedTrio({
        patient, doctor, guide: guideA,
        date: conflictDate, time: '09:00',
        operationalStatus: 'pre_agendado',
        financialState
      });
      const before = await snapshotTrio(trio);

      // Guia B (nova) com plano cujo slot colide exatamente com o appointment da guia A
      const guideB = await seedGuide(patient, doctor, { number: 'GUIA-B-NOVA' });
      const plan = await InsurancePlan.create({
        patient: patient._id,
        guide: guideB._id,
        doctor: doctor._id,
        specialty: 'terapia_ocupacional',
        totalSessions: 10,
        sessionsPerWeek: 1,
        startDate: conflictDate,
        slots: [{ dayOfWeek: 2, time: '09:00' }],
        sessionValue: 80,
        status: 'active'
      });

      const res = await request(app)
        .post(`/api/v2/insurance-plans/${plan._id}/generate-sessions`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('APPOINTMENT_SLOT_CONFLICT');

      // Zero mutação: o trio da guia A tem que estar byte-a-byte igual
      const after = await snapshotTrio(trio);
      expect(after.appointment.operationalStatus).toBe(before.appointment.operationalStatus);
      expect(after.session.status).toBe(before.session.status);
      expect(after.payment.status).toBe(before.payment.status);
      expect(after.payment.insurance.status).toBe(before.payment.insurance.status);
      expect(after.payment.insurance.receivedAmount).toBe(before.payment.insurance.receivedAmount);

      // Guia A não pode ter sido tocada (usedSessions intacto)
      const guideAAfter = await InsuranceGuide.findById(guideA._id).lean();
      expect(guideAAfter.usedSessions).toBe(0);

      // Nenhum appointment novo deve ter sido criado pra guia B
      const guideBAppointments = await Appointment.countDocuments({ insuranceGuide: guideB._id });
      expect(guideBAppointments).toBe(0);
    }, 30_000);
  }
});

// ─── SUITE 2 — POST / nunca substitui plano com registros associados ──────────
describe('🔒 POST /api/v2/insurance-plans — plano existente com registros associados bloqueia, nunca substitui', () => {
  for (const financialState of FINANCIAL_STATES) {
    it(`estado financeiro "${financialState.name}": 409 + zero mutação, plano antigo preservado`, async () => {
      const { patient, doctor } = await seedPatientAndDoctor();
      const guide = await seedGuide(patient, doctor, { number: 'GUIA-COM-HISTORICO' });

      const existingPlan = await InsurancePlan.create({
        patient: patient._id,
        guide: guide._id,
        doctor: doctor._id,
        specialty: 'terapia_ocupacional',
        totalSessions: 10,
        sessionsPerWeek: 1,
        startDate: nextWeekday(1),
        slots: [{ dayOfWeek: 1, time: '10:00' }],
        sessionValue: 80,
        status: 'active'
      });

      const trio = await seedTrio({
        patient, doctor, guide,
        date: nextWeekday(1), time: '10:00',
        operationalStatus: 'pre_agendado',
        financialState,
        insurancePlan: existingPlan._id
      });
      const before = await snapshotTrio(trio);

      const res = await request(app)
        .post('/api/v2/insurance-plans')
        .send({
          guideId: guide._id.toString(),
          doctorId: doctor._id.toString(),
          specialty: 'terapia_ocupacional',
          startDate: nextWeekday(3).toISOString().slice(0, 10),
          slots: [{ dayOfWeek: 3, time: '14:00' }],
          sessionValue: 80
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.errorCode).toBe('PLAN_HAS_ASSOCIATED_RECORDS');
      expect(res.body.associatedAppointmentsCount).toBeGreaterThan(0);

      // Plano antigo tem que continuar existindo, intocado
      const planAfter = await InsurancePlan.findById(existingPlan._id).lean();
      expect(planAfter).not.toBeNull();
      expect(planAfter.status).toBe('active');
      expect(planAfter.slots.map(s => ({ dayOfWeek: s.dayOfWeek, time: s.time }))).toEqual(
        existingPlan.slots.map(s => ({ dayOfWeek: s.dayOfWeek, time: s.time }))
      );

      // Nenhum plano novo foi criado pra essa guia
      const plansForGuide = await InsurancePlan.countDocuments({ guide: guide._id });
      expect(plansForGuide).toBe(1);

      // Trio original byte-a-byte igual
      const after = await snapshotTrio(trio);
      expect(after.appointment.operationalStatus).toBe(before.appointment.operationalStatus);
      expect(after.session.status).toBe(before.session.status);
      expect(after.payment.status).toBe(before.payment.status);
      expect(after.payment.insurance.status).toBe(before.payment.insurance.status);
    }, 30_000);
  }
});

// ─── SUITE 3 — plano vazio (sem nenhum registro) continua substituível ────────
describe('✅ POST /api/v2/insurance-plans — plano existente SEM registros associados ainda pode ser substituído', () => {
  it('plano sem nenhum Appointment gerado: substitui normalmente, sem 409', async () => {
    const { patient, doctor } = await seedPatientAndDoctor();
    const guide = await seedGuide(patient, doctor, { number: 'GUIA-PLANO-VAZIO' });

    const emptyPlan = await InsurancePlan.create({
      patient: patient._id,
      guide: guide._id,
      doctor: doctor._id,
      specialty: 'terapia_ocupacional',
      totalSessions: 10,
      sessionsPerWeek: 1,
      startDate: nextWeekday(1),
      slots: [{ dayOfWeek: 1, time: '10:00' }],
      sessionValue: 80,
      status: 'active'
    });
    // Sem nenhum Appointment com insurancePlan: emptyPlan._id

    const res = await request(app)
      .post('/api/v2/insurance-plans')
      .send({
        guideId: guide._id.toString(),
        doctorId: doctor._id.toString(),
        specialty: 'terapia_ocupacional',
        startDate: nextWeekday(3).toISOString().slice(0, 10),
        slots: [{ dayOfWeek: 3, time: '14:00' }],
        sessionValue: 80
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const oldPlanStillThere = await InsurancePlan.findById(emptyPlan._id).lean();
    expect(oldPlanStillThere).toBeNull(); // plano vazio antigo foi removido, como esperado

    const plansForGuide = await InsurancePlan.countDocuments({ guide: guide._id });
    expect(plansForGuide).toBe(1); // só o novo
  }, 30_000);
});

// ─── SUITE 4 — preflight v2 detecta vínculo isolado por tipo e por status ─────
describe('🔒 POST /api/v2/insurance-plans — preflight v2 detecta vínculo isolado (Session-only, Payment-only, legado)', () => {
  async function makeExistingPlan(patient, doctor, guide) {
    return InsurancePlan.create({
      patient: patient._id,
      guide: guide._id,
      doctor: doctor._id,
      specialty: 'terapia_ocupacional',
      totalSessions: 10,
      sessionsPerWeek: 1,
      startDate: nextWeekday(1),
      slots: [{ dayOfWeek: 1, time: '10:00' }],
      sessionValue: 80,
      status: 'active'
    });
  }

  function postReplacement(guide, doctor) {
    return request(app)
      .post('/api/v2/insurance-plans')
      .send({
        guideId: guide._id.toString(),
        doctorId: doctor._id.toString(),
        specialty: 'terapia_ocupacional',
        startDate: nextWeekday(3).toISOString().slice(0, 10),
        slots: [{ dayOfWeek: 3, time: '14:00' }],
        sessionValue: 80
      });
  }

  it('somente Session associada (insuranceGuide), sem nenhum Appointment: bloqueia', async () => {
    const { patient, doctor } = await seedPatientAndDoctor();
    const guide = await seedGuide(patient, doctor, { number: 'GUIA-SESSION-ONLY' });
    const existingPlan = await makeExistingPlan(patient, doctor, guide);

    const orphanSession = await Session.create({
      patient: patient._id,
      doctor: doctor._id,
      specialty: 'terapia_ocupacional',
      date: nextWeekday(1),
      time: '10:00',
      sessionType: 'terapia_ocupacional',
      serviceType: 'session',
      sessionValue: 80,
      appointmentId: null,
      paymentMethod: 'convenio',
      status: 'scheduled',
      isPaid: false,
      insuranceGuide: guide._id
    });

    const res = await postReplacement(guide, doctor);

    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('PLAN_HAS_ASSOCIATED_RECORDS');
    expect(res.body.linkedRecordTypes).toContain('session');

    const planAfter = await InsurancePlan.findById(existingPlan._id).lean();
    expect(planAfter).not.toBeNull();
    const sessionAfter = await Session.findById(orphanSession._id).lean();
    expect(sessionAfter.status).toBe('scheduled');
    const plansForGuide = await InsurancePlan.countDocuments({ guide: guide._id });
    expect(plansForGuide).toBe(1);
  }, 30_000);

  it('somente Payment associado (insuranceGuide), sem Appointment nem Session: bloqueia', async () => {
    const { patient, doctor } = await seedPatientAndDoctor();
    const guide = await seedGuide(patient, doctor, { number: 'GUIA-PAYMENT-ONLY' });
    const existingPlan = await makeExistingPlan(patient, doctor, guide);

    const orphanPayment = await Payment.create({
      patient: patient._id,
      doctor: doctor._id,
      specialty: 'terapia_ocupacional',
      amount: 0,
      paymentDate: nextWeekday(1),
      paymentMethod: 'convenio',
      billingType: 'convenio',
      status: 'pending',
      insurance: { provider: guide.insurance, status: 'pending', grossAmount: 80 },
      insuranceGuide: guide._id,
      kind: 'session_payment'
    });

    const res = await postReplacement(guide, doctor);

    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('PLAN_HAS_ASSOCIATED_RECORDS');
    expect(res.body.linkedRecordTypes).toContain('payment');

    const planAfter = await InsurancePlan.findById(existingPlan._id).lean();
    expect(planAfter).not.toBeNull();
    const paymentAfter = await Payment.findById(orphanPayment._id).lean();
    expect(paymentAfter.status).toBe('pending');
    const plansForGuide = await InsurancePlan.countDocuments({ guide: guide._id });
    expect(plansForGuide).toBe(1);
  }, 30_000);

  it('Appointment presente em generatedAppointments mas SEM insurancePlan setado: bloqueia', async () => {
    const { patient, doctor } = await seedPatientAndDoctor();
    const guide = await seedGuide(patient, doctor, { number: 'GUIA-CACHE-ONLY' });
    const existingPlan = await makeExistingPlan(patient, doctor, guide);

    // Appointment criado SEM insurancePlan e SEM insuranceGuide — só existe no
    // cache generatedAppointments do plano (cenário de drift do cache).
    const cachedOnlyAppt = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      specialty: 'terapia_ocupacional',
      date: nextWeekday(1),
      time: '10:00',
      billingType: 'convenio',
      paymentMethod: 'convenio',
      operationalStatus: 'pre_agendado',
      clinicalStatus: 'pending',
      status: 'pre_agendado',
      serviceType: 'session',
      sessionType: 'terapia_ocupacional',
      duration: 40
    });
    await InsurancePlan.findByIdAndUpdate(existingPlan._id, {
      $push: { generatedAppointments: cachedOnlyAppt._id }
    });

    const res = await postReplacement(guide, doctor);

    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('PLAN_HAS_ASSOCIATED_RECORDS');
    expect(res.body.linkedRecordTypes).toContain('appointment');

    const apptAfter = await Appointment.findById(cachedOnlyAppt._id).lean();
    expect(apptAfter.operationalStatus).toBe('pre_agendado');
    const plansForGuide = await InsurancePlan.countDocuments({ guide: guide._id });
    expect(plansForGuide).toBe(1);
  }, 30_000);

  it('Appointment legado com insuranceGuide mas SEM insurancePlan e fora de generatedAppointments: bloqueia', async () => {
    const { patient, doctor } = await seedPatientAndDoctor();
    const guide = await seedGuide(patient, doctor, { number: 'GUIA-LEGADO-GUIDE' });
    const existingPlan = await makeExistingPlan(patient, doctor, guide);

    // Appointment com insuranceGuide setado, mas insurancePlan nulo e NÃO
    // referenciado em generatedAppointments — dado legado pré-campo insurancePlan.
    const legacyAppt = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      specialty: 'terapia_ocupacional',
      date: nextWeekday(1),
      time: '10:00',
      billingType: 'convenio',
      paymentMethod: 'convenio',
      insuranceGuide: guide._id,
      insurancePlan: null,
      operationalStatus: 'pre_agendado',
      clinicalStatus: 'pending',
      status: 'pre_agendado',
      serviceType: 'session',
      sessionType: 'terapia_ocupacional',
      duration: 40
    });

    const res = await postReplacement(guide, doctor);

    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('PLAN_HAS_ASSOCIATED_RECORDS');
    expect(res.body.linkedRecordTypes).toContain('appointment');

    const apptAfter = await Appointment.findById(legacyAppt._id).lean();
    expect(apptAfter.operationalStatus).toBe('pre_agendado');
    const plansForGuide = await InsurancePlan.countDocuments({ guide: guide._id });
    expect(plansForGuide).toBe(1);
  }, 30_000);

  it.each(['completed', 'canceled'])('Appointment com status "%s" também bloqueia substituição', async (operationalStatus) => {
    const { patient, doctor } = await seedPatientAndDoctor();
    const guide = await seedGuide(patient, doctor, { number: `GUIA-STATUS-${operationalStatus.toUpperCase()}` });
    const existingPlan = await makeExistingPlan(patient, doctor, guide);

    const trio = await seedTrio({
      patient, doctor, guide,
      date: nextWeekday(1), time: '10:00',
      operationalStatus,
      financialState: FINANCIAL_STATES[0], // pending — status do appointment é o que importa aqui
      insurancePlan: existingPlan._id
    });

    const res = await postReplacement(guide, doctor);

    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('PLAN_HAS_ASSOCIATED_RECORDS');

    const apptAfter = await Appointment.findById(trio.appointment._id).lean();
    expect(apptAfter.operationalStatus).toBe(operationalStatus);
    const plansForGuide = await InsurancePlan.countDocuments({ guide: guide._id });
    expect(plansForGuide).toBe(1);
  }, 30_000);
});
