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
import { completeSessionV2 } from '../../services/completeSessionService.v2.js';
import cancelAppointmentCommand from '../../services/appointment/commands/cancelAppointmentCommand.js';
import { readFile } from 'node:fs/promises';

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
  it('o serviço não contém mais execução destrutiva de reset', async () => {
    const source = await readFile(new URL('../../services/schedule/generateLiminarSessions.js', import.meta.url), 'utf8');
    expect(source).not.toContain('bulkCancelAppointments');
    expect(source).not.toContain('Appointment.deleteMany');
    expect(source).not.toContain('ordered: false');
  });

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
    const appointments = await Appointment.find({ liminarContract: contract._id }).lean();
    expect(appointments.every(item => item.operationalStatus === 'pre_agendado' && item.session)).toBe(true);
    expect(await Session.countDocuments({ appointmentId: { $in: appointments.map(item => item._id) } })).toBe(appointments.length);

    const repeated = await request(app)
      .post(`/api/v2/liminar-contracts/${contract._id}/plans/${plan._id}/generate-sessions`)
      .send({ mode: 'append', weeks: 2 });
    expect(repeated.status).toBe(201);
    expect(repeated.body.created).toBe(0);
    expect(await Appointment.countDocuments({ liminarContract: contract._id })).toBe(appointments.length);
  }, 30_000);

  it('falha ao inserir Session provoca rollback de todos os Appointments', async () => {
    const { contract, plan } = await seedContractAndPlan();
    const failure = vi.spyOn(Session, 'insertMany').mockRejectedValueOnce(new Error('falha injetada'));
    const res = await request(app)
      .post(`/api/v2/liminar-contracts/${contract._id}/plans/${plan._id}/generate-sessions`)
      .send({ mode: 'append', weeks: 2 });
    failure.mockRestore();
    expect(res.status).toBe(500);
    expect(await Appointment.countDocuments({ liminarContract: contract._id })).toBe(0);
    expect(await Session.countDocuments({})).toBe(0);
  }, 30_000);

  it('conflito externo de médico bloqueia o lote inteiro com 409 e zero escrita', async () => {
    const { patient, doctor, contract, plan } = await seedContractAndPlan();
    const date = nextWeekday(1);
    await Appointment.create({
      patient: new mongoose.Types.ObjectId(), doctor: doctor._id, date, time: '09:00', duration: 40,
      specialty: 'fonoaudiologia', operationalStatus: 'scheduled', clinicalStatus: 'pending',
      serviceType: 'individual_session', sessionValue: 100,
    });
    const res = await request(app)
      .post(`/api/v2/liminar-contracts/${contract._id}/plans/${plan._id}/generate-sessions`)
      .send({ mode: 'append', weeks: 2 });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('LIMINAR_SCHEDULE_CONFLICT');
    expect(await Appointment.countDocuments({ liminarContract: contract._id })).toBe(0);
    expect(patient).toBeTruthy();
  }, 30_000);

  it('colisão interna entre especialidades bloqueia o lote inteiro', async () => {
    const { contract, plan, doctor } = await seedContractAndPlan();
    await TherapeuticPlan.updateOne({ _id: plan._id }, {
      $set: {
        'therapies.psicologia': {
          doctor: doctor._id, slots: [{ dayOfWeek: 1, time: '09:00' }],
          sessionValue: 100, sessionDurationMinutes: 40,
        },
      },
    });
    const res = await request(app)
      .post(`/api/v2/liminar-contracts/${contract._id}/plans/${plan._id}/generate-sessions`)
      .send({ mode: 'append', weeks: 1 });
    expect(res.status).toBe(409);
    expect(await Appointment.countDocuments({ liminarContract: contract._id })).toBe(0);
  }, 30_000);

  it('mode ausente (default) continua se comportando como append', async () => {
    const { contract, plan } = await seedContractAndPlan();

    const res = await request(app)
      .post(`/api/v2/liminar-contracts/${contract._id}/plans/${plan._id}/generate-sessions`)
      .send({ weeks: 1 });

    expect(res.status).toBe(201);
    expect(res.body.created).toBeGreaterThan(0);
  }, 30_000);

  it('conclui uma sessão real gerada como pre_agendado e consome crédito uma única vez', async () => {
    const { contract, plan } = await seedContractAndPlan();
    await request(app)
      .post(`/api/v2/liminar-contracts/${contract._id}/plans/${plan._id}/generate-sessions`)
      .send({ mode: 'append', weeks: 1 });
    const generated = await Appointment.findOne({ liminarContract: contract._id });
    expect(generated.operationalStatus).toBe('pre_agendado');

    const first = await completeSessionV2(generated._id.toString(), {});
    const second = await completeSessionV2(generated._id.toString(), {});
    expect(first.success).toBe(true);
    expect(second.idempotent).toBe(true);
    expect((await Appointment.findById(generated._id)).operationalStatus).toBe('completed');
    expect((await Session.findById(generated.session)).status).toBe('completed');
    const after = await LiminarContract.findById(contract._id).lean();
    expect(after.usedCredit).toBe(100);
    expect(after.creditBalance).toBe(3900);
    expect(after.creditHistory.filter(item => item.type === 'debit')).toHaveLength(1);
    expect(await Payment.countDocuments({ appointment: generated._id })).toBe(0);
  }, 30_000);

  it('contrato inativo ou sem crédito bloqueia conclusão com zero mutação', async () => {
    const { contract, plan } = await seedContractAndPlan();
    await request(app)
      .post(`/api/v2/liminar-contracts/${contract._id}/plans/${plan._id}/generate-sessions`)
      .send({ mode: 'append', weeks: 1 });
    const generated = await Appointment.findOne({ liminarContract: contract._id });
    await LiminarContract.updateOne({ _id: contract._id }, { $set: { status: 'canceled' } });
    await expect(completeSessionV2(generated._id.toString(), {})).rejects.toThrow();
    expect((await Appointment.findById(generated._id)).operationalStatus).toBe('pre_agendado');
    expect((await LiminarContract.findById(contract._id)).usedCredit).toBe(0);

    await LiminarContract.updateOne({ _id: contract._id }, {
      $set: { status: 'active', creditBalance: 50 },
    });
    await expect(completeSessionV2(generated._id.toString(), {})).rejects.toThrow();
    expect((await Appointment.findById(generated._id)).operationalStatus).toBe('pre_agendado');
    expect((await LiminarContract.findById(contract._id)).usedCredit).toBe(0);
  }, 30_000);

  it('duas tentativas concorrentes de cancelar completed restauram crédito no máximo uma vez', async () => {
    const { contract, plan } = await seedContractAndPlan();
    await request(app)
      .post(`/api/v2/liminar-contracts/${contract._id}/plans/${plan._id}/generate-sessions`)
      .send({ mode: 'append', weeks: 1 });
    const generated = await Appointment.findOne({ liminarContract: contract._id });
    await completeSessionV2(generated._id.toString(), {});

    await Promise.allSettled([
      cancelAppointmentCommand.execute(generated._id, { reason: 'cancelamento concorrente A' }, null),
      cancelAppointmentCommand.execute(generated._id, { reason: 'cancelamento concorrente B' }, null),
    ]);
    const after = await LiminarContract.findById(contract._id).lean();
    expect(after.creditBalance).toBe(4000);
    expect(after.usedCredit).toBe(0);
    expect(after.creditHistory.filter(item =>
      item.type === 'reversal' && String(item.appointmentId) === String(generated._id))).toHaveLength(1);
  }, 30_000);
});
