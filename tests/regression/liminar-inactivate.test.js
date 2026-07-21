/**
 * 🧪 Regressão — PR3: POST /v2/liminar-contracts/:id/inactivate
 *
 * Cobre os 4 cenários mínimos combinados para o PR3:
 * 1. Contrato ativo com sessões futuras -> cancela pendências, saldo inalterado
 * 2. Contrato sem sessões pendentes -> só muda status
 * 3. Contrato já cancelado -> erro
 * 4. Contrato com sessões completed -> completed preservada, só pendente é afetada
 *
 * Trava também o invariante da decisão de arquitetura (2026-07-17): crédito só é
 * debitado em COMPLETE_SESSION, então inativar contrato NUNCA mexe em
 * totalCredit/usedCredit/creditBalance.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';

let mongoServer, app;
let Patient, Doctor, LiminarContract, Session, Payment, Appointment;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  await import('../../models/PatientsView.js');

  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  LiminarContract = (await import('../../models/LiminarContract.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Payment = (await import('../../models/Payment.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;

  app = express();
  app.use(express.json());
  app.use('/api/v2/liminar-contracts', (await import('../../routes/liminarContract.js')).default);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const collections = ['appointments', 'sessions', 'payments', 'liminarcontracts', 'patients', 'doctors'];
  for (const name of collections) {
    try { await mongoose.connection.collection(name).deleteMany({}); } catch (e) { /* ignore */ }
  }
});

async function createPatient() {
  return Patient.create({ fullName: 'Paciente Liminar PR3', phone: '62999999999', dateOfBirth: '2015-01-01' });
}

async function createDoctor() {
  const suffix = Math.random().toString(36).substring(7);
  return Doctor.create({
    fullName: 'Dr. Liminar PR3',
    specialty: 'fonoaudiologia',
    email: `dr_${suffix}@teste.com`,
    licenseNumber: `CRM-${suffix}`,
    phoneNumber: '62999999999',
  });
}

async function createContract(patient, doctor, overrides = {}) {
  return LiminarContract.create({
    patient: patient._id,
    doctor: doctor._id,
    totalCredit: 5000,
    creditBalance: 5000,
    usedCredit: 0,
    ...overrides,
  });
}

describe('PR3 — POST /v2/liminar-contracts/:id/inactivate', () => {
  it('cenário 1: contrato ativo com sessão futura pendente -> cancela pendência e mantém crédito intacto', async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();
    const contract = await createContract(patient, doctor);

    const futureAppt = await Appointment.create({
      patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
      date: new Date('2026-09-20'), time: '10:00', duration: 40, specialty: 'fonoaudiologia',
      serviceType: 'individual_session', operationalStatus: 'scheduled', clinicalStatus: 'pending',
      paymentOrigin: 'liminar', billingType: 'liminar', sessionValue: 160, liminarContract: contract._id,
    });
    const futureSession = await Session.create({
      patient: patient._id, doctor: doctor._id, appointmentId: futureAppt._id,
      status: 'scheduled', sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date('2026-09-20'), time: '10:00', sessionValue: 160,
    });
    const pendingPayment = await Payment.create({
      patient: patient._id, appointment: futureAppt._id, liminarContract: contract._id,
      status: 'pending', kind: 'appointment_payment', amount: 160,
      paymentDate: new Date('2026-09-20'), paymentMethod: 'liminar_credit',
    });

    const res = await request(app).post(`/api/v2/liminar-contracts/${contract._id}/inactivate`).send();
    expect(res.status).toBe(200);
    expect(res.body.sessionsCanceled).toBe(1);
    expect(res.body.appointmentsCanceled).toBe(1);
    expect(res.body.paymentsCanceled).toBe(1);

    const contractAfter = await LiminarContract.findById(contract._id).lean();
    expect(contractAfter.status).toBe('canceled');
    expect(contractAfter.totalCredit).toBe(5000);
    expect(contractAfter.creditBalance).toBe(5000); // 🔒 nunca mexe no crédito
    expect(contractAfter.usedCredit).toBe(0);

    const apptAfter = await Appointment.findById(futureAppt._id).lean();
    expect(apptAfter.operationalStatus).toBe('canceled');

    const sessionAfter = await Session.findById(futureSession._id).lean();
    expect(sessionAfter.status).toBe('canceled');

    const paymentAfter = await Payment.findById(pendingPayment._id).lean();
    expect(paymentAfter.status).toBe('canceled');
  });

  it('cenário 2: contrato sem sessões pendentes -> só muda status', async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();
    const contract = await createContract(patient, doctor);

    const res = await request(app).post(`/api/v2/liminar-contracts/${contract._id}/inactivate`).send();
    expect(res.status).toBe(200);
    expect(res.body.sessionsCanceled).toBe(0);
    expect(res.body.appointmentsCanceled).toBe(0);
    expect(res.body.paymentsCanceled).toBe(0);

    const contractAfter = await LiminarContract.findById(contract._id).lean();
    expect(contractAfter.status).toBe('canceled');
  });

  it('cenário 3: contrato já cancelado -> retorna erro', async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();
    const contract = await createContract(patient, doctor, { status: 'canceled' });

    const res = await request(app).post(`/api/v2/liminar-contracts/${contract._id}/inactivate`).send();
    expect(res.status).toBe(400);
  });

  it('cenário 4: sessão completed é preservada, só a pendente é cancelada', async () => {
    const patient = await createPatient();
    const doctor = await createDoctor();
    const contract = await createContract(patient, doctor);

    const completedAppt = await Appointment.create({
      patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
      date: new Date('2026-01-10'), time: '09:00', duration: 40, specialty: 'fonoaudiologia',
      serviceType: 'individual_session', operationalStatus: 'completed', clinicalStatus: 'completed',
      paymentOrigin: 'liminar', billingType: 'liminar', sessionValue: 160, liminarContract: contract._id,
      _fromCompleteService: true,
    });
    await Session.create({
      patient: patient._id, doctor: doctor._id, appointmentId: completedAppt._id,
      status: 'completed', sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date('2026-01-10'), time: '09:00', sessionValue: 160,
    });

    const pendingAppt = await Appointment.create({
      patient: patient._id, patientName: patient.fullName, doctor: doctor._id,
      date: new Date('2026-09-20'), time: '10:00', duration: 40, specialty: 'fonoaudiologia',
      serviceType: 'individual_session', operationalStatus: 'scheduled', clinicalStatus: 'pending',
      paymentOrigin: 'liminar', billingType: 'liminar', sessionValue: 160, liminarContract: contract._id,
    });
    await Session.create({
      patient: patient._id, doctor: doctor._id, appointmentId: pendingAppt._id,
      status: 'scheduled', sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia',
      date: new Date('2026-09-20'), time: '10:00', sessionValue: 160,
    });

    const res = await request(app).post(`/api/v2/liminar-contracts/${contract._id}/inactivate`).send();
    expect(res.status).toBe(200);
    expect(res.body.appointmentsCanceled).toBe(1);

    const completedAfter = await Appointment.findById(completedAppt._id).lean();
    expect(completedAfter.operationalStatus).toBe('completed');

    const pendingAfter = await Appointment.findById(pendingAppt._id).lean();
    expect(pendingAfter.operationalStatus).toBe('canceled');
  });
});
