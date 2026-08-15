/**
 * E2E Test — "Concluir" pelo card da guia de Convênio (2026-08-15)
 *
 * 🎯 Achado real do review: appointments de convênio nascem `pre_agendado`
 * (invariante #1, DOMAIN_INVARIANTS.md — gerados por
 * generateInsurancePlanSessions.js/replanInsurancePlanSessions.js), mas
 * completeInsuranceAppointmentCommand (orquestrador chamado por
 * PATCH /v2/appointments/:id/complete pra convênio) só sabia normalizar
 * `canceled`/`scheduled` — `pre_agendado` caía direto no guard final como
 * 422 INVALID_STATE. Ou seja: o botão "Concluir" pelo card falharia pra
 * QUALQUER sessão recém-gerada, o caso mais comum, não uma exceção.
 *
 * Este teste prova, com banco real (MongoMemoryReplSet, sem mock de
 * completeSessionV2/ConvenioHandler), que:
 *  - pre_agendado → completed funciona de ponta a ponta
 *  - InsuranceGuide.usedSessions incrementa exatamente 1x
 *  - Appointment/Session ficam coerentes
 *  - retry (duplo-clique) no appointment já completed é idempotente —
 *    usedSessions NÃO incrementa de novo
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

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
vi.mock('../../services/journeyFollowupEngine.js', () => ({ runJourneyFollowups: async () => {} }));
vi.mock('../../services/syncService.js', () => ({ syncEvent: async () => {} }));

let mongoServer;
let Patient, Doctor, Convenio, InsuranceGuide, Appointment, Session, Payment;
let completeInsuranceAppointmentCommand;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Convenio = (await import('../../models/Convenio.js')).default;
  InsuranceGuide = (await import('../../models/InsuranceGuide.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Payment = (await import('../../models/Payment.js')).default;

  completeInsuranceAppointmentCommand = await import('../../services/appointment/commands/completeInsuranceAppointmentCommand.js');
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const cols = mongoose.connection.collections;
  for (const key in cols) await cols[key].deleteMany({});
});

async function seedPatientAndDoctor(suffix = '') {
  const patient = await Patient.create({
    fullName: `Paciente Card Teste ${suffix}`,
    phone: `6298888${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
    dateOfBirth: new Date('2016-01-01')
  });
  const doctor = await Doctor.create({
    fullName: `Dra. Card Teste ${suffix}`,
    specialty: 'terapia_ocupacional',
    phoneNumber: `6298887${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
    licenseNumber: `CRM-GO-${Math.floor(Math.random() * 90000) + 10000}`,
    email: `dra.card.${Date.now()}.${Math.random()}@teste.com`
  });
  await Convenio.findOneAndUpdate(
    { code: 'unimed-card-teste' },
    { code: 'unimed-card-teste', name: 'Unimed Card Teste', sessionValue: 80, active: true },
    { upsert: true }
  );
  return { patient, doctor };
}

async function seedGuide({ patient, doctor, totalSessions = 10, usedSessions = 0 }) {
  return InsuranceGuide.create({
    number: `GUIA-CARD-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    insurance: 'unimed-card-teste',
    patientId: patient._id,
    doctorId: doctor._id,
    specialty: 'terapia_ocupacional',
    totalSessions,
    usedSessions,
    sessionValue: 80,
    status: 'active',
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 180)
  });
}

/** Trio exatamente como generateInsurancePlanSessions.js/replanInsurancePlanSessions.js
 *  criam de verdade — pre_agendado, Payment pending/pending_billing. */
async function seedPreAgendadoTrio({ patient, doctor, guide }) {
  const date = new Date(); date.setDate(date.getDate() + 7); date.setHours(0, 0, 0, 0);
  const appointment = await Appointment.create({
    patient: patient._id,
    doctor: doctor._id,
    specialty: 'terapia_ocupacional',
    date,
    time: '15:20',
    duration: 40,
    billingType: 'convenio',
    paymentMethod: 'convenio',
    insuranceGuide: guide._id,
    insuranceProvider: guide.insurance,
    sessionValue: 80,
    insuranceValue: 80,
    operationalStatus: 'pre_agendado',
    clinicalStatus: 'pending',
    status: 'pre_agendado',
    paymentStatus: 'pending_receipt',
    serviceType: 'session',
    sessionType: 'terapia_ocupacional',
    metadata: { origin: { source: 'insurance_plan' } }
  });

  const session = await Session.create({
    patient: patient._id,
    doctor: doctor._id,
    specialty: 'terapia_ocupacional',
    date,
    time: '15:20',
    sessionType: 'terapia_ocupacional',
    serviceType: 'session',
    sessionValue: 80,
    appointmentId: appointment._id,
    appointment: appointment._id,
    paymentMethod: 'convenio',
    status: 'scheduled',
    isPaid: false,
    insuranceGuide: guide._id
  });

  const payment = await Payment.create({
    patient: patient._id,
    doctor: doctor._id,
    appointment: appointment._id,
    session: session._id,
    specialty: 'terapia_ocupacional',
    amount: 0,
    paymentDate: date,
    paymentMethod: 'convenio',
    billingType: 'convenio',
    status: 'pending',
    insurance: { provider: guide.insurance, status: 'pending_billing', grossAmount: 80 },
    insuranceGuide: guide._id,
    kind: 'session_payment'
  });

  await Appointment.findByIdAndUpdate(appointment._id, { session: session._id, payment: payment._id });
  return {
    appointment: await Appointment.findById(appointment._id).lean(),
    session: await Session.findById(session._id).lean(),
    payment: await Payment.findById(payment._id).lean()
  };
}

describe('Concluir pelo card (Convênio) — pre_agendado → completed', () => {
  it('completa appointment pre_agendado de ponta a ponta e consome a guia exatamente 1x', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('pre-agendado');
    const guide = await seedGuide({ patient, doctor, totalSessions: 10, usedSessions: 0 });
    const trio = await seedPreAgendadoTrio({ patient, doctor, guide });

    const result = await completeInsuranceAppointmentCommand.execute(trio.appointment._id, { userId: doctor._id });

    expect(result.success).toBe(true);
    expect(result.idempotent).toBeFalsy();
    // 3 transições: pre_agendado→scheduled→confirmed→completed
    expect(result.transitions.map(t => `${t.from}→${t.to}`)).toEqual([
      'pre_agendado→scheduled',
      'scheduled→confirmed',
      'confirmed→completed',
    ]);

    const apptAfter = await Appointment.findById(trio.appointment._id).lean();
    expect(apptAfter.operationalStatus).toBe('completed');
    expect(apptAfter._id.toString()).toBe(trio.appointment._id.toString()); // mesmo ID, nunca recriado

    const sessionAfter = await Session.findById(trio.session._id).lean();
    expect(sessionAfter.status).toBe('completed');
    expect(sessionAfter._id.toString()).toBe(trio.session._id.toString());

    const paymentAfter = await Payment.findById(trio.payment._id).lean();
    expect(paymentAfter._id.toString()).toBe(trio.payment._id.toString()); // reaproveitado, não duplicado
    const totalPayments = await Payment.countDocuments({ appointment: trio.appointment._id });
    expect(totalPayments).toBe(1); // nunca cria um segundo Payment

    const guideAfter = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfter.usedSessions).toBe(1); // consumida exatamente 1x
  }, 30_000);

  it('retry (duplo-clique) no appointment já completed é idempotente — usedSessions NÃO incrementa de novo', async () => {
    const { patient, doctor } = await seedPatientAndDoctor('retry');
    const guide = await seedGuide({ patient, doctor, totalSessions: 10, usedSessions: 0 });
    const trio = await seedPreAgendadoTrio({ patient, doctor, guide });

    const first = await completeInsuranceAppointmentCommand.execute(trio.appointment._id, { userId: doctor._id });
    expect(first.success).toBe(true);

    const guideAfterFirst = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfterFirst.usedSessions).toBe(1);

    // Segunda chamada — mesmo appointment, já completed (duplo-clique/retry de rede)
    const second = await completeInsuranceAppointmentCommand.execute(trio.appointment._id, { userId: doctor._id });
    expect(second.success).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(second.transitions).toEqual([]); // nenhuma transição de estado na segunda vez

    const guideAfterSecond = await InsuranceGuide.findById(guide._id).lean();
    expect(guideAfterSecond.usedSessions).toBe(1); // continua 1, nunca 2

    const totalPayments = await Payment.countDocuments({ appointment: trio.appointment._id });
    expect(totalPayments).toBe(1); // nenhum Payment duplicado pela segunda chamada
  }, 30_000);
});
