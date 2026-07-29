/**
 * Regressão: filtro temporal da aba "Faturados" deve usar insurance.billedAt,
 * não Session.date.
 *
 * Incidente: guia por guia (Benjamim) com 16 sessões em maio/junho/julho
 * faturadas em julho. A aba Faturados de julho mostrava apenas as 6 sessões
 * de julho porque filtrava por Session.date.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
let Payment;
let Patient;
let Session;
let Convenio;
let getInsuranceReceivables;

function fakeRes() {
  const res = {};
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
}

async function reqReceivables({ month, status }) {
  const req = { query: { month, status } };
  const res = fakeRes();
  await getInsuranceReceivables(req, res);
  return res._body;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());

  Patient = (await import('../../models/Patient.js')).default;
  Session = (await import('../../models/Session.js')).default;
  Convenio = (await import('../../models/Convenio.js')).default;
  Payment = (await import('../../models/Payment.js')).default;
  await import('../../models/Doctor.js');

  getInsuranceReceivables = (await import('../../controllers/insuranceV2Controller.js')).getInsuranceReceivables;
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  await Payment.deleteMany({});
  await Session.deleteMany({});
  await Patient.deleteMany({});
  await Convenio.deleteMany({});
});

describe('Insurance Receivables - Temporal Filter', () => {
  it('Faturados deve usar insurance.billedAt, não Session.date', async () => {
    const patient = await Patient.create({ fullName: 'Paciente Teste', cpf: '12345678901' });
    const convenio = await Convenio.create({ code: 'unimed-anapolis', name: 'Unimed Anápolis' });

    // Sessão clínica em junho
    const session = await Session.create({
      patient: patient._id,
      date: new Date('2026-06-10T00:00:00-03:00'),
      time: '10:00',
      specialty: 'fonoaudiologia',
      status: 'completed',
      billingType: 'convenio',
      paymentMethod: 'convenio'
    });

    // Faturado em julho
    await Payment.create({
      patient: patient._id,
      amount: 80,
      paymentDate: session.date,
      paymentMethod: 'convenio',
      billingType: 'convenio',
      status: 'billed',
      session: session._id,
      insurance: {
        provider: 'unimed-anapolis',
        insuranceProvider: convenio._id,
        status: 'billed',
        grossAmount: 80,
        billedAt: new Date('2026-07-29T10:00:00-03:00'),
        billedAtSource: 'test'
      }
    });

    // ❌ Não deve aparecer em Faturados de junho (sessão foi em junho, mas faturado em julho)
    const junho = await reqReceivables({ month: '2026-06', status: 'billed' });
    expect(junho.success).toBe(true);
    expect(junho.summary?.pendingCount || 0).toBe(0);

    // ✅ Deve aparecer em Faturados de julho (mês do faturamento)
    const julho = await reqReceivables({ month: '2026-07', status: 'billed' });
    expect(julho.success).toBe(true);
    expect(julho.summary?.pendingCount || 0).toBe(1);
  });
});
