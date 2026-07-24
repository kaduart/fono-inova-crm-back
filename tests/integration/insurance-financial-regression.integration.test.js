/**
 * Integration Test — Insurance financial regression
 *
 * Valida ponta a ponta as invariantes que impedem a duplicação de
 * Payments de convênio e garantem cancelamento limpo:
 *
 * 1. Session pré-criada com um Payment ativo de convênio.
 * 2. Completar a sessão (via ConvenioHandler) reutiliza o Payment existente.
 * 3. Completar novamente (simulando retry/reentrancy) ainda mantém 1 Payment.
 * 4. Cancelar o appointment cancela o Payment vinculado à session.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import '../../models/index.js';

vi.mock('../../config/socket.js', () => ({
  getIo: () => ({ emit: () => {}, to: () => ({ emit: () => {} }) }),
  initializeSocket: () => {}
}));

vi.mock('../../config/redisConnection.js', () => ({
  redisConnection: { status: 'ready', on: () => {} }
}));

vi.mock('../../services/syncService.js', () => ({
  syncEvent: async () => {}
}));

vi.mock('../../services/projections/syncAffectedViews.js', () => ({
  syncAffectedViews: async () => {}
}));

vi.mock('../../infrastructure/outbox/outboxPattern.js', () => ({
  saveToOutbox: async () => ({})
}));

let mongoServer;
let Patient, Doctor, InsuranceGuide, Session, Appointment, Payment;
let ConvenioHandler;
let cancelAppointment;

async function loadModels() {
  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  InsuranceGuide = (await import('../../models/InsuranceGuide.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  Payment = (await import('../../models/Payment.js')).default;

  const completeSession = await import('../../services/completeSession/index.js');
  ConvenioHandler = completeSession.ConvenioHandler;

  const cancelModule = await import('../../services/appointment/commands/cancelAppointmentCommand.js');
  cancelAppointment = cancelModule.executeWithSession;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await loadModels();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const cols = mongoose.connection.collections;
  for (const key in cols) await cols[key].deleteMany({});
});

async function seedGuide(patient, doctor) {
  return InsuranceGuide.create({
    number: `GUIDE-${Date.now()}`,
    patientId: patient._id,
    specialty: 'fonoaudiologia',
    insurance: 'unimed',
    totalSessions: 10,
    usedSessions: 0,
    status: 'active',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    sessionValue: 140
  });
}

async function seedAppointment(session, guide, patient, doctor) {
  return Appointment.create({
    patient: patient._id,
    doctor: doctor._id,
    specialty: 'fonoaudiologia',
    date: session.date,
    time: session.time,
    operationalStatus: 'scheduled',
    billingType: 'convenio',
    paymentMethod: 'convenio',
    insuranceProvider: 'unimed',
    insuranceGuide: guide._id,
    session: session._id
  });
}

async function seedSession(patient, doctor, guide) {
  return Session.create({
    patient: patient._id,
    doctor: doctor._id,
    sessionType: 'fonoaudiologia',
    serviceType: 'session',
    date: new Date(),
    time: '10:00',
    status: 'scheduled',
    insuranceGuide: guide._id,
    sessionValue: 140
  });
}

async function seedPayment(appointment, session, patient, guide) {
  return Payment.create({
    patient: patient._id,
    appointment: appointment._id,
    session: session._id,
    amount: 140,
    paymentDate: new Date(),
    paymentMethod: 'convenio',
    billingType: 'convenio',
    status: 'pending',
    insurance: {
      provider: 'unimed',
      status: 'pending_billing',
      grossAmount: 140,
      guideId: guide._id
    },
    kind: 'session_payment',
    description: 'Pré-criado no schedule'
  });
}

async function completeWithConvenio(appointment, session, guide) {
  const appointmentUpdate = { $set: {} };
  const ctx = {
    appointment: {
      _id: appointment._id,
      patient: { _id: appointment.patient },
      doctor: { _id: appointment.doctor },
      specialty: appointment.specialty,
      insuranceGuide: guide._id,
      insuranceProvider: 'unimed',
      payment: appointment.payment
    },
    sessionId: session._id,
    sessionValue: guide.sessionValue || 140,
    appointmentId: appointment._id,
    mongoSession: null,
    userId: new mongoose.Types.ObjectId()
  };
  await ConvenioHandler.buildPayment(appointmentUpdate, ctx);
  return appointmentUpdate;
}

describe('Insurance financial regression', () => {
  it('não cria duplicata de Payment ao completar sessão e cancelamento limpa o Payment', async () => {
    const patient = await Patient.create({ fullName: 'Paciente Teste' });
    const doctor = await Doctor.create({
      fullName: 'Dr. Teste',
      email: `dr${Date.now()}@test.com`,
      specialty: 'fonoaudiologia',
      licenseNumber: `CRM-${Date.now()}`,
      phoneNumber: '62999999999',
      day: 'monday'
    });
    const guide = await seedGuide(patient, doctor);
    const session = await seedSession(patient, doctor, guide);
    const appointment = await seedAppointment(session, guide, patient, doctor);
    const payment = await seedPayment(appointment, session, patient, guide);

    // Atualiza appointment.payment para apontar para o Payment pré-criado
    appointment.payment = payment._id;
    await appointment.save();

    // 1. Primeira completação deve reutilizar o Payment existente
    await completeWithConvenio(appointment, session, guide);
    let payments = await Payment.find({ session: session._id, billingType: 'convenio' });
    expect(payments).toHaveLength(1);
    expect(payments[0]._id.toString()).toBe(payment._id.toString());
    expect(payments[0].status).toBe('pending');
    expect(payments[0].insurance.status).toBe('pending_billing');

    // 2. Segunda completação (simula retry/reativação) deve manter 1 Payment
    await completeWithConvenio(appointment, session, guide);
    payments = await Payment.find({ session: session._id, billingType: 'convenio' });
    expect(payments).toHaveLength(1);

    // 3. Criar um segundo appointment para a mesma session não deve gerar Payment extra
    const appointment2 = await Appointment.create({
      patient: patient._id,
      doctor: doctor._id,
      specialty: 'fonoaudiologia',
      date: new Date(Date.now() + 86400000),
      time: '11:00',
      operationalStatus: 'scheduled',
      billingType: 'convenio',
      paymentMethod: 'convenio',
      insuranceProvider: 'unimed',
      insuranceGuide: guide._id,
      session: session._id
    });
    await completeWithConvenio(appointment2, session, guide);
    payments = await Payment.find({ session: session._id, billingType: 'convenio' });
    expect(payments).toHaveLength(1);

    // 4. Cancelamento do appointment deve cancelar o Payment vinculado à session
    const mongoSession = await mongoose.startSession();
    await mongoSession.withTransaction(async () => {
      await cancelAppointment(appointment._id, { reason: 'Teste de regressão', confirmedAbsence: false }, null, mongoSession);
    });
    await mongoSession.endSession();

    const canceledPayment = await Payment.findById(payment._id);
    expect(canceledPayment.status).toBe('canceled');
  });
});
