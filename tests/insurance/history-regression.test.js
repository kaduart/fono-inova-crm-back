/**
 * Regressão completa: Histórico de convênios.
 *
 * Valida os cenários levantados para homologação:
 *   - Janeiro, Fevereiro, Março aparecem corretamente
 *   - Competência da guia (mês de abertura) vence data da sessão
 *   - Múltiplas especialidades no mesmo paciente
 *   - Status billed e received refletem no histórico
 *   - Sessões já faturadas em lote não são duplicadas
 *   - Navegação por paciente/especialidade/guia
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../services/syncService.js', () => ({
  syncEvent: vi.fn().mockResolvedValue(undefined),
  handlePackageSessionUpdate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/appointmentStateOrchestrator.js', () => ({
  appointmentStateOrchestrator: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/projections/syncAffectedViews.js', () => ({
  syncAffectedViews: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/appointment/helpers/socketHelper.js', () => ({
  emitSocket: vi.fn().mockResolvedValue(undefined),
}));

let replSet;
let Patient;
let Doctor;
let Session;
let Appointment;
let Payment;
let InsuranceGuide;
let InsuranceBatch;
let Convenio;
let getInsuranceHistory;
let getPatientInsuranceSessions;
let insuranceBilling;

function fakeRes() {
  const res = {};
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
}

async function reqHistory({ year, provider }) {
  const req = { query: { year: String(year), ...(provider && { provider }) } };
  const res = fakeRes();
  await getInsuranceHistory(req, res);
  return res._body;
}

async function reqPatientSessions({ patientId, month, specialty, provider, status }) {
  const req = { query: { patientId, month, ...(specialty && { specialty }), ...(provider && { provider }), ...(status && { status }) } };
  const res = fakeRes();
  await getPatientInsuranceSessions(req, res);
  return res._body;
}

async function createScenario(overrides = {}) {
  const patient = await Patient.create({
    fullName: overrides.patientName || 'Paciente Padrão',
    cpf: overrides.cpf || '12345678901'
  });
  const doctor = await Doctor.create({
    fullName: overrides.doctorName || 'Doutor Padrão',
    email: `${Date.now()}@example.com`,
    specialty: overrides.specialty || 'fonoaudiologia',
    licenseNumber: `CRFA-${Date.now()}`,
    phoneNumber: '62999999999'
  });

  const issuedAt = overrides.issuedAt || new Date('2026-02-15T00:00:00-03:00');
  const guide = await InsuranceGuide.create({
    number: overrides.guideNumber || `GUIA-${Date.now()}`,
    patientId: patient._id,
    specialty: overrides.specialty || 'fonoaudiologia',
    insurance: overrides.insurance || 'unimed-anapolis',
    totalSessions: overrides.totalSessions || 4,
    usedSessions: 0,
    sessionValue: overrides.sessionValue || 100,
    expiresAt: overrides.expiresAt || new Date('2026-12-31T23:59:59-03:00'),
    issuedAt,
    billingMode: overrides.billingMode || 'per_month'
  });

  const sessions = [];
  for (const date of (overrides.dates || [new Date('2026-02-20T00:00:00-03:00')])) {
    const sess = await Session.create({
      patient: patient._id,
      doctor: doctor._id,
      date,
      time: '10:00',
      sessionType: overrides.specialty || 'fonoaudiologia',
      status: 'completed',
      billingType: 'convenio',
      paymentMethod: 'convenio',
      insuranceGuide: guide._id,
      sessionValue: overrides.sessionValue || 100
    });
    sessions.push(sess);
  }

  return { patient, doctor, guide, sessions };
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());

  await import('../../models/PatientsView.js');
  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Appointment = (await import('../../models/Appointment.js')).default;
  Payment = (await import('../../models/Payment.js')).default;
  InsuranceGuide = (await import('../../models/InsuranceGuide.js')).default;
  InsuranceBatch = (await import('../../models/InsuranceBatch.js')).default;
  Convenio = (await import('../../models/Convenio.js')).default;

  const controller = await import('../../controllers/insuranceV2Controller.js');
  getInsuranceHistory = controller.getInsuranceHistory;
  getPatientInsuranceSessions = controller.getPatientInsuranceSessions;
  insuranceBilling = (await import('../../services/billing/insuranceBilling.js')).default;
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  await Payment.deleteMany({});
  await Session.deleteMany({});
  await Appointment.deleteMany({});
  await InsuranceGuide.deleteMany({});
  await InsuranceBatch.deleteMany({});
  await Patient.deleteMany({});
  await Doctor.deleteMany({});
  await Convenio.deleteMany({});
});

describe('Insurance History - Regression Suite', () => {
  it('Janeiro: guia aberta em jan/2026 com sessão em jan aparece no histórico', async () => {
    const { patient, guide, sessions } = await createScenario({
      issuedAt: new Date('2026-01-10T00:00:00-03:00'),
      dates: [new Date('2026-01-20T00:00:00-03:00')],
      patientName: 'Paciente Janeiro'
    });

    const history = await reqHistory({ year: 2026 });
    const jan = history.data.find(m => m.monthKey === '2026-01');
    expect(jan?.totalSessions).toBe(1);
    expect(jan?.providers[0]?.patients[0]?.name).toBe('Paciente Janeiro');
  });

  it('Fevereiro: guia aberta em fev/2026 com sessão em fev aparece no histórico', async () => {
    const { patient, guide, sessions } = await createScenario({
      issuedAt: new Date('2026-02-10T00:00:00-03:00'),
      dates: [new Date('2026-02-20T00:00:00-03:00')],
      patientName: 'Paciente Fevereiro'
    });

    const history = await reqHistory({ year: 2026 });
    const feb = history.data.find(m => m.monthKey === '2026-02');
    expect(feb?.totalSessions).toBe(1);
  });

  it('Março: guia aberta em mar/2026 com sessão em mar aparece no histórico', async () => {
    const { patient, guide, sessions } = await createScenario({
      issuedAt: new Date('2026-03-10T00:00:00-03:00'),
      dates: [new Date('2026-03-25T00:00:00-03:00')],
      patientName: 'Paciente Marco'
    });

    const history = await reqHistory({ year: 2026 });
    const mar = history.data.find(m => m.monthKey === '2026-03');
    expect(mar?.totalSessions).toBe(1);
  });

  it('Competência da guia: sessões em março/abril pertencem à guia de fevereiro', async () => {
    const { patient, guide, sessions } = await createScenario({
      issuedAt: new Date('2026-02-10T00:00:00-03:00'),
      dates: [
        new Date('2026-03-05T00:00:00-03:00'),
        new Date('2026-04-10T00:00:00-03:00')
      ],
      patientName: 'Paciente Competencia'
    });

    const history = await reqHistory({ year: 2026 });
    const feb = history.data.find(m => m.monthKey === '2026-02');
    expect(feb?.totalSessions).toBe(2);
    expect(feb?.totalValue).toBe(200);

    const mar = history.data.find(m => m.monthKey === '2026-03');
    const apr = history.data.find(m => m.monthKey === '2026-04');
    expect((mar?.totalValue || 0) + (apr?.totalValue || 0)).toBe(0);

    const detail = await reqPatientSessions({
      patientId: patient._id.toString(),
      month: '2026-02',
      specialty: 'fonoaudiologia'
    });
    expect(detail.count).toBe(2);
  });

  it('Junho/2026 (modelo atual): guia criada em junho exibe todas as sessões ao filtrar junho', async () => {
    const { patient, sessions } = await createScenario({
      issuedAt: new Date('2026-06-10T00:00:00-03:00'),
      dates: [
        new Date('2026-06-20T00:00:00-03:00'),
        new Date('2026-07-05T00:00:00-03:00'),
        new Date('2026-07-12T00:00:00-03:00')
      ],
      patientName: 'Paciente Junho Atual',
      sessionValue: 100
    });

    const detail = await reqPatientSessions({
      patientId: patient._id.toString(),
      month: '2026-06',
      specialty: 'fonoaudiologia',
      provider: 'unimed-anapolis'
    });

    expect(detail.success).toBe(true);
    expect(detail.count).toBe(3);
    expect(detail.data.map(s => s.sessionId).sort()).toEqual(
      sessions.map(s => s._id.toString()).sort()
    );
  });

  it('Junho/2026 (modelo atual): encontra guia mesmo sem InsuranceGuide.patientId confiável', async () => {
    const { patient, doctor } = await createScenario({
      issuedAt: new Date('2026-06-10T00:00:00-03:00'),
      dates: [new Date('2026-06-20T00:00:00-03:00')],
      patientName: 'Paciente Sem Guide PatientId',
      sessionValue: 100
    });

    // Simula dado migrado: remove o patientId da guia, mas mantém Session apontando para ela.
    const guide = await InsuranceGuide.findOne({ patientId: patient._id }).lean();
    expect(guide).toBeTruthy();
    await InsuranceGuide.updateOne({ _id: guide._id }, { $unset: { patientId: 1 } });

    const detail = await reqPatientSessions({
      patientId: patient._id.toString(),
      month: '2026-06',
      specialty: 'fonoaudiologia',
      provider: 'unimed-anapolis'
    });

    expect(detail.success).toBe(true);
    expect(detail.count).toBe(1);
  });

  it('Múltiplas especialidades: paciente com Fono e TO em guias diferentes', async () => {
    const { patient } = await createScenario({
      issuedAt: new Date('2026-02-01T00:00:00-03:00'),
      dates: [new Date('2026-02-10T00:00:00-03:00')],
      specialty: 'fonoaudiologia',
      patientName: 'Paciente Multi'
    });

    await createScenario({
      issuedAt: new Date('2026-02-01T00:00:00-03:00'),
      dates: [new Date('2026-02-11T00:00:00-03:00')],
      specialty: 'terapia_ocupacional',
      patientName: 'Paciente Multi',
      cpf: '12345678902'
    });

    const history = await reqHistory({ year: 2026 });
    const feb = history.data.find(m => m.monthKey === '2026-02');
    const prov = feb?.providers[0];
    expect(prov?.patients.length).toBe(1);
    expect(prov?.patients[0]?.specialties.length).toBe(2);
  });

  it('Status billed: sessão marcada como faturada aparece como billed no histórico', async () => {
    const { patient, sessions } = await createScenario({
      issuedAt: new Date('2026-02-01T00:00:00-03:00'),
      dates: [new Date('2026-02-10T00:00:00-03:00')],
      patientName: 'Paciente Billed'
    });

    // Cria appointment e payment vinculados à sessão
    const appt = await Appointment.create({
      patient: patient._id,
      doctor: sessions[0].doctor,
      specialty: 'fonoaudiologia',
      date: sessions[0].date,
      time: '10:00',
      duration: 40,
      session: sessions[0]._id,
      billingType: 'convenio',
      insuranceProvider: 'unimed-anapolis'
    });
    sessions[0].appointmentId = appt._id;
    await sessions[0].save();

    await Payment.create({
      patient: patient._id,
      doctor: sessions[0].doctor,
      session: sessions[0]._id,
      appointment: appt._id,
      amount: 100,
      paymentMethod: 'convenio',
      billingType: 'convenio',
      status: 'pending',
      paymentDate: sessions[0].date,
      serviceDate: sessions[0].date,
      insurance: {
        provider: 'unimed-anapolis',
        status: 'pending_billing',
        grossAmount: 100,
        authorizationCode: 'GUIA-BILLED'
      }
    });

    await insuranceBilling.markSessionAsBilled(sessions[0]._id.toString(), { billedAmount: 100, billedAt: new Date('2026-02-15T00:00:00-03:00') });

    const history = await reqHistory({ year: 2026 });
    const feb = history.data.find(m => m.monthKey === '2026-02');
    expect(feb?.providers[0]?.status).toBe('billed');
    expect(feb?.providers[0]?.patients[0]?.specialties[0]?.batchStatus).toBe('billed');
  });

  it('Status received: sessão marcada como recebida aparece como received no histórico', async () => {
    const { patient, sessions } = await createScenario({
      issuedAt: new Date('2026-02-01T00:00:00-03:00'),
      dates: [new Date('2026-02-10T00:00:00-03:00')],
      patientName: 'Paciente Received'
    });

    const appt = await Appointment.create({
      patient: patient._id,
      doctor: sessions[0].doctor,
      specialty: 'fonoaudiologia',
      date: sessions[0].date,
      time: '10:00',
      duration: 40,
      session: sessions[0]._id,
      billingType: 'convenio',
      insuranceProvider: 'unimed-anapolis'
    });
    sessions[0].appointmentId = appt._id;
    await sessions[0].save();

    await Payment.create({
      patient: patient._id,
      doctor: sessions[0].doctor,
      session: sessions[0]._id,
      appointment: appt._id,
      amount: 100,
      paymentMethod: 'convenio',
      billingType: 'convenio',
      status: 'pending',
      paymentDate: sessions[0].date,
      serviceDate: sessions[0].date,
      insurance: {
        provider: 'unimed-anapolis',
        status: 'pending_billing',
        grossAmount: 100
      }
    });

    await insuranceBilling.markSessionAsReceived(sessions[0]._id.toString(), 100, new Date('2026-02-20T00:00:00-03:00'));

    const history = await reqHistory({ year: 2026 });
    const feb = history.data.find(m => m.monthKey === '2026-02');
    expect(feb?.providers[0]?.status).toBe('received');

    const detail = await reqPatientSessions({
      patientId: patient._id.toString(),
      month: '2026-02',
      specialty: 'fonoaudiologia'
    });
    expect(detail.data[0]?.billingStatus).toBe('received');
    expect(detail.data[0]?.receivedAmount).toBe(100);
  });

  it('Não duplica sessões já faturadas em lote', async () => {
    const { patient, guide, sessions } = await createScenario({
      issuedAt: new Date('2026-02-01T00:00:00-03:00'),
      dates: [new Date('2026-02-10T00:00:00-03:00')],
      patientName: 'Paciente Lote'
    });

    const appt = await Appointment.create({
      patient: patient._id,
      doctor: sessions[0].doctor,
      specialty: 'fonoaudiologia',
      date: sessions[0].date,
      time: '10:00',
      duration: 40,
      session: sessions[0]._id,
      billingType: 'convenio',
      insuranceProvider: 'unimed-anapolis'
    });

    await InsuranceBatch.create({
      batchNumber: `LOTE-${Date.now()}`,
      insuranceProvider: 'unimed-anapolis',
      startDate: sessions[0].date,
      endDate: sessions[0].date,
      status: 'sent',
      sessions: [{
        session: sessions[0]._id,
        appointment: appt._id,
        guide: guide._id,
        grossAmount: 100,
        status: 'sent',
        sessionDate: sessions[0].date
      }],
      totalGross: 100,
      totalSessions: 1
    });

    const history = await reqHistory({ year: 2026 });
    const feb = history.data.find(m => m.monthKey === '2026-02');
    expect(feb?.totalSessions).toBe(1);
    expect(feb?.totalValue).toBe(100);

    // Não deve haver segundo registro duplicado vindo da fonte "guia"
    const detail = await reqPatientSessions({
      patientId: patient._id.toString(),
      month: '2026-02',
      specialty: 'fonoaudiologia'
    });
    expect(detail.count).toBe(1);
  });
});
