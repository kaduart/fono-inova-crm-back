/**
 * Teste de Integração - generateInsurancePlanSessions
 *
 * 🎯 Validação: ao gerar sessões de um plano de convênio,
 *    Payment.session deve ser preenchido e apontar para a Session correta.
 *
 * ⚠️ REGRESSÃO: Bug onde Payment era criado sem session vinculada.
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
let Patient, Doctor, Convenio, InsuranceGuide, InsurancePlan, Appointment, Session, Payment, PatientsView;

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
  Payment = (await import('../../models/Payment.js')).default;
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
async function seedData() {
  const patient = await Patient.create({
    fullName: 'Paciente Plano Convênio Teste',
    phone: '62999990001',
    dateOfBirth: new Date('2010-01-15')
  });

  const doctor = await Doctor.create({
    fullName: 'Dr. Plano Convênio Teste',
    specialty: 'fonoaudiologia',
    phoneNumber: '62999990002',
    licenseNumber: 'CRM-GO-99999',
    email: 'dr.plano@convenio.com'
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
    number: 'GUIA-PLANO-001',
    insurance: 'unimed-anapolis',
    patientId: patient._id,
    doctorId: doctor._id,
    specialty: 'fonoaudiologia',
    totalSessions: 4,
    usedSessions: 0,
    status: 'active',
    expiresAt: new Date('2026-12-31')
  });

  const plan = await InsurancePlan.create({
    patient: patient._id,
    guide: guide._id,
    doctor: doctor._id,
    specialty: 'fonoaudiologia',
    totalSessions: 4,
    sessionsPerWeek: 1,
    startDate: new Date('2026-05-04'),
    slots: [
      { dayOfWeek: 1, time: '09:00' } // segunda-feira
    ],
    sessionValue: 80,
    status: 'active'
  });

  return { patient, doctor, guide, plan };
}

// ─── TESTES ──────────────────────────────────────────────────────────────────
describe('🚨 generateInsurancePlanSessions - vínculo Payment.session', () => {
  it('preenche payment.session apontando para a Session correta', async () => {
    const { guide, plan } = await seedData();
    const { generateInsurancePlanSessions } = await import('../../services/schedule/generateInsurancePlanSessions.js');

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

    const appointments = await Appointment.find({ insurancePlan: plan._id }).lean();
    expect(appointments.length).toBeGreaterThan(0);

    for (const appointment of appointments) {
      const payment = await Payment.findOne({ appointment: appointment._id }).lean();
      const session = await Session.findOne({ appointmentId: appointment._id }).lean();

      expect(payment).toBeTruthy();
      expect(session).toBeTruthy();

      // Trinca consistente
      expect(appointment.session?.toString()).toBe(session._id.toString());
      expect(appointment.payment?.toString()).toBe(payment._id.toString());
      expect(session.appointmentId?.toString()).toBe(appointment._id.toString());
      expect(payment.appointment?.toString()).toBe(appointment._id.toString());
      expect(payment.session?.toString()).toBe(session._id.toString());
    }
  }, 30_000);

});
