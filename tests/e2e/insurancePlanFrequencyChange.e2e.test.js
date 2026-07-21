/**
 * E2E Test - PATCH /api/v2/insurance-plans/:id e POST /generate-sessions
 *
 * 🎯 Validação:
 *   - O PATCH salva a configuração do plano (slots, profissional, valor) e sincroniza
 *     incrementalmente appointments futuros (horário/profissional/valor), mas NÃO
 *     replaneja automaticamente quando a frequência/dias mudam.
 *   - O POST /generate-sessions detecta quando os appointments futuros de um plano estão
 *     divergentes dos slots atuais e, nesse caso, cancela as futuras pendentes e regenera
 *     pelo padrão novo — sem exceder o total autorizado pela guia e sem tocar em sessões
 *     já realizadas (guide.usedSessions).
 *
 * ⚠️ REGRESSÃO: guia #319995 (Terapia Ocupacional, Unimed Fesp, 2026-07-20).
 *    Plano criado com 1 slot/semana consumiu as 14 sessões autorizadas 1x/semana. O usuário
 *    editou o plano para 3 slots/semana e depois clicou em "Gerar sessões". O endpoint
 *    generate-sessions viajou que os appointments futuros ainda eram do padrão antigo
 *    (sexta 10:00) e retornou 0, porque a guia estava 100% reservada. A correção exige
 *    que o generate-sessions detecte a divergência e replaneje.
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
let Patient, PatientsView, Doctor, Convenio, InsuranceGuide, InsurancePlan, Appointment;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  Patient = (await import('../../models/Patient.js')).default;
  PatientsView = (await import('../../models/PatientsView.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Convenio = (await import('../../models/Convenio.js')).default;
  InsuranceGuide = (await import('../../models/InsuranceGuide.js')).default;
  InsurancePlan = (await import('../../models/InsurancePlan.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;

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
async function seedData({ totalSessions = 6, usedSessions = 0 } = {}) {
  const patient = await Patient.create({
    fullName: 'Paciente Frequência Convênio Teste',
    phone: '62999990011',
    dateOfBirth: new Date('2015-01-15')
  });

  const doctor = await Doctor.create({
    fullName: 'Dra. Frequência Teste',
    specialty: 'terapia_ocupacional',
    phoneNumber: '62999990012',
    licenseNumber: 'CRM-GO-88888',
    email: 'dra.frequencia@convenio.com'
  });

  await Convenio.create({
    code: 'unimed-frequencia-teste',
    name: 'Unimed Frequência Teste',
    sessionValue: 180,
    active: true,
    guidePolicy: { renewalType: 'until_consumed', autoSuggestRenewal: false }
  });

  const guide = await InsuranceGuide.create({
    number: 'GUIA-FREQ-001',
    insurance: 'unimed-frequencia-teste',
    patientId: patient._id,
    doctorId: doctor._id,
    specialty: 'terapia_ocupacional',
    totalSessions,
    usedSessions,
    sessionValue: 180,
    status: 'active',
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 180)
  });

  // dia da semana bem no futuro pra não colidir com "hoje" durante o teste
  const futureMonday = new Date();
  futureMonday.setDate(futureMonday.getDate() + ((8 - futureMonday.getDay()) % 7 || 7));

  const plan = await InsurancePlan.create({
    patient: patient._id,
    guide: guide._id,
    doctor: doctor._id,
    specialty: 'terapia_ocupacional',
    totalSessions: totalSessions - usedSessions,
    sessionsPerWeek: 1,
    startDate: futureMonday,
    slots: [{ dayOfWeek: 1, time: '09:00' }], // segunda-feira, 1x/semana
    sessionValue: 180,
    status: 'active'
  });

  return { patient, doctor, guide, plan };
}

async function generateInitial(plan, guide) {
  const { generateInsurancePlanSessions } = await import('../../services/schedule/generateInsurancePlanSessions.js');
  const mongoSession = await mongoose.startSession();
  await mongoSession.startTransaction();
  try {
    await generateInsurancePlanSessions({
      planId: plan._id,
      guideId: guide._id,
      sessionValue: 180,
      mongoSession,
      skipHolidays: true
    });
    await mongoSession.commitTransaction();
  } catch (err) {
    await mongoSession.abortTransaction();
    throw err;
  } finally {
    mongoSession.endSession();
  }
}

// ─── TESTES ──────────────────────────────────────────────────────────────────
describe('🚨 PATCH /api/v2/insurance-plans/:id — salva configuração sem replanejar', () => {
  it('salva novos slots sem replanejar a agenda', async () => {
    const { guide, plan } = await seedData({ totalSessions: 6, usedSessions: 0 });
    await generateInitial(plan, guide);

    const beforeAppointments = await Appointment.find({ insurancePlan: plan._id }).lean();
    expect(beforeAppointments.length).toBe(6);

    const res = await request(app)
      .patch(`/api/v2/insurance-plans/${plan._id}`)
      .send({
        slots: [
          { dayOfWeek: 1, time: '09:00' },
          { dayOfWeek: 3, time: '10:00' }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.frequencyChanged).toBe(true);
    // PATCH não gera mais appointments automaticamente
    expect(res.body.data.appointmentsGenerated).toBe(0);

    const oldStillActive = await Appointment.find({
      _id: { $in: beforeAppointments.map(a => a._id) },
      operationalStatus: { $ne: 'canceled' }
    }).lean();
    expect(oldStillActive.length).toBe(6); // nada foi cancelado pelo PATCH
  }, 30_000);

  it('sincroniza horário quando a frequência não muda', async () => {
    const { guide, plan } = await seedData({ totalSessions: 6, usedSessions: 0 });
    await generateInitial(plan, guide);

    const beforeAppointments = await Appointment.find({ insurancePlan: plan._id }).lean();

    const res = await request(app)
      .patch(`/api/v2/insurance-plans/${plan._id}`)
      .send({
        slots: [{ dayOfWeek: 1, time: '11:00' }]
      });

    expect(res.status).toBe(200);
    expect(res.body.data.frequencyChanged).toBe(false);
    expect(res.body.data.appointmentsGenerated).toBe(0);

    const stillActive = await Appointment.find({
      _id: { $in: beforeAppointments.map(a => a._id) },
      operationalStatus: { $ne: 'canceled' }
    }).lean();
    expect(stillActive.length).toBe(beforeAppointments.length);
    expect(stillActive.every(a => a.time === '11:00')).toBe(true);
  }, 30_000);
});

describe('🚨 POST /api/v2/insurance-plans/:id/generate-sessions — replaneja quando detecta divergência', () => {
  it('detecta divergência, cancela o padrão antigo e regenera no novo padrão', async () => {
    const { guide, plan } = await seedData({ totalSessions: 6, usedSessions: 0 });
    await generateInitial(plan, guide);

    const beforeAppointments = await Appointment.find({ insurancePlan: plan._id }).lean();
    expect(beforeAppointments.length).toBe(6);
    expect(beforeAppointments.every(a => new Date(a.date).getDay() === 1)).toBe(true);

    // 1) Altera o plano (PATCH apenas salva)
    await request(app)
      .patch(`/api/v2/insurance-plans/${plan._id}`)
      .send({
        slots: [
          { dayOfWeek: 1, time: '09:00' },
          { dayOfWeek: 3, time: '10:00' }
        ]
      });

    // 2) Clica em "Gerar sessões"
    const res = await request(app)
      .post(`/api/v2/insurance-plans/${plan._id}/generate-sessions`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.replanned).toBe(true);
    expect(res.body.data.appointmentsCanceled).toBe(6);
    expect(res.body.data.appointmentsGenerated).toBeGreaterThan(0);

    // Os 6 appointments antigos (só segunda) devem ter sido cancelados
    const oldStillActive = await Appointment.find({
      _id: { $in: beforeAppointments.map(a => a._id) },
      operationalStatus: { $ne: 'canceled' }
    }).lean();
    expect(oldStillActive.length).toBe(0);

    // O novo conjunto ativo deve incluir os dois dias da semana e nunca passar de 6
    const activeAfter = await Appointment.find({
      insuranceGuide: guide._id,
      operationalStatus: { $in: ['scheduled', 'pre_agendado', 'confirmed'] }
    }).lean();

    expect(activeAfter.length).toBeGreaterThan(0);
    expect(activeAfter.length).toBeLessThanOrEqual(6);

    const daysOfWeek = new Set(activeAfter.map(a => new Date(a.date).getDay()));
    expect(daysOfWeek.has(3)).toBe(true);
  }, 30_000);

  it('preserva usedSessions ao replanejar pelo generate-sessions', async () => {
    const { guide, plan } = await seedData({ totalSessions: 6, usedSessions: 1 });
    await generateInitial(plan, guide);

    await request(app)
      .patch(`/api/v2/insurance-plans/${plan._id}`)
      .send({
        slots: [
          { dayOfWeek: 1, time: '09:00' },
          { dayOfWeek: 3, time: '10:00' }
        ]
      });

    await request(app)
      .post(`/api/v2/insurance-plans/${plan._id}/generate-sessions`);

    const guideAfter = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfter.usedSessions).toBe(1);

    const activeAfter = await Appointment.find({
      insuranceGuide: guide._id,
      operationalStatus: { $in: ['scheduled', 'pre_agendado', 'confirmed'] }
    }).lean();
    expect(activeAfter.length).toBeLessThanOrEqual(5);
  }, 30_000);

  it('não replaneja quando os futuros já batem com os slots', async () => {
    const { guide, plan } = await seedData({ totalSessions: 6, usedSessions: 0 });
    await generateInitial(plan, guide);

    const res = await request(app)
      .post(`/api/v2/insurance-plans/${plan._id}/generate-sessions`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.replanned).toBe(false);
    expect(res.body.data.appointmentsCanceled).toBe(0);
  }, 30_000);
});
