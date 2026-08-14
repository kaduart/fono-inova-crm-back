/**
 * E2E Test - Patch de segurança (2026-08-14) — Liminar mode:'reset' desabilitado
 *
 * 🎯 Validação: `mode:'reset'` em POST /:id/plans/:planId/generate-sessions
 * cancela TODAS as sessões futuras scheduled/pre_agendado do contrato inteiro
 * sem transação abrangendo cancelamento+regeneração (bulkCancelAppointments
 * chamado sem mongoSession). Nenhum consumidor real usa esse modo hoje —
 * `ContractCard.tsx` sempre manda `mode:'append'` — então o endpoint passa a
 * bloquear `reset` com 409, sem mexer no caminho `append` usado pela UI.
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

// ─── SETUP ───────────────────────────────────────────────────────────────────
let mongoServer, app, server;
let Patient, Doctor, LiminarContract, TherapeuticPlan, Appointment, Session, Payment;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  LiminarContract = (await import('../../models/LiminarContract.js')).default;
  TherapeuticPlan = (await import('../../models/TherapeuticPlan.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Payment = (await import('../../models/Payment.js')).default;

  app = express();
  app.use(express.json());

  const { default: liminarContractRoutes } = await import('../../routes/liminarContract.js');
  app.use('/api/v2/liminar-contracts', liminarContractRoutes);

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

function nextWeekday(dayOfWeek) {
  const d = new Date();
  d.setDate(d.getDate() + ((dayOfWeek - d.getDay() + 7) % 7 || 7));
  d.setHours(0, 0, 0, 0);
  return d;
}

async function seedContractAndPlan() {
  const patient = await Patient.create({
    fullName: 'Paciente Liminar Reset Teste',
    phone: '62999990077',
    dateOfBirth: new Date('2017-01-01')
  });
  const doctor = await Doctor.create({
    fullName: 'Dr. Liminar Reset Teste',
    specialty: 'fonoaudiologia',
    phoneNumber: '62999990076',
    licenseNumber: 'CRM-GO-66666',
    email: 'dr.liminarreset@teste.com'
  });

  const contract = await LiminarContract.create({
    patient: patient._id,
    doctor: doctor._id,
    totalCredit: 4000,
    creditBalance: 4000,
    usedCredit: 0,
    status: 'active'
  });

  const startDate = nextWeekday(1);
  const plan = await TherapeuticPlan.create({
    patient: patient._id,
    liminarContract: contract._id,
    version: 1,
    startDate,
    status: 'active',
    therapies: {
      fonoaudiologia: {
        doctor: doctor._id,
        slots: [{ dayOfWeek: 1, time: '09:00' }],
        sessionValue: 100,
        sessionDurationMinutes: 40
      }
    }
  });

  return { patient, doctor, contract, plan };
}

describe('🔒 POST /:id/plans/:planId/generate-sessions — mode:reset desabilitado, mode:append intacto', () => {
  it('mode:reset retorna 409 LIMINAR_RESET_DISABLED e não muda nada', async () => {
    const { contract, plan } = await seedContractAndPlan();
    const contractBefore = await LiminarContract.findById(contract._id).lean();

    const res = await request(app)
      .post(`/api/v2/liminar-contracts/${contract._id}/plans/${plan._id}/generate-sessions`)
      .send({
        mode: 'reset',
        startDate: nextWeekday(1).toISOString().slice(0, 10),
        endDate: nextWeekday(1).toISOString().slice(0, 10)
      });

    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('LIMINAR_RESET_DISABLED');

    // Zero mutação: contrato intacto
    const contractAfter = await LiminarContract.findById(contract._id).lean();
    expect(contractAfter.creditBalance).toBe(contractBefore.creditBalance);
    expect(contractAfter.usedCredit).toBe(contractBefore.usedCredit);
    expect(contractAfter.status).toBe(contractBefore.status);

    // Zero Appointment/Session/Payment criados ou cancelados
    const appointmentsCount = await Appointment.countDocuments({ liminarContract: contract._id });
    expect(appointmentsCount).toBe(0);
    const sessionsCount = await Session.countDocuments({});
    expect(sessionsCount).toBe(0);
    const paymentsCount = await Payment.countDocuments({});
    expect(paymentsCount).toBe(0);

    // Plano continua intacto
    const planAfter = await TherapeuticPlan.findById(plan._id).lean();
    expect(planAfter.status).toBe('active');
  }, 30_000);

  it('mode:append continua funcionando exatamente como antes (não afetado pelo bloqueio do reset)', async () => {
    const { contract, plan } = await seedContractAndPlan();

    const res = await request(app)
      .post(`/api/v2/liminar-contracts/${contract._id}/plans/${plan._id}/generate-sessions`)
      .send({ mode: 'append', weeks: 2 });

    expect(res.status).toBe(201);
    expect(res.body.created).toBeGreaterThan(0);

    const appointmentsCount = await Appointment.countDocuments({ liminarContract: contract._id });
    expect(appointmentsCount).toBe(res.body.created);
  }, 30_000);

  it('mode ausente (default) continua se comportando como append', async () => {
    const { contract, plan } = await seedContractAndPlan();

    const res = await request(app)
      .post(`/api/v2/liminar-contracts/${contract._id}/plans/${plan._id}/generate-sessions`)
      .send({ weeks: 1 });

    expect(res.status).toBe(201);
    expect(res.body.created).toBeGreaterThan(0);
  }, 30_000);
});
