import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../config/redisConnection.js', () => ({ safeRedis: {}, redisConnection: null, bullMqConnection: null }));

let replSet;
let getInsuranceGuidesView;
let getGuidesView;
let guideIds;
const sessionIdsByGuide = [[], []];
const phases = 'pendingBilling,documentationSent,billed,received';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  await import('../../models/index.js');
  ({ getInsuranceGuidesView } = await import('../../services/insuranceGuide/insuranceGuidesReadView.js'));
  ({ getGuidesView } = await import('../../controllers/insuranceV2Controller.js'));

  const Patient = (await import('../../models/Patient.js')).default;
  const InsuranceGuide = (await import('../../models/InsuranceGuide.js')).default;
  const Session = (await import('../../models/Session.js')).default;
  const Payment = (await import('../../models/Payment.js')).default;
  const patient = new mongoose.Types.ObjectId();
  await Patient.collection.insertOne({ _id: patient, fullName: 'Fixture' });

  guideIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  await InsuranceGuide.collection.insertMany(guideIds.map((id, index) => ({
    _id: id, number: `SUMMARY-${index}`, insurance: 'fixture', patientId: patient,
    specialty: 'fonoaudiologia', totalSessions: 10, usedSessions: 0,
    sessionValue: 100, status: 'active', createdAt: new Date('2026-01-01')
  })));

  const statuses = ['pending_billing', 'billed', 'received'];
  for (let index = 0; index < statuses.length; index++) {
    const sessionId = new mongoose.Types.ObjectId();
    const status = statuses[index];
    sessionIdsByGuide[index % 2].push(String(sessionId));
    await Session.collection.insertOne({
      _id: sessionId, insuranceGuide: guideIds[index % 2], patient,
      date: new Date(`2026-08-0${index + 1}T15:00:00Z`), status: 'completed',
      sessionValue: 100, billingBatchId: status === 'pending_billing' ? null : new mongoose.Types.ObjectId()
    });
    await Payment.collection.insertOne({
      _id: new mongoose.Types.ObjectId(), session: sessionId, insuranceGuide: guideIds[index % 2],
      billingType: 'convenio', amount: 100, status: status === 'received' ? 'paid' : status,
      insurance: { grossAmount: 100, status }
    });
  }

  await Session.collection.insertOne({
    _id: new mongoose.Types.ObjectId(), patient, date: new Date('2026-08-04T15:00:00Z'),
    status: 'completed', sessionValue: 100, billingType: 'convenio', insuranceGuide: null
  });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe('insurance read-view summary', () => {
  it('preserva guias, buckets, totais, competência e contagens sem detalhes pesados', async () => {
    const full = await getInsuranceGuidesView({ phases });
    const summary = await getInsuranceGuidesView({ phases, detail: 'summary' });

    expect(summary.totals).toEqual(full.totals);
    expect(summary.competenceBreakdown).toEqual(full.competenceBreakdown);
    expect(summary.guides.map(guide => guide.guideId)).toEqual(full.guides.map(guide => guide.guideId));
    expect(summary.orphanSessions).toEqual([]);
    expect(summary.orphanSessionsCount).toBe(full.orphanSessions.length);
    expect(summary.paymentIntegrityConflictCount).toBe(full.paymentIntegrityConflicts.length);

    for (const phase of phases.split(',')) {
      expect(summary.buckets[phase].totals).toEqual(full.buckets[phase].totals);
      expect(summary.buckets[phase].competenceBreakdown).toEqual(full.buckets[phase].competenceBreakdown);
      expect(summary.buckets[phase].data.map(guide => guide.guideId))
        .toEqual(full.buckets[phase].data.map(guide => guide.guideId));
      expect(summary.buckets[phase].data.every(guide =>
        !('sessionDetails' in guide) && !('invoices' in guide) && 'firstSessionDate' in guide && 'lastSessionDate' in guide
      )).toBe(true);
    }
  });

  it('busca detalhes aditivamente por guideId e fase antes do command side', async () => {
    const summary = await getInsuranceGuidesView({ phases, detail: 'summary' });
    const target = summary.buckets.billed.data[0];
    const detail = await getInsuranceGuidesView({ guideId: target.guideId, phase: 'billed', detail: 'full' });
    expect(detail.guides).toHaveLength(1);
    expect(detail.guides[0].guideId).toBe(target.guideId);
    expect(detail.guides[0].sessionDetails.length).toBeGreaterThan(0);
    expect(detail.guides[0].sessionDetails.every(session => session.phase === 'billed')).toBe(true);
  });

  it('carrega órfãs apenas sob demanda e preserva os campos das ações existentes', async () => {
    const summary = await getInsuranceGuidesView({ phases, detail: 'summary' });
    expect(summary.orphanSessions).toEqual([]);
    expect(summary.orphanSessionsCount).toBe(1);

    const lazy = await getInsuranceGuidesView({ detail: 'orphans' });
    expect(lazy.orphanSessions).toHaveLength(1);
    expect(lazy.orphanSessions[0]).toMatchObject({ sessionValue: 100, value: 100 });
    expect(lazy.orphanSessions[0]).toHaveProperty('sessionId');
    expect(lazy.orphanSessions[0]).toHaveProperty('patient');
    expect(lazy.orphanSessions[0]).toHaveProperty('insuranceProvider');
  });

  it('isola todas as fontes relacionadas por guideId e preserva a fase de guia mista', async () => {
    const mixedGuide = String(guideIds[0]);
    const otherGuide = String(guideIds[1]);
    const pending = await getInsuranceGuidesView({ guideId: mixedGuide, phase: 'pendingBilling', detail: 'full' });
    const received = await getInsuranceGuidesView({ guideId: mixedGuide, phase: 'received', detail: 'full' });
    const other = await getInsuranceGuidesView({ guideId: otherGuide, phase: 'billed', detail: 'full' });

    for (const result of [pending, received]) {
      expect(result.guides).toHaveLength(1);
      expect(result.guides[0].guideId).toBe(mixedGuide);
      expect(result.guides[0].sessionDetails.every(item => sessionIdsByGuide[0].includes(item.sessionId))).toBe(true);
      expect(result.guides[0].sessionDetails.every(item => !sessionIdsByGuide[1].includes(item.sessionId))).toBe(true);
      expect(result.orphanSessions).toEqual([]);
      expect(result.guides[0].invoices.every(invoice =>
        result.guides[0].sessionDetails.some(session => session.batchId === invoice.batchId)
      )).toBe(true);
    }
    expect(pending.guides[0].sessionDetails.every(item => item.phase === 'pendingBilling')).toBe(true);
    expect(received.guides[0].sessionDetails.every(item => item.phase === 'received')).toBe(true);
    expect(other.guides[0].sessionDetails.every(item => sessionIdsByGuide[1].includes(item.sessionId) && item.phase === 'billed')).toBe(true);
  });

  it('guia inexistente devolve vazio coerente sem dados de outras guias', async () => {
    const result = await getInsuranceGuidesView({ guideId: String(new mongoose.Types.ObjectId()), phase: 'billed' });
    expect(result.guides).toEqual([]);
    expect(result.totals.sessions.total).toBe(0);
  });

  it.each([
    [{ guideId: 'inválido' }, 'guideId inválido'],
    [{ phase: 'unknown' }, 'phase inválida'],
    [{ detail: 'unknown' }, 'detail inválido']
  ])('rejeita filtro inválido com 400: %j', async (query, error) => {
    const req = { query };
    const response = { statusCode: 200, body: null };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; }
    };
    await getGuidesView(req, res);
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ success: false, error });
  });

  it('summary e full preservam classificação e totais de guia mista', async () => {
    const full = await getInsuranceGuidesView({ guideId: String(guideIds[0]), phases, detail: 'full' });
    const summary = await getInsuranceGuidesView({ guideId: String(guideIds[0]), phases, detail: 'summary' });
    expect(summary.totals).toEqual(full.totals);
    expect(summary.guides.map(({ guideId, sessions, billingState, hasMixedStates }) => ({ guideId, sessions, billingState, hasMixedStates })))
      .toEqual(full.guides.map(({ guideId, sessions, billingState, hasMixedStates }) => ({ guideId, sessions, billingState, hasMixedStates })));
  });

  it('benchmark final confirma que órfãs continuam fora do payload summary', async () => {
    await getInsuranceGuidesView({ phases, detail: 'full' });
    await getInsuranceGuidesView({ phases, detail: 'summary' });
    const measure = async detail => {
      const samples = [];
      let bytes = 0;
      for (let index = 0; index < 5; index++) {
        const started = performance.now();
        const result = await getInsuranceGuidesView({ phases, detail });
        samples.push(performance.now() - started);
        bytes = Buffer.byteLength(JSON.stringify(result));
      }
      samples.sort((a, b) => a - b);
      return { p50Ms: Number(samples[2].toFixed(3)), worstMs: Number(samples[4].toFixed(3)), bytes };
    };
    const full = await measure('full');
    const summary = await measure('summary');
    expect(summary.bytes).toBeLessThan(full.bytes);
    expect((await getInsuranceGuidesView({ phases, detail: 'summary' })).orphanSessions).toEqual([]);
    console.info('FINAL_SUMMARY_BENCHMARK', { full, summary });
  });
});
