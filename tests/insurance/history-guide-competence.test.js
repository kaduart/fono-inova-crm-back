/**
 * Regressão: Histórico de convênios usa competência pelo mês da SESSÃO
 * (data do atendimento), não pelo mês de abertura/emissão da guia.
 *
 * Correção 2026-08-07: o agrupamento passou a usar Session.date como fonte de
 * verdade. Guias abertas em lote (ex: fevereiro/2026) não jogam mais sessões de
 * março/abril para o mês da abertura. A lista de detalhe do drawer sempre usou
 * esse critério; agora as duas telas estão alinhadas.
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
let Payment;
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
  Payment = (await import('../../models/Payment.js')).default;

  const controller = await import('../../controllers/insuranceV2Controller.js');
  getInsuranceHistory = controller.getInsuranceHistory;
  getPatientInsuranceSessions = controller.getPatientInsuranceSessions;
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  await Payment.deleteMany({});
  await Session.deleteMany({});
  await InsuranceGuide.deleteMany({});
  await Patient.deleteMany({});
  await Doctor.deleteMany({});
});

describe('Insurance History - Guide Competence', () => {
  it('prioriza o valor real da sessão/pagamento sobre o valor configurado da guia', async () => {
    const patient = await Patient.create({ fullName: 'Paciente Valor Real', cpf: '12345678902' });
    const doctor = await Doctor.create({
      fullName: 'Doutora Valor',
      email: 'doutora.valor@example.com',
      specialty: 'fonoaudiologia',
      licenseNumber: 'CRFA-0002',
      phoneNumber: '62999999998',
    });

    const guide = await InsuranceGuide.create({
      number: 'GUIA-VALOR-REAL-2026',
      patientId: patient._id,
      specialty: 'fonoaudiologia',
      insurance: 'unimed-anapolis',
      totalSessions: 5,
      usedSessions: 0,
      sessionValue: 100,
      expiresAt: new Date('2026-12-31T23:59:59-03:00'),
      issuedAt: new Date('2026-02-12T00:00:00-03:00'),
    });

    for (let i = 0; i < 5; i += 1) {
      const session = await Session.create({
        patient: patient._id,
        doctor: doctor._id,
        date: new Date(`2026-02-${String(i + 1).padStart(2, '0')}T10:00:00-03:00`),
        time: '10:00',
        sessionType: 'fonoaudiologia',
        status: 'completed',
        billingType: 'convenio',
        paymentMethod: 'convenio',
        insuranceGuide: guide._id,
        sessionValue: 80,
      });

      await Payment.create({
        patient: patient._id,
        session: session._id,
        billingType: 'convenio',
        paymentMethod: 'convenio',
        paymentDate: session.date,
        amount: 80,
        insurance: {
          provider: 'unimed-anapolis',
          grossAmount: 80,
          status: 'pending_billing'
        },
        status: 'pending_billing',
        serviceDate: session.date,
      });
    }

    const history = await reqHistory({ year: 2026 });
    const feb = history.data.find(m => m.monthKey === '2026-02');

    expect(feb).toBeTruthy();
    expect(feb.totalSessions).toBe(5);
    expect(feb.totalValue).toBe(400);
    expect(feb.providers.find(p => p.provider === 'unimed-anapolis').totalValue).toBe(400);
  });

  it('agrupa sessões pelo mês do atendimento (session.date), não pelo mês de abertura da guia', async () => {
    const patient = await Patient.create({ fullName: 'Paciente Guia', cpf: '12345678901' });
    const doctor = await Doctor.create({
      fullName: 'Doutora Guia',
      email: 'doutora.guia@example.com',
      specialty: 'fonoaudiologia',
      licenseNumber: 'CRFA-0001',
      phoneNumber: '62999999999',
    });

    // Guia aberta em fevereiro/2026, mas as sessões ocorrem em março e abril.
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

    // A competência agora é a data da sessão: março e abril, não fevereiro.
    const history = await reqHistory({ year: 2026 });
    expect(history.success).toBe(true);

    const feb = history.data.find(m => m.monthKey === '2026-02');
    expect(feb?.totalSessions || 0).toBe(0);
    expect(feb?.totalValue || 0).toBe(0);

    const mar = history.data.find(m => m.monthKey === '2026-03');
    expect(mar).toBeTruthy();
    expect(mar.totalSessions).toBe(1);
    expect(mar.totalValue).toBe(100);

    const apr = history.data.find(m => m.monthKey === '2026-04');
    expect(apr).toBeTruthy();
    expect(apr.totalSessions).toBe(1);
    expect(apr.totalValue).toBe(100);

    const unimedMar = mar.providers.find(p => p.provider === 'unimed-anapolis');
    expect(unimedMar).toBeTruthy();
    expect(unimedMar.totalSessions).toBe(1);

    // A partir de Março/2026 a Unimed Anápolis usa o modelo por guia.
    // O drawer traz TODAS as sessões da guia para contexto, não só as do mês
    // filtrado — isso evita que uma guia apareça pela metade.
    const detailMar = await reqPatientSessions({
      patientId: patient._id.toString(),
      month: '2026-03',
      specialty: 'fonoaudiologia',
    });
    expect(detailMar.success).toBe(true);
    expect(detailMar.count).toBe(2);
    expect(detailMar.data.map(s => s.sessionId).sort()).toEqual(
      [sessMar._id.toString(), sessApr._id.toString()].sort()
    );

    const detailApr = await reqPatientSessions({
      patientId: patient._id.toString(),
      month: '2026-04',
      specialty: 'fonoaudiologia',
    });
    expect(detailApr.success).toBe(true);
    expect(detailApr.count).toBe(2);
    expect(detailApr.data.map(s => s.sessionId).sort()).toEqual(
      [sessMar._id.toString(), sessApr._id.toString()].sort()
    );
  });
});
