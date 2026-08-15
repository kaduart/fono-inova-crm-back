import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../middleware/amandaAuth.js', () => ({
  flexibleAuth: (req, _res, next) => { req.user = { _id: new mongoose.Types.ObjectId(), role: 'admin' }; next(); },
}));
vi.mock('../../domains/billing/services/PackageProjectionService.js', () => ({
  buildPackageView: vi.fn().mockResolvedValue({}),
}));

let replSet;
let app;
let Package;
let PackagesView;
let Appointment;
let Session;
let Payment;
let Patient;
let Doctor;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  Package = (await import('../../models/Package.js')).default;
  PackagesView = (await import('../../models/PackagesView.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Payment = (await import('../../models/Payment.js')).default;
  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api/v2/packages', (await import('../../routes/package.v2.js')).default);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
});

async function seedPackage({ paymentType = 'per-session' } = {}) {
  const patient = await Patient.create({ fullName: 'Paciente Package V2', phone: '62999111111', dateOfBirth: '2015-01-01' });
  const doctor = await Doctor.create({
    fullName: 'Dra. Package V2', specialty: 'fonoaudiologia', phoneNumber: '62999222222',
    licenseNumber: `CRM-${Date.now()}`, email: `pkg-${Date.now()}@teste.com`,
  });
  const pkg = await Package.create({
    durationMonths: 1, sessionsPerWeek: 1, patient: patient._id, doctor: doctor._id,
    sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia', sessionValue: 100,
    totalSessions: 4, totalValue: 400, date: new Date('2026-08-20T03:00:00.000Z'), type: 'therapy',
    model: paymentType === 'per-session' ? 'per_session' : 'prepaid', paymentType, status: 'active',
  });
  const view = await PackagesView.create({
    packageId: pkg._id, patientId: patient._id, doctorId: doctor._id,
    type: 'therapy', status: 'active', totalSessions: 4,
  });
  return { patient, doctor, pkg, view };
}

async function seedTrio({ patient, doctor, pkg, status = 'scheduled', date = '2026-08-20', time = '10:00' }) {
  const appointmentId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const paymentId = new mongoose.Types.ObjectId();
  const at = new Date(`${date}T03:00:00.000Z`);
  await Appointment.collection.insertOne({
    _id: appointmentId, patient: patient._id, doctor: doctor._id, package: pkg._id,
    session: sessionId, payment: paymentId, date: at, time, duration: 40,
    specialty: 'fonoaudiologia', serviceType: 'package_session', billingType: 'particular',
    operationalStatus: status, clinicalStatus: status === 'completed' ? 'completed' : 'pending',
    createdAt: new Date(), updatedAt: new Date(),
  });
  await Session.collection.insertOne({
    _id: sessionId, appointmentId, package: pkg._id, patient: patient._id, doctor: doctor._id,
    date: at, time, specialty: 'fonoaudiologia', sessionType: 'fonoaudiologia', status,
    createdAt: new Date(), updatedAt: new Date(),
  });
  await Payment.collection.insertOne({
    _id: paymentId, appointment: appointmentId, session: sessionId, package: pkg._id,
    patient: patient._id, doctor: doctor._id, amount: 100, paymentMethod: 'pix',
    paymentDate: at, status: status === 'completed' ? 'paid' : 'pending', kind: 'session_payment',
    createdAt: new Date(), updatedAt: new Date(),
  });
  return { appointmentId, sessionId, paymentId };
}

describe('Package V2 — guards operacionais', () => {
  it('inativa atomicamente o conjunto pendente e preserva histórico completed/pago', async () => {
    const base = await seedPackage();
    const pending = await seedTrio(base);
    const completed = await seedTrio({ ...base, status: 'completed', date: '2026-08-21', time: '11:00' });

    const response = await request(app).post(`/api/v2/packages/${base.view._id}/inactivate`).expect(200);
    expect(response.body.success).toBe(true);

    expect((await Package.findById(base.pkg._id)).status).toBe('canceled');
    expect((await Appointment.findById(pending.appointmentId)).operationalStatus).toBe('canceled');
    expect((await Session.findById(pending.sessionId)).status).toBe('canceled');
    expect((await Payment.findById(pending.paymentId)).status).toBe('canceled');
    expect((await Appointment.findById(completed.appointmentId)).operationalStatus).toBe('completed');
    expect((await Session.findById(completed.sessionId)).status).toBe('completed');
    expect((await Payment.findById(completed.paymentId)).status).toBe('paid');
  });

  it.each(['full', 'prepaid', 'partial'])(
    'bloqueia inativacao de paymentType=%s com 409 e zero mutacao',
    async (paymentType) => {
      const base = await seedPackage({ paymentType });
      const target = await seedTrio(base);

      const before = {
        package: (await Package.findById(base.pkg._id)).toObject(),
        appointment: (await Appointment.findById(target.appointmentId)).toObject(),
        session: (await Session.findById(target.sessionId)).toObject(),
        payment: (await Payment.findById(target.paymentId)).toObject(),
      };

      const response = await request(app)
        .post(`/api/v2/packages/${base.view._id}/inactivate`)
        .expect(409);

      expect(response.body.error.code).toBe('PACKAGE_INACTIVATION_REQUIRES_PER_SESSION');
      expect((await Package.findById(base.pkg._id)).toObject()).toEqual(before.package);
      expect((await Appointment.findById(target.appointmentId)).toObject()).toEqual(before.appointment);
      expect((await Session.findById(target.sessionId)).toObject()).toEqual(before.session);
      expect((await Payment.findById(target.paymentId)).toObject()).toEqual(before.payment);
    }
  );

  it('bulk detecta conflito externo antes de qualquer escrita', async () => {
    const base = await seedPackage();
    const target = await seedTrio(base);
    await Appointment.collection.insertOne({
      _id: new mongoose.Types.ObjectId(), patient: new mongoose.Types.ObjectId(), doctor: base.doctor._id,
      date: new Date('2026-08-20T03:00:00.000Z'), time: '11:00', duration: 40,
      specialty: 'fonoaudiologia', serviceType: 'individual_session', billingType: 'particular',
      operationalStatus: 'scheduled', clinicalStatus: 'pending', createdAt: new Date(), updatedAt: new Date(),
    });

    const response = await request(app)
      .patch(`/api/v2/packages/${base.view._id}/appointments/bulk`)
      .send({ time: '11:00' })
      .expect(409);
    expect(response.body.code).toBe('BULK_SCHEDULE_CONFLICT');
    expect((await Appointment.findById(target.appointmentId)).time).toBe('10:00');
    expect((await Session.findById(target.sessionId)).time).toBe('10:00');
  });

  it('bulk sincroniza Appointment, Session e Payment quando não há conflito', async () => {
    const base = await seedPackage();
    const target = await seedTrio(base);
    const newDoctor = await Doctor.create({
      fullName: 'Dr. Destino', specialty: 'fonoaudiologia', phoneNumber: '62999333333',
      licenseNumber: `CRM-D-${Date.now()}`, email: `dest-${Date.now()}@teste.com`,
    });

    await request(app)
      .patch(`/api/v2/packages/${base.view._id}/appointments/bulk`)
      .send({ doctorId: newDoctor._id.toString(), time: '12:00' })
      .expect(200);

    expect((await Appointment.findById(target.appointmentId)).doctor.toString()).toBe(newDoctor._id.toString());
    expect((await Appointment.findById(target.appointmentId)).time).toBe('12:00');
    expect((await Session.findById(target.sessionId)).doctor.toString()).toBe(newDoctor._id.toString());
    expect((await Session.findById(target.sessionId)).time).toBe('12:00');
    expect((await Payment.findById(target.paymentId)).doctor.toString()).toBe(newDoctor._id.toString());
  });
});
