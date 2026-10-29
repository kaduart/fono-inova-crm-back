import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';

vi.mock('../../middleware/auth.js', () => ({ auth: (_req, _res, next) => next() }));
vi.mock('../../services/syncService.js', () => ({ syncEvent: async () => {}, handlePackageSessionUpdate: async () => {} }));
vi.mock('../../services/provisionamentoService.js', () => ({ default: {} }));
vi.mock('../../services/completeSessionService.v2.js', () => ({ completeSessionV2: () => { throw Error('Completação proibida neste teste'); } }));
vi.mock('../../services/auditLogService.js', () => ({ recordAudit: async () => {}, pickInsurancePlanFields: x => x, getInsurancePlanAuditTrail: async () => [] }));
vi.mock('../../services/appointment/commands/bulkCancelAppointmentsCommand.js', () => ({ executeWithSession: () => { throw Error('Cancelamento de registros existentes proibido nesta massa'); } }));
vi.mock('../../services/appointment/commands/restoreCanceledAppointmentCommand.js', () => ({ executeWithSession: () => { throw Error('Reativação de cancelados proibida neste teste'); } }));
vi.mock('../../config/redisConnection.js', () => ({ redisConnection: { status: 'ready', on() {} } }));
vi.mock('../../config/bullConfig.js', () => ({ followupQueue: { add: async () => {}, on() {} }, followupEvents: { on() {} }, videoGenerationQueue: { add: async () => {}, on() {} }, videoGenerationEvents: { on() {} } }));
vi.mock('../../services/journeyFollowupEngine.js', () => ({ runJourneyFollowups: async () => {} }));
vi.mock('../../config/socket.js', () => ({ getIo: () => ({ emit() {}, to: () => ({ emit() {} }) }), initializeSocket() {} }));

let server, app, Patient, Doctor, Contract, Plan, Appointment, Session, Payment, Guide, InsurancePlan, actor;
const report = { tests: [], localOnly: true, productionConnections: 0 };
const date = offset => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((2 - d.getUTCDay() + 7) % 7 || 7) + offset); return d.toISOString().slice(0, 10); };
beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ binary: process.env.MONGOMS_SYSTEM_BINARY ? { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } : {}, replSet: { count: 1 }, instanceOpts: [{ dbName: 'ricardo_test_generation' }] });
  const uri = server.getUri(); if (!/127\.0\.0\.1|localhost/.test(uri)) throw Error('Somente Mongo local permitido');
  await mongoose.connect(uri, { dbName: 'ricardo_test_generation' });
  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Contract = (await import('../../models/LiminarContract.js')).default;
  Plan = (await import('../../models/TherapeuticPlan.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Payment = (await import('../../models/Payment.js')).default;
  Guide = (await import('../../models/InsuranceGuide.js')).default;
  InsurancePlan = (await import('../../models/InsurancePlan.js')).default;
  const Convenio = (await import('../../models/Convenio.js')).default;
  await Convenio.insertMany([{ code: 'ricardo-test', name: 'Convênio Ricardo Test', sessionValue: 80 }]);
  const insuranceRoutes = (await import('../../routes/insurancePlans.v2.js')).default;
  const { generateLiminarSessions } = await import('../../services/schedule/generateLiminarSessions.js');
  actor = new mongoose.Types.ObjectId();
  app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: String(actor), _id: actor, role: 'admin' }; next(); });
  app.use('/insurance', insuranceRoutes);
  app.post('/liminar/:contractId/:planId', async (req, res) => {
    try { res.json(await generateLiminarSessions({ ...req.body, planId: req.params.planId, contractId: req.params.contractId, user: req.user })); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
}, 90000);
afterAll(async () => {
  if (process.env.GENERATION_TEST_REPORT) fs.writeFileSync(process.env.GENERATION_TEST_REPORT, JSON.stringify(report, null, 2));
  await mongoose.disconnect(); if (server) await server.stop();
});
async function seed(domain) {
  const [patient] = await Patient.insertMany([{ fullName: `Ricardo Test ${domain}`, phone: '62999990077', dateOfBirth: new Date('2017-01-01') }]);
  const [doctor] = await Doctor.insertMany([{ fullName: 'Terapeuta Ricardo Test', specialty: 'fonoaudiologia', phoneNumber: '62999990076', licenseNumber: String(new mongoose.Types.ObjectId()), email: `${new mongoose.Types.ObjectId()}@example.invalid` }]);
  const rows = [0, 7].map((offset, i) => ({ specialty: 'fonoaudiologia', doctorId: String(doctor._id), date: date(offset), time: '14:00', sessionValue: 80, reason: 'Cancelamento informado na massa de teste', cancelRequester: i === 0 ? 'patient' : 'professional' }));
  if (domain === 'liminar') {
    const [contract] = await Contract.insertMany([{ patient: patient._id, doctor: doctor._id, totalCredit: 4000, creditBalance: 4000, usedCredit: 0, totalSessions: 4 }]);
    const [plan] = await Plan.insertMany([{ patient: patient._id, liminarContract: contract._id, version: 1, startDate: new Date(date(0)), therapies: { fonoaudiologia: { doctor: doctor._id, slots: [{ dayOfWeek: 2, time: '14:00' }], sessionValue: 80, totalSessions: 3 } } }]);
    return { patient, doctor, contract, plan, rows, url: `/liminar/${contract._id}/${plan._id}` };
  }
  const [guide] = await Guide.insertMany([{ number: `TEST-${new mongoose.Types.ObjectId()}`, patientId: patient._id, specialty: 'fonoaudiologia', insurance: 'ricardo-test', totalSessions: 3, usedSessions: 0, sessionValue: 80, expiresAt: new Date(Date.now() + 365 * 86400000), status: 'active' }]);
  const [plan] = await InsurancePlan.insertMany([{ patient: patient._id, guide: guide._id, doctor: doctor._id, specialty: 'fonoaudiologia', totalSessions: 3, sessionsPerWeek: 1, startDate: new Date(date(0)), slots: [{ dayOfWeek: 2, time: '14:00' }], sessionValue: 80 }]);
  return { patient, doctor, guide, plan, rows, url: `/insurance/${plan._id}/generate-sessions` };
}
async function assertLinks(patientId) {
  const appointments = await Appointment.find({ patient: patientId }).lean();
  for (const a of appointments) { expect(a.session).toBeTruthy(); const s = await Session.findById(a.session).lean(); expect(String(s.appointmentId)).toBe(String(a._id)); expect(s.status).toBe(a.operationalStatus === 'canceled' ? 'canceled' : 'scheduled'); }
  return appointments;
}
describe('Geração combinada — Ricardo Test, Mongo local real', () => {
  it.each(['liminar', 'convenio'])('%s: prévia sem escrita, confirmação atômica, vínculos e replay sem duplicação', async domain => {
    const x = await seed(domain); const body = { weeks: 2, startDate: date(0), skipHolidays: false, cancellations: x.rows, dryRun: true };
    let response = await request(app).post(x.url).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await Appointment.countDocuments({ patient: x.patient._id })).toBe(0);
    expect(await Session.countDocuments({ patient: x.patient._id })).toBe(0);
    expect(await Payment.countDocuments({ patient: x.patient._id })).toBe(0);
    response = await request(app).post(x.url).send({ ...body, dryRun: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    let appointments = await assertLinks(x.patient._id);
    const canceled = appointments.filter(a => a.operationalStatus === 'canceled'), active = appointments.filter(a => a.operationalStatus !== 'canceled');
    expect(canceled).toHaveLength(2); expect(active).toHaveLength(domain === 'liminar' ? 2 : 3);
    expect(canceled.map(a => a.cancelRequester).sort()).toEqual(['patient', 'professional']);
    expect(canceled.every(a => String(a.canceledBy) === String(actor))).toBe(true);
    expect(active.every(a => !x.rows.some(r => r.date === a.date.toISOString().slice(0, 10)))).toBe(true);
    expect(await Payment.countDocuments({ appointment: { $in: canceled.map(a => a._id) } })).toBe(0);
    expect(await Payment.countDocuments({ patient: x.patient._id, status: 'paid' })).toBe(0);
    if (x.contract) expect((await Contract.findById(x.contract._id)).creditBalance).toBe(4000);
    if (x.guide) expect((await Guide.findById(x.guide._id)).usedSessions).toBe(0);
    const before = appointments.map(a => String(a._id)).sort();
    response = await request(app).post(x.url).send({ ...body, dryRun: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    appointments = await assertLinks(x.patient._id); expect(appointments.map(a => String(a._id)).sort()).toEqual(before);
    report.tests.push({ domain, patient: String(x.patient._id), canceled: canceled.length, scheduled: active.length, replayDuplicates: 0, previewPersisted: 0, clinicalCompletion: 0 });
  }, 60000);
  it('mudança de início válida é conferida sem persistência e salva somente na confirmação', async () => {
    const x = await seed('convenio');
    const original = (await InsurancePlan.findById(x.plan._id)).startDate.toISOString();
    const body = { startDate: date(7), cancellations: x.rows, dryRun: true };
    let response = await request(app).post(x.url).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await InsurancePlan.findById(x.plan._id)).startDate.toISOString()).toBe(original);
    expect(await Appointment.countDocuments({ patient: x.patient._id })).toBe(0);
    response = await request(app).post(x.url).send({ ...body, dryRun: false });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await InsurancePlan.findById(x.plan._id)).startDate.toISOString().slice(0, 10)).toBe(date(7));
    expect((await Guide.findById(x.guide._id)).usedSessions).toBe(0);
  });
  it('conflito bloqueia todo o lote sem criar a outra data', async () => {
    const x = await seed('liminar');
    await Appointment.insertMany([{ patient: x.patient._id, doctor: x.doctor._id, date: new Date(`${x.rows[0].date}T14:00:00-03:00`), time: '14:00', specialty: 'fonoaudiologia', operationalStatus: 'completed', billingType: 'liminar', liminarContract: x.contract._id }]);
    const response = await request(app).post(x.url).send({ weeks: 2, startDate: date(0), cancellations: x.rows, dryRun: false });
    expect(response.status).toBe(409); expect(await Appointment.countDocuments({ patient: x.patient._id })).toBe(1); expect(await Session.countDocuments({ patient: x.patient._id })).toBe(0);
    report.tests.push({ case: 'conflict', preservedCompleted: 1, extraDocuments: 0 });
  });
});
