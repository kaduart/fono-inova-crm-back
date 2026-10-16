/**
 * 🧪 Cancelamento — solicitante (cancelRequester)
 *
 * Garante que:
 *  - o comando grava cancelRequester/cancelRequestedAt e mantém canceledBy = registrador;
 *  - fluxos manuais de pacote/convênio rejeitam cancelamento sem solicitante;
 *  - PATCH /v2/appointments/:id/cancel exige o solicitante para usuário do CRM, mas
 *    aceita token de serviço (agenda-service) sem ele ("Não informado");
 *  - o relatório conta/percentualiza por solicitante em cima de dados reais.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setLegacyGraceUntilForTests } from '../../domain/appointment/cancelRequester.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_cancel_requester';
process.env.AGENDA_EXPORT_TOKEN = 'agenda_export_token_test_12345';

vi.mock('../../config/socket.js', () => ({
  getIo: vi.fn().mockReturnValue({ emit: vi.fn() }),
  initializeSocket: vi.fn(),
}));

let Appointment, Package, Doctor, Patient, Session;
let cancelAppointmentCommand, therapyPackageController, convenioPackageController;
let getCancellationReport, getCancellationDetails;
let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await import('../../models/PatientsView.js');
  await import('../../models/User.js'); // populate('canceledBy') no detalhamento

  Appointment = (await import('../../models/Appointment.js')).default;
  Package = (await import('../../models/Package.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Patient = (await import('../../models/Patient.js')).default;

  cancelAppointmentCommand = await import('../../services/appointment/commands/cancelAppointmentCommand.js');
  therapyPackageController = await import('../../controllers/therapyPackageController.js');
  convenioPackageController = await import('../../controllers/convenioPackageController.js');
  ({ getCancellationReport, getCancellationDetails } = await import('../../services/analytics/cancellationReport.service.js'));
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

const createDoctor = (o = {}) => Doctor.create({
  fullName: 'Dra. Teste',
  email: `doc_${Date.now()}_${Math.random()}@teste.com`,
  phoneNumber: '62999999999',
  licenseNumber: `CRFA-${Math.floor(Math.random() * 100000)}`,
  specialty: 'fonoaudiologia',
  active: true,
  ...o,
});
const createPatient = (o = {}) => Patient.create({
  fullName: 'Paciente Teste', phone: '11999998888', dateOfBirth: '1990-05-15', ...o,
});
const createAppointment = (doctor, patient, o = {}) => Appointment.create({
  patient: patient._id, doctor: doctor._id, date: '2026-09-10', time: '10:00',
  specialty: 'fonoaudiologia', operationalStatus: 'scheduled', duration: 40, ...o,
});

const REGISTRAR = { _id: new mongoose.Types.ObjectId() };

async function cancelVia(apptId, params) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await cancelAppointmentCommand.executeWithSession(apptId, params, REGISTRAR, session);
    });
  } finally {
    await session.endSession();
  }
}

describe('cancelAppointmentCommand — solicitante', () => {
  it('grava cancelRequester, cancelRequestedAt e mantém canceledBy como registrador', async () => {
    const appt = await createAppointment(await createDoctor(), await createPatient());
    const requestedAt = new Date('2026-09-09T15:00:00.000Z');

    await cancelVia(appt._id, { reason: 'Congresso', cancelRequester: 'professional', cancelRequestedAt: requestedAt });

    const u = await Appointment.findById(appt._id).lean();
    expect(u.operationalStatus).toBe('canceled');
    expect(u.cancelRequester).toBe('professional');
    expect(u.cancelRequestedAt.toISOString()).toBe(requestedAt.toISOString());
    expect(String(u.canceledBy)).toBe(String(REGISTRAR._id));
    const ev = u.history.find((h) => h.action === 'cancelamento');
    expect(ev.details.cancelRequester).toBe('professional');
  });

  it('sem solicitante (fluxo automático/legado) não inventa valor', async () => {
    const appt = await createAppointment(await createDoctor(), await createPatient());
    await cancelVia(appt._id, { reason: 'x', cancelSource: 'guide_closure' });
    const u = await Appointment.findById(appt._id).lean();
    expect(u.cancelRequester ?? null).toBeNull();
    expect(u.cancelRequestedAt ?? null).toBeNull();
  });

  it('cancelRequestedAt assume "agora" quando só o solicitante é informado', async () => {
    const appt = await createAppointment(await createDoctor(), await createPatient());
    await cancelVia(appt._id, { reason: 'x', cancelRequester: 'patient' });
    const u = await Appointment.findById(appt._id).lean();
    expect(u.cancelRequestedAt).toBeInstanceOf(Date);
  });
});

describe('fluxos manuais de pacote/convênio exigem o solicitante', () => {
  beforeAll(() => setLegacyGraceUntilForTests(new Date(0))); // regra final, sem tolerância
  const mockRes = () => {
    const res = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  };

  async function pkgWithAppt(doctor, patient, over = {}) {
    const pkg = await Package.create({
      durationMonths: 1, sessionsPerWeek: 1, patient: patient._id, doctor: doctor._id,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia', date: new Date(),
      totalValue: 400, totalSessions: 4, ...over,
    });
    const appt = await createAppointment(doctor, patient, { package: pkg._id, serviceType: 'package_session' });
    const sess = await Session.create({
      sessionType: 'fonoaudiologia', doctor: doctor._id, patient: patient._id,
      package: pkg._id, appointmentId: appt._id, status: 'scheduled',
    });
    return { pkg, appt, sess };
  }

  it('bulkCancelSessions: 400 sem solicitante; com solicitante grava campos + registrador', async () => {
    const { pkg, appt, sess } = await pkgWithAppt(await createDoctor(), await createPatient());

    const bad = mockRes();
    await therapyPackageController.bulkCancelSessions(
      { params: { id: pkg._id.toString() }, body: { sessionIds: [sess._id.toString()], reason: 'x' }, user: REGISTRAR }, bad);
    expect(bad.status).toHaveBeenCalledWith(400);
    expect((await Appointment.findById(appt._id)).operationalStatus).not.toBe('canceled');

    const ok = mockRes();
    await therapyPackageController.bulkCancelSessions(
      { params: { id: pkg._id.toString() }, body: { sessionIds: [sess._id.toString()], reason: 'x', cancelRequester: 'patient' }, user: REGISTRAR }, ok);
    const u = await Appointment.findById(appt._id).lean();
    expect(u.operationalStatus).toBe('canceled');
    expect(u.cancelRequester).toBe('patient');
    expect(String(u.canceledBy)).toBe(String(REGISTRAR._id));
  });

  it('cancelAllSessions: 400 sem solicitante; 400 com valor inválido', async () => {
    const { pkg, appt } = await pkgWithAppt(await createDoctor(), await createPatient());

    const r1 = mockRes();
    await therapyPackageController.cancelAllSessions({ params: { id: pkg._id.toString() }, body: { reason: 'x' }, user: REGISTRAR }, r1);
    expect(r1.status).toHaveBeenCalledWith(400);

    const r2 = mockRes();
    await therapyPackageController.cancelAllSessions(
      { params: { id: pkg._id.toString() }, body: { reason: 'x', cancelRequester: 'vizinho' }, user: REGISTRAR }, r2);
    expect(r2.status).toHaveBeenCalledWith(400);
    expect((await Appointment.findById(appt._id)).operationalStatus).not.toBe('canceled');
  });

  it('cancelConvenioSession: 400 sem solicitante; grava com solicitante', async () => {
    const doctor = await createDoctor();
    const patient = await createPatient();
    const pkg = await Package.create({
      durationMonths: 1, sessionsPerWeek: 1, patient: patient._id, doctor: doctor._id,
      sessionType: 'fonoaudiologia', specialty: 'fonoaudiologia', date: new Date(),
      totalValue: 0, type: 'convenio', sessionValue: 0,
    });
    const appt = await createAppointment(doctor, patient, { package: pkg._id, billingType: 'convenio' });
    const sess = await Session.create({
      sessionType: 'fonoaudiologia', doctor: doctor._id, patient: patient._id,
      package: pkg._id, appointmentId: appt._id, status: 'scheduled',
    });
    const params = { packageId: pkg._id.toString(), sessionId: sess._id.toString() };

    const bad = mockRes();
    await convenioPackageController.cancelConvenioSession({ params, body: { reason: 'x' }, user: REGISTRAR }, bad);
    expect(bad.status).toHaveBeenCalledWith(400);

    const ok = mockRes();
    await convenioPackageController.cancelConvenioSession({ params, body: { reason: 'x', cancelRequester: 'clinic' }, user: REGISTRAR }, ok);
    const u = await Appointment.findById(appt._id).lean();
    expect(u.operationalStatus).toBe('canceled');
    expect(u.cancelRequester).toBe('clinic');
  });
});

describe('PATCH /v2/appointments/:id/cancel — regra do solicitante', () => {
  let app;

  beforeAll(async () => {
    const router = (await import('../../routes/appointment.v2.js')).default;
    app = express();
    app.use(express.json());
    app.use('/api/v2/appointments', router);
  });

  const userToken = () => jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: 'admin' }, process.env.JWT_SECRET);

  it('usuário do CRM sem solicitante → 400 MISSING_CANCEL_REQUESTER e nada é cancelado (após a transição)', async () => {
    setLegacyGraceUntilForTests(new Date(0));
    const appt = await createAppointment(await createDoctor(), await createPatient());
    const res = await request(app)
      .patch(`/api/v2/appointments/${appt._id}/cancel`)
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ reason: 'x' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/MISSING_CANCEL_REQUESTER|quem solicitou/i);
    expect((await Appointment.findById(appt._id)).operationalStatus).toBe('scheduled');
  });

  it('durante a transição, tela antiga sem solicitante cancela e fica marcada legacy_client', async () => {
    setLegacyGraceUntilForTests(new Date(Date.now() + 3600_000));
    const appt = await createAppointment(await createDoctor(), await createPatient());
    const res = await request(app).patch(`/api/v2/appointments/${appt._id}/cancel`)
      .set('Authorization', `Bearer ${userToken()}`).send({ reason: 'tela antiga' });
    expect(res.status).toBeLessThan(400);
    const u = await Appointment.findById(appt._id).lean();
    expect(u.cancelRequester ?? null).toBeNull();
    expect(u.cancelChannel).toBe('legacy_client');
  });

  it('usuário do CRM com valor inválido → 400', async () => {
    const appt = await createAppointment(await createDoctor(), await createPatient());
    const res = await request(app)
      .patch(`/api/v2/appointments/${appt._id}/cancel`)
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ reason: 'x', cancelRequester: 'vizinho' });
    expect(res.status).toBe(400);
  });

  it('token do agenda-service sem solicitante continua cancelando ("Não informado")', async () => {
    const appt = await createAppointment(await createDoctor(), await createPatient());
    const res = await request(app)
      .patch(`/api/v2/appointments/${appt._id}/cancel`)
      .set('Authorization', `Bearer ${process.env.AGENDA_EXPORT_TOKEN}`)
      .send({ reason: 'cancelado na agenda externa' });
    expect(res.status).toBeLessThan(400);
    const u = await Appointment.findById(appt._id).lean();
    expect(u.operationalStatus).toBe('canceled');
    expect(u.cancelRequester ?? null).toBeNull();
    expect(u.cancelChannel).toBe('agenda_service');
  });
});

describe('relatório sobre dados reais', () => {
  it('conta por solicitante, separa falta/automático e respeita filtros', async () => {
    const docA = await createDoctor({ fullName: 'Dra. Ana' });
    const docB = await createDoctor({ fullName: 'Dr. Bruno' });
    const pat = await createPatient({ fullName: 'Paciente Um' });

    // 6 agendamentos reais em setembro
    const a = [];
    for (let i = 0; i < 6; i++) a.push(await createAppointment(docA, pat, { time: `${8 + i}:00` }));
    const b = await createAppointment(docB, pat, { time: '15:00' });
    // fora da janela
    const out = await createAppointment(docA, pat, { date: '2026-12-01' });

    await cancelVia(a[0]._id, { reason: 'x', cancelRequester: 'patient' });
    await cancelVia(a[1]._id, { reason: 'x', cancelRequester: 'professional' });
    await cancelVia(a[2]._id, { reason: 'x', cancelRequester: 'professional' });
    await cancelVia(a[3]._id, { reason: 'x', cancelSource: 'guide_closure' });      // automático
    // paciente avisou que não virá ("falta confirmada" na UI) → segue sendo cancelamento do paciente
    await cancelVia(a[4]._id, { reason: 'x', cancelRequester: 'patient', confirmedAbsence: true });
    await Appointment.updateOne({ _id: a[5]._id }, { $set: { operationalStatus: 'missed' } }); // no-show
    await cancelVia(out._id, { reason: 'x', cancelRequester: 'patient' });          // fora do período
    await cancelVia(b._id, { reason: 'x' });                                          // não informado

    const report = await getCancellationReport({ startDate: '2026-09-01', endDate: '2026-09-30' });
    // base: 7 agendamentos na janela − 1 automático (a[3]) = 6
    expect(report.summary.totalAppointments).toBe(6);
    expect(report.summary.totalCanceled).toBe(5);       // patient(2) + professional(2) + unspecified(1)
    expect(report.summary.absences).toBe(1);            // só o no-show
    expect(report.summary.automaticCancellations).toBe(1);

    const by = Object.fromEntries(report.byRequester.map((r) => [r.requester, r]));
    expect(by.patient.count).toBe(2);
    expect(by.professional.count).toBe(2);
    expect(by.professional.percent).toBe(40); // 2 de 5
    expect(by.unspecified.count).toBe(1);

    const ana = report.professionals.find((p) => p.name === 'Dra. Ana');
    expect(ana.requestedByProfessional).toBe(2);
    expect(ana.requestedByPatients).toBe(2);

    // filtro por profissional
    const onlyB = await getCancellationReport({ startDate: '2026-09-01', endDate: '2026-09-30', doctorId: String(docB._id) });
    expect(onlyB.summary.totalCanceled).toBe(1);

    // detalhamento
    const items = await getCancellationDetails({ startDate: '2026-09-01', endDate: '2026-09-30', requester: 'professional' });
    expect(items).toHaveLength(2);
    expect(items[0].doctorName).toBe('Dra. Ana');
    expect(items[0].requester).toBe('professional');
    expect(items[0].hoursInAdvance).not.toBeNull();
  });

  it('cancelar → reativar → cancelar de novo: conta 1 AGENDAMENTO (não 2 eventos), com o último solicitante', async () => {
    const doc = await createDoctor({ fullName: 'Dra. Ana' });
    const pat = await createPatient({ fullName: 'Paciente Um' });
    const appt = await createAppointment(doc, pat, { time: '09:00' });

    await cancelVia(appt._id, { reason: 'x', cancelRequester: 'patient' });
    // reativação (mesma limpeza do rescheduleAppointmentCommand)
    await Appointment.updateOne({ _id: appt._id }, { $set: { operationalStatus: 'scheduled', cancelRequester: null, cancelRequestedAt: null } });
    await cancelVia(appt._id, { reason: 'y', cancelRequester: 'professional' });

    const report = await getCancellationReport({ startDate: '2026-09-01', endDate: '2026-09-30' });
    expect(report.summary.totalCanceled).toBe(1);
    expect(report.byRequester.find((r) => r.requester === 'professional').count).toBe(1);
    expect(report.byRequester.find((r) => r.requester === 'patient').count).toBe(0);
  });

  it('"falta confirmada" sem solicitante NÃO vira paciente: fica Não informado', async () => {
    const doc = await createDoctor({ fullName: 'Dra. Ana' });
    const pat = await createPatient({ fullName: 'Paciente Um' });
    const appt = await createAppointment(doc, pat, { time: '10:00' });
    await cancelVia(appt._id, { reason: 'x', confirmedAbsence: true });

    const report = await getCancellationReport({ startDate: '2026-09-01', endDate: '2026-09-30' });
    expect(report.byRequester.find((r) => r.requester === 'unspecified').count).toBe(1);
    expect(report.byRequester.find((r) => r.requester === 'patient').count).toBe(0);
  });

  it('período inválido → erro 400', async () => {
    await expect(getCancellationReport({ startDate: 'x', endDate: '2026-09-30' })).rejects.toMatchObject({ status: 400 });
  });
});
