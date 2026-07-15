/**
 * 🧪 Testes de regressão — Appointment.cancelReason
 *
 * Garante que todo fluxo de cancelamento disparado por usuário grava
 * operationalStatus='canceled' + cancelReason persistido corretamente.
 *
 * Motivação: 4 bugs reais encontrados nesta auditoria usavam nomes de campo
 * inexistentes no schema (canceledReason, cancellationReason, status/cancelledAt
 * em vez de operationalStatus/canceledAt) — o Mongoose descartava o valor
 * silenciosamente, sem erro. Estes testes travam se o padrão se repetir.
 *
 * (workers/cancelOrchestratorWorker.v2.js foi removido em 2026-07-15 — era
 * código morto: consumia a fila `cancel-orchestrator`, mas nada publicava
 * APPOINTMENT_CANCEL_REQUESTED. O fluxo de cancelamento vive só em
 * cancelAppointmentCommand.js, coberto pelos testes abaixo.)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.AGENDA_EXPORT_TOKEN = 'agenda_export_token_test_12345';

vi.mock('../../config/socket.js', () => ({
  getIo: vi.fn().mockReturnValue({ emit: vi.fn() }),
  initializeSocket: vi.fn(),
}));

let Appointment, Session, Package, Doctor, Patient;
let cancelAppointmentCommand, bulkCancelAppointmentsCommand;
let therapyPackageController, convenioPackageController;
let importFromAgendaRouter;

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  // PatientsView precisa ser registrado antes de qualquer model que dependa
  // dele indiretamente (ex: InsuranceGuide → identityResolver → PatientsView).
  await import('../../models/PatientsView.js');

  Appointment = (await import('../../models/Appointment.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Package = (await import('../../models/Package.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Patient = (await import('../../models/Patient.js')).default;

  cancelAppointmentCommand = await import('../../services/appointment/commands/cancelAppointmentCommand.js');
  bulkCancelAppointmentsCommand = await import('../../services/appointment/commands/bulkCancelAppointmentsCommand.js');
  therapyPackageController = await import('../../controllers/therapyPackageController.js');
  convenioPackageController = await import('../../controllers/convenioPackageController.js');
  importFromAgendaRouter = (await import('../../routes/importFromAgenda.js')).default;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Appointment.deleteMany({});
  await Session.deleteMany({});
  await Package.deleteMany({});
  await Doctor.deleteMany({});
  await Patient.deleteMany({});
});

async function createDoctor(overrides = {}) {
  return Doctor.create({
    fullName: 'Dra. Teste',
    email: `doc_${Date.now()}_${Math.random()}@teste.com`,
    phoneNumber: '62999999999',
    licenseNumber: `CRFA-${Math.floor(Math.random() * 100000)}`,
    specialty: 'fonoaudiologia',
    active: true,
    ...overrides,
  });
}

async function createPatient(overrides = {}) {
  return Patient.create({
    fullName: 'Paciente Teste',
    phone: '11999998888',
    dateOfBirth: '1990-05-15',
    ...overrides,
  });
}

async function createAppointment(doctor, patient, overrides = {}) {
  return Appointment.create({
    patient: patient._id,
    doctor: doctor._id,
    date: '2026-02-20',
    time: '10:00',
    specialty: 'fonoaudiologia',
    operationalStatus: 'scheduled',
    duration: 40,
    ...overrides,
  });
}

const FAKE_USER = { _id: new mongoose.Types.ObjectId() };

describe('Cancelamento individual — cancelAppointmentCommand', () => {
  it('grava operationalStatus=canceled e cancelReason', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const appt = await createAppointment(doctor, patient);

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await cancelAppointmentCommand.executeWithSession(
        appt._id,
        { reason: 'Paciente remarcou' },
        FAKE_USER,
        session
      );
    });
    await session.endSession();

    const updated = await Appointment.findById(appt._id);
    expect(updated.operationalStatus).toBe('canceled');
    expect(updated.cancelReason).toBe('Paciente remarcou');
  });

  it('exige reason — rejeita cancelamento sem motivo', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const appt = await createAppointment(doctor, patient);

    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => {
        await cancelAppointmentCommand.executeWithSession(appt._id, {}, FAKE_USER, session);
      })
    ).rejects.toThrow(/motivo do cancelamento/i);
    await session.endSession();
  });
});

describe('Cancelamento em lote — bulkCancelAppointmentsCommand', () => {
  it('grava cancelReason em todos os appointments cancelados', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const appt1 = await createAppointment(doctor, patient);
    const appt2 = await createAppointment(doctor, patient, { time: '11:00' });

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await bulkCancelAppointmentsCommand.executeWithSession(
        [appt1._id, appt2._id],
        { reason: 'Profissional de férias' },
        FAKE_USER,
        session
      );
    });
    await session.endSession();

    const [updated1, updated2] = await Promise.all([
      Appointment.findById(appt1._id),
      Appointment.findById(appt2._id),
    ]);
    expect(updated1.operationalStatus).toBe('canceled');
    expect(updated1.cancelReason).toBe('Profissional de férias');
    expect(updated2.operationalStatus).toBe('canceled');
    expect(updated2.cancelReason).toBe('Profissional de férias');
  });
});

describe('Cancelamento de pacote — therapyPackageController', () => {
  async function createPackageWithAppointment(doctor, patient) {
    const pkg = await Package.create({
      durationMonths: 1,
      sessionsPerWeek: 1,
      patient: patient._id,
      doctor: doctor._id,
      sessionType: 'fonoaudiologia',
      specialty: 'fonoaudiologia',
      date: new Date(),
      totalValue: 400,
      totalSessions: 4,
    });
    const appt = await createAppointment(doctor, patient, { package: pkg._id, serviceType: 'package_session' });
    const sess = await Session.create({
      sessionType: 'fonoaudiologia',
      doctor: doctor._id,
      patient: patient._id,
      package: pkg._id,
      appointmentId: appt._id,
      status: 'scheduled',
    });
    return { pkg, appt, sess };
  }

  function mockRes() {
    const res = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  }

  it('bulkCancelSessions exige reason', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const { pkg, sess } = await createPackageWithAppointment(doctor, patient);

    const req = { params: { id: pkg._id.toString() }, body: { sessionIds: [sess._id.toString()] } };
    const res = mockRes();
    await therapyPackageController.bulkCancelSessions(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('bulkCancelSessions grava cancelReason no appointment vinculado', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const { pkg, appt, sess } = await createPackageWithAppointment(doctor, patient);

    const req = {
      params: { id: pkg._id.toString() },
      body: { sessionIds: [sess._id.toString()], reason: 'Sessões remanescentes canceladas a pedido' },
    };
    const res = mockRes();
    await therapyPackageController.bulkCancelSessions(req, res);

    const updated = await Appointment.findById(appt._id);
    expect(updated.operationalStatus).toBe('canceled');
    expect(updated.cancelReason).toBe('Sessões remanescentes canceladas a pedido');
  });

  it('cancelAllSessions exige reason', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const { pkg } = await createPackageWithAppointment(doctor, patient);

    const req = { params: { id: pkg._id.toString() }, body: {} };
    const res = mockRes();
    await therapyPackageController.cancelAllSessions(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('cancelAllSessions grava cancelReason em todos os appointments do pacote', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const { pkg, appt } = await createPackageWithAppointment(doctor, patient);

    const req = { params: { id: pkg._id.toString() }, body: { reason: 'Pacote cancelado pelo paciente' } };
    const res = mockRes();
    await therapyPackageController.cancelAllSessions(req, res);

    const updated = await Appointment.findById(appt._id);
    expect(updated.operationalStatus).toBe('canceled');
    expect(updated.cancelReason).toBe('Pacote cancelado pelo paciente');
  });
});

describe('Cancelamento de sessão de convênio — convenioPackageController', () => {
  function mockRes() {
    const res = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  }

  async function createConvenioPackageWithAppointment(doctor, patient) {
    const pkg = await Package.create({
      durationMonths: 1,
      sessionsPerWeek: 1,
      patient: patient._id,
      doctor: doctor._id,
      sessionType: 'fonoaudiologia',
      specialty: 'fonoaudiologia',
      date: new Date(),
      totalValue: 0,
      type: 'convenio',
      sessionValue: 0,
    });
    const appt = await createAppointment(doctor, patient, { package: pkg._id, billingType: 'convenio' });
    const sess = await Session.create({
      sessionType: 'fonoaudiologia',
      doctor: doctor._id,
      patient: patient._id,
      package: pkg._id,
      appointmentId: appt._id,
      status: 'scheduled',
    });
    return { pkg, appt, sess };
  }

  it('exige reason', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const { pkg, sess } = await createConvenioPackageWithAppointment(doctor, patient);

    const req = { params: { packageId: pkg._id.toString(), sessionId: sess._id.toString() }, body: {} };
    const res = mockRes();
    await convenioPackageController.cancelConvenioSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('grava cancelReason no appointment vinculado', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const { pkg, appt, sess } = await createConvenioPackageWithAppointment(doctor, patient);

    const req = {
      params: { packageId: pkg._id.toString(), sessionId: sess._id.toString() },
      body: { reason: 'Guia de convênio expirada' },
    };
    const res = mockRes();
    await convenioPackageController.cancelConvenioSession(req, res);

    const updated = await Appointment.findById(appt._id);
    expect(updated.operationalStatus).toBe('canceled');
    expect(updated.cancelReason).toBe('Guia de convênio expirada');
  });
});

describe('Cancelamento via importação externa — POST /api/import-from-agenda/agenda-externa/cancel', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/import-from-agenda', importFromAgendaRouter);
  });

  it('grava cancelReason vindo do payload de sync', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const appt = await createAppointment(doctor, patient);

    const response = await request(app)
      .post('/api/import-from-agenda/agenda-externa/cancel')
      .set('Authorization', `Bearer ${process.env.AGENDA_EXPORT_TOKEN}`)
      .send({ _id: appt._id.toString(), reason: 'Cancelado na agenda externa' });

    expect(response.status).toBe(200);

    const updated = await Appointment.findById(appt._id);
    expect(updated.operationalStatus).toBe('canceled');
    expect(updated.cancelReason).toBe('Cancelado na agenda externa');
  });
});
