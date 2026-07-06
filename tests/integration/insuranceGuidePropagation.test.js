/**
 * Teste de Integração - Propagação de insuranceGuide
 *
 * 🎯 Validação:
 *   1. generateInsurancePlanSessions preenche appointment.insuranceGuide em upserts.
 *   2. syncSessionFromAppointment propaga insuranceGuide para a Session.
 *
 * ⚠️ REGRESSÃO: Sessions de convênio perdiam o vínculo com a guia.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

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
let mongoServer;
let Patient, Doctor, PatientsView, Convenio, InsuranceGuide, InsurancePlan, Appointment, Session;

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
  Session = (await import('../../models/Session.js')).default;
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const cols = mongoose.connection.collections;
  for (const key in cols) await cols[key].deleteMany({});
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function seedGuideAndPlan(overrides = {}) {
  const patient = await Patient.create({
    fullName: 'Paciente Guia Teste',
    phone: '62999990001',
    dateOfBirth: new Date('2010-01-15')
  });

  const doctor = await Doctor.create({
    fullName: 'Dr. Guia Teste',
    specialty: 'fonoaudiologia',
    phoneNumber: '62999990002',
    licenseNumber: 'CRM-GO-99999',
    email: 'dr.guia@convenio.com'
  });

  await Convenio.create({
    code: 'unimed-anapolis',
    name: 'Unimed Anápolis',
    sessionValue: 80,
    active: true,
    guidePolicy: {
      renewalType: 'until_consumed',
      autoSuggestRenewal: false
    }
  });

  const guide = await InsuranceGuide.create({
    number: 'GUIA-GUIDE-001',
    insurance: 'unimed-anapolis',
    patientId: patient._id,
    doctorId: doctor._id,
    specialty: 'fonoaudiologia',
    totalSessions: 4,
    usedSessions: 0,
    status: 'active',
    expiresAt: new Date('2026-12-31')
  });

  // Data futura determinística para garantir que o upsert encontre o appointment pré-existente
  const startDate = new Date();
  startDate.setDate(startDate.getDate() + 7);
  startDate.setHours(0, 0, 0, 0);
  // Ajusta para a próxima segunda-feira
  while (startDate.getDay() !== 1) {
    startDate.setDate(startDate.getDate() + 1);
  }

  const plan = await InsurancePlan.create({
    patient: patient._id,
    guide: guide._id,
    doctor: doctor._id,
    specialty: 'fonoaudiologia',
    totalSessions: 4,
    sessionsPerWeek: 1,
    startDate,
    slots: [
      { dayOfWeek: 1, time: '09:00' }
    ],
    sessionValue: 80,
    status: 'active'
  });

  return { patient, doctor, guide, plan, startDate };

  return { patient, doctor, guide, plan };
}

// ─── TESTES ──────────────────────────────────────────────────────────────────
describe('🚨 Propagação de insuranceGuide', () => {
  it('generateInsurancePlanSessions preenche insuranceGuide em appointments existentes do plano', async () => {
    const { patient, doctor, guide, plan, startDate } = await seedGuideAndPlan();
    const { generateInsurancePlanSessions } = await import('../../services/schedule/generateInsurancePlanSessions.js');

    // Cria um appointment já vinculado ao plano, mas sem insuranceGuide.
    // Usamos um slot diferente do plano para evitar conflito de agenda;
    // o updateMany pós-upsert deve preencher insuranceGuide independentemente.
    const appointmentDate = new Date(startDate);
    appointmentDate.setDate(appointmentDate.getDate() + 1); // terça-feira

    const existingAppointment = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      specialty: 'fonoaudiologia',
      date: appointmentDate,
      time: '10:00',
      duration: 40,
      serviceType: 'session',
      sessionType: 'fonoaudiologia',
      billingType: 'convenio',
      paymentMethod: 'convenio',
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',
      insurancePlan: plan._id
    });

    expect(existingAppointment.insuranceGuide).toBeFalsy();

    const mongoSession = await mongoose.startSession();
    await mongoSession.startTransaction();

    try {
      await generateInsurancePlanSessions({
        planId: plan._id,
        guideId: guide._id,
        sessionValue: 80,
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

    const updatedAppointment = await Appointment.findById(existingAppointment._id).lean();
    expect(updatedAppointment.insuranceGuide?.toString()).toBe(guide._id.toString());
  }, 30_000);

  it('syncSessionFromAppointment propaga insuranceGuide para Session sem sobrescrever com null', async () => {
    const { syncSessionFromAppointment } = await import('../../services/appointmentSessionSyncService.js');

    const patient = await Patient.create({
      fullName: 'Paciente Sync Teste',
      phone: '62999990003',
      dateOfBirth: new Date('2012-02-20')
    });

    const doctor = await Doctor.create({
      fullName: 'Dr. Sync Teste',
      specialty: 'fonoaudiologia',
      phoneNumber: '62999990004',
      licenseNumber: 'CRM-GO-99998',
      email: 'dr.sync@teste.com'
    });

    const guide = await InsuranceGuide.create({
      number: 'GUIA-SYNC-001',
      insurance: 'unimed-anapolis',
      patientId: patient._id,
      doctorId: doctor._id,
      specialty: 'fonoaudiologia',
      totalSessions: 10,
      usedSessions: 0,
      status: 'active',
      expiresAt: new Date('2026-12-31')
    });

    const appointment = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      specialty: 'fonoaudiologia',
      date: new Date('2026-05-10'),
      time: '10:00',
      duration: 40,
      serviceType: 'session',
      sessionType: 'fonoaudiologia',
      billingType: 'convenio',
      paymentMethod: 'convenio',
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',
      insuranceGuide: guide._id
    });

    // Cria Session sem insuranceGuide (simula legado)
    const session = await Session.create({
      patient: patient._id,
      doctor: doctor._id,
      specialty: 'fonoaudiologia',
      date: appointment.date,
      time: appointment.time,
      sessionType: 'fonoaudiologia',
      status: 'scheduled',
      sessionValue: 80,
      paymentMethod: 'convenio',
      paymentStatus: 'pending',
      appointmentId: appointment._id
    });

    expect(session.insuranceGuide).toBeFalsy();

    appointment.session = session._id;
    await appointment.save();

    await syncSessionFromAppointment(appointment);

    const updatedSession = await Session.findById(session._id).lean();
    expect(updatedSession.insuranceGuide?.toString()).toBe(guide._id.toString());

    // Garante que sync sem insuranceGuide não remove um vínculo existente
    appointment.insuranceGuide = undefined;
    await syncSessionFromAppointment(appointment);

    const sessionAfterNullSync = await Session.findById(session._id).lean();
    expect(sessionAfterNullSync.insuranceGuide?.toString()).toBe(guide._id.toString());
  }, 30_000);
});
