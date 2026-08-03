/**
 * Regressão: Histórico de convênios deve usar competência da guia (mês de
 * abertura/emissão), não o mês individual de cada atendimento.
 *
 * Incidente: guias antigas (dezembro/2025, janeiro/2026, fevereiro/2026) não
 * apareciam no histórico porque as sessões reais ocorriam em meses posteriores
 * e o agrupamento era feito por Session.date.
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
let InsuranceGuide;
let getInsuranceHistory;
let getPatientInsuranceSessions;

function fakeRes() {
  const res = {};
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
}

async function reqHistory({ year }) {
  const req = { query: { year: String(year) } };
  const res = fakeRes();
  await getInsuranceHistory(req, res);
  return res._body;
}

async function reqPatientSessions({ patientId, month, specialty }) {
  const req = { query: { patientId, month, specialty } };
  const res = fakeRes();
  await getPatientInsuranceSessions(req, res);
  return res._body;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());

  await import('../../models/PatientsView.js');
  Patient = (await import('../../models/Patient.js')).default;
  Doctor = (await import('../../models/Doctor.js')).default;
  Session = (await import('../../models/Session.js')).default;
  InsuranceGuide = (await import('../../models/InsuranceGuide.js')).default;

  const controller = await import('../../controllers/insuranceV2Controller.js');
  getInsuranceHistory = controller.getInsuranceHistory;
  getPatientInsuranceSessions = controller.getPatientInsuranceSessions;
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  await Session.deleteMany({});
  await InsuranceGuide.deleteMany({});
  await Patient.deleteMany({});
  await Doctor.deleteMany({});
});

describe('Insurance History - Guide Competence', () => {
  it('agrupa sessões pelo mês de abertura da guia, não pelo mês do atendimento', async () => {
    const patient = await Patient.create({ fullName: 'Paciente Guia', cpf: '12345678901' });
    const doctor = await Doctor.create({
      fullName: 'Doutora Guia',
      email: 'doutora.guia@example.com',
      specialty: 'fonoaudiologia',
      licenseNumber: 'CRFA-0001',
      phoneNumber: '62999999999',
    });

    const guide = await InsuranceGuide.create({
      number: 'GUIA-TESTE-202602-001',
      patientId: patient._id,
      specialty: 'fonoaudiologia',
      insurance: 'unimed-anapolis',
      totalSessions: 4,
      usedSessions: 2,
      sessionValue: 100,
      expiresAt: new Date('2026-12-31T23:59:59-03:00'),
      issuedAt: new Date('2026-02-15T00:00:00-03:00'),
    });

    const sessMar = await Session.create({
      patient: patient._id,
      doctor: doctor._id,
      date: new Date('2026-03-10T00:00:00-03:00'),
      time: '10:00',
      sessionType: 'fonoaudiologia',
      status: 'completed',
      billingType: 'convenio',
      paymentMethod: 'convenio',
      insuranceGuide: guide._id,
      sessionValue: 100,
    });

    const sessApr = await Session.create({
      patient: patient._id,
      doctor: doctor._id,
      date: new Date('2026-04-05T00:00:00-03:00'),
      time: '10:00',
      sessionType: 'fonoaudiologia',
      status: 'completed',
      billingType: 'convenio',
      paymentMethod: 'convenio',
      insuranceGuide: guide._id,
      sessionValue: 100,
    });

    // Competência da guia é fevereiro — ambas as sessões devem aparecer em 2026-02.
    const history = await reqHistory({ year: 2026 });
    expect(history.success).toBe(true);

    const feb = history.data.find(m => m.monthKey === '2026-02');
    expect(feb).toBeTruthy();
    expect(feb.totalSessions).toBe(2);
    expect(feb.totalValue).toBe(200);

    const unimed = feb.providers.find(p => p.provider === 'unimed-anapolis');
    expect(unimed).toBeTruthy();
    expect(unimed.totalSessions).toBe(2);

    const pat = unimed.patients.find(p => p.name === 'Paciente Guia');
    expect(pat).toBeTruthy();
    expect(pat.totalSessions).toBe(2);

    // Não deve haver dados em março ou abril (as sessões vão para competência fev).
    const mar = history.data.find(m => m.monthKey === '2026-03');
    const apr = history.data.find(m => m.monthKey === '2026-04');
    expect(mar?.totalValue || 0).toBe(0);
    expect(apr?.totalValue || 0).toBe(0);

    // Expandir o paciente em fevereiro deve trazer as sessões de março e abril.
    const detail = await reqPatientSessions({
      patientId: patient._id.toString(),
      month: '2026-02',
      specialty: 'fonoaudiologia',
    });
    expect(detail.success).toBe(true);
    expect(detail.count).toBe(2);
    expect(detail.data.map(s => s.sessionId).sort()).toEqual(
      [sessMar._id.toString(), sessApr._id.toString()].sort()
    );
  });
});
