/**
 * Inativar paciente cancela as sessões futuras (Kadu, 11/11/2026).
 * Paciente inativo continuava aparecendo na agenda do dia seguinte.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';

vi.mock('../../config/socket.js', () => ({
  getIo: vi.fn().mockReturnValue({ emit: vi.fn() }),
  initializeSocket: vi.fn(),
}));
vi.mock('../../middleware/amandaAuth.js', () => ({
  flexibleAuth: (req, _res, next) => {
    req.user = { id: String(new mongoose.Types.ObjectId()), role: req.headers['x-role'] || 'secretary', name: 'Recepção' };
    next();
  },
}));
vi.mock('../../domains/clinical/services/patientProjectionService.js', () => ({
  buildPatientView: vi.fn().mockResolvedValue(null),
}));

let Appointment, Doctor, Patient, app, mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await import('../../models/PatientsView.js');
  Appointment = (await import('../../models/Appointment.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Patient = (await import('../../models/Patient.js')).default;
  await Appointment.createCollection();
  await Patient.createCollection();
  const router = (await import('../../routes/patient.v2.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api/v2/patients', router);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Appointment.deleteMany({});
  await Doctor.deleteMany({});
  await Patient.deleteMany({});
});

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function seed() {
  const doctor = await Doctor.create({
    fullName: 'Dra. Teste', email: `doc_${Date.now()}@teste.com`, phoneNumber: '62999999999',
    licenseNumber: `CRFA-${Math.floor(Math.random() * 100000)}`, specialty: 'fonoaudiologia', active: true,
  });
  const patient = await Patient.create({ fullName: 'Paciente Teste', phone: '11999998888', dateOfBirth: '2018-05-15' });
  const base = { patient: patient._id, doctor: doctor._id, specialty: 'fonoaudiologia', duration: 40, time: '09:20' };
  const future = await Appointment.create({ ...base, date: day(2), operationalStatus: 'scheduled' });
  const pre = await Appointment.create({ ...base, date: day(9), operationalStatus: 'pre_agendado' });
  const past = await Appointment.create({ ...base, date: day(-7), operationalStatus: 'scheduled' });
  return { patient, future, pre, past };
}

describe('PATCH /api/v2/patients/:id/status', () => {
  it('ao inativar, cancela as sessões futuras e deixa as passadas', async () => {
    const { patient, future, pre, past } = await seed();
    const res = await request(app).patch(`/api/v2/patients/${patient._id}/status`).send({ status: 'inactive', reason: 'outro' });
    expect(res.status).toBe(200);
    expect(res.body.data.canceledFutureAppointments).toBe(2);
    expect(res.body.data.futureAppointments).toBe(0);

    const [f, p, old, pat] = await Promise.all([
      Appointment.findById(future._id).lean(), Appointment.findById(pre._id).lean(),
      Appointment.findById(past._id).lean(), Patient.findById(patient._id).lean(),
    ]);
    expect(f.operationalStatus).toBe('canceled');
    expect(f.cancelSource).toBe('patient_inactivated');
    expect(f.cancelReason).toMatch(/Paciente inativado: Outro/);
    expect(p.operationalStatus).toBe('canceled');
    expect(old.operationalStatus).toBe('scheduled');
    expect(pat.status).toBe('inactive');
  });

  it('cancelFutureAppointments=false mantém a agenda', async () => {
    const { patient, future } = await seed();
    const res = await request(app).patch(`/api/v2/patients/${patient._id}/status`)
      .send({ status: 'inactive', reason: 'financeiro', cancelFutureAppointments: false });
    expect(res.status).toBe(200);
    expect(res.body.data.canceledFutureAppointments).toBe(0);
    expect(res.body.data.futureAppointments).toBe(2);
    expect((await Appointment.findById(future._id).lean()).operationalStatus).toBe('scheduled');
  });

  it('reativar não mexe na agenda', async () => {
    const { patient, future } = await seed();
    await Patient.updateOne({ _id: patient._id }, { $set: { status: 'inactive' } });
    const res = await request(app).patch(`/api/v2/patients/${patient._id}/status`).send({ status: 'active' });
    expect(res.status).toBe(200);
    expect((await Appointment.findById(future._id).lean()).operationalStatus).toBe('scheduled');
  });
});
