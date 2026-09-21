import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// getInsuranceGuidesView com modelos simulados. Cobre: sessões órfãs presentes (lista e contagem),
// ordem/paralelismo das consultas e falhas — inclusive na consulta de órfãs disparada no INÍCIO.
const { st, mkQuery } = vi.hoisted(() => {
  const st = { ev: [], cfg: {} };
  const clone = v => (v === undefined ? v : structuredClone(v));
  const mkQuery = (name, match) => {
    let p;
    const run = () => (p ??= (async () => {
      const c = st.cfg[name] || {};
      st.ev.push({ e: 'start', name, match, t: Date.now() });
      if (c.delay) await new Promise(r => setTimeout(r, c.delay));
      st.ev.push({ e: 'end', name, t: Date.now() });
      if (c.error) throw c.error;
      return clone(c.result ?? []);
    })());
    const q = {
      select: () => q, populate: () => q, sort: () => q, lean: () => q,
      exec: () => run(), then: (a, b) => run().then(a, b), catch: b => run().catch(b),
    };
    return q;
  };
  return { st, mkQuery };
});

const isOrphanMatch = m => m?.status === 'completed' && Array.isArray(m.$or);
vi.mock('../../models/InsuranceGuide.js', () => ({ default: { find: m => mkQuery('guides', m) } }));
vi.mock('../../models/Session.js', () => ({
  default: {
    find: m => mkQuery(isOrphanMatch(m) ? 'orphanFind' : 'sessions', m),
    countDocuments: m => mkQuery('orphanCount', m),
  },
}));
vi.mock('../../models/Payment.js', () => ({ default: { find: m => mkQuery('payments', m) } }));
vi.mock('../../models/InsuranceCommunication.js', () => ({
  default: { find: m => mkQuery(m?.guideId ? 'legacyComms' : 'subComms', m) },
}));
vi.mock('../../models/InsuranceBatch.js', () => ({ default: { find: m => mkQuery('batches', m) } }));
vi.mock('../../models/BillingSubmission.js', () => ({ default: { find: m => mkQuery('submissions', m) } }));
vi.mock('../../utils/logger.js', () => ({
  createContextLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { getInsuranceGuidesView } from '../../services/insuranceGuide/insuranceGuidesReadView.js';

const D = new Date('2026-09-01T12:00:00Z');
const GUIDE = { _id: 'g1', patientId: { _id: 'p1', fullName: 'Ana' }, insurance: 'unimed', status: 'active', number: '123', totalSessions: 10, createdAt: D };
const SESSIONS = [
  { _id: 's1', insuranceGuide: 'g1', date: D, status: 'completed', sessionValue: 100, specialty: 'fonoaudiologia', doctor: { _id: 'd1', fullName: 'Dra' }, appointmentId: { time: '09:00' }, billingBatchId: 'b1' },
];
const PAYMENTS = [{ _id: 'pay1', session: 's1', insuranceGuide: 'g1', amount: 100, status: 'pending', insurance: { status: 'pending_billing' } }];
const ORPHANS = [
  { _id: 'o1', date: D, time: '10:00', sessionValue: 80, specialty: 'psicologia', patient: { _id: 'p9', fullName: 'Bia' }, doctor: { fullName: 'Dr X' }, billingBatchId: null, insuranceProvider: 'unimed' },
  { _id: 'o2', date: D, time: '11:00', sessionValue: 0, specialty: 'terapia_ocupacional', patient: null, doctor: null, billingBatchId: 'b7', insuranceProvider: null },
];

const started = name => st.ev.some(x => x.e === 'start' && x.name === name);
const idx = (e, name) => st.ev.findIndex(x => x.e === e && x.name === name);

let unhandled;
const onUnhandled = r => unhandled.push(r);
beforeEach(() => {
  st.ev.length = 0;
  st.cfg = {
    guides: { result: [GUIDE] }, sessions: { result: SESSIONS }, payments: { result: PAYMENTS },
    legacyComms: { result: [] }, subComms: { result: [] }, submissions: { result: [] },
    batches: { result: [{ _id: 'b1', status: 'sent', invoiceNumber: 'NF1' }] },
    orphanFind: { result: ORPHANS }, orphanCount: { result: 2 },
  };
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => process.off('unhandledRejection', onUnhandled));
const noUnhandled = async () => { await new Promise(r => setTimeout(r, 80)); expect(unhandled).toEqual([]); };

describe('getInsuranceGuidesView — sessões órfãs', () => {
  it('modo completo: devolve a lista mapeada e a contagem, sem consulta de contagem à parte', async () => {
    const r = await getInsuranceGuidesView({});
    expect(r.orphanSessionsCount).toBe(2);
    expect(r.orphanSessions).toEqual([
      expect.objectContaining({ sessionId: 'o1', patientName: 'Bia', doctorName: 'Dr X', value: 80, specialty: 'psicologia', insuranceProvider: 'unimed', batchId: null }),
      expect.objectContaining({ sessionId: 'o2', patientName: null, doctorName: null, value: 0, batchId: 'b7' }),
    ]);
    expect(started('orphanCount')).toBe(false);
    await noUnhandled();
  });

  it('modo summary: lista vazia e contagem vinda do countDocuments (3), sem buscar a lista', async () => {
    st.cfg.orphanCount = { result: 3 };
    const r = await getInsuranceGuidesView({ detail: 'summary' });
    expect(r.orphanSessions).toEqual([]);
    expect(r.orphanSessionsCount).toBe(3);
    expect(started('orphanFind')).toBe(false);
    await noUnhandled();
  });

  it('com guideId: contagem 0, lista vazia e NENHUMA consulta de órfãs é disparada', async () => {
    const r = await getInsuranceGuidesView({ guideId: 'a'.repeat(24) });
    expect(r.orphanSessions).toEqual([]);
    expect(r.orphanSessionsCount).toBe(0);
    expect(started('orphanFind')).toBe(false);
    expect(started('orphanCount')).toBe(false);
  });

  it('usa o filtro constante de órfãs (completed + convênio + sem guia)', async () => {
    await getInsuranceGuidesView({});
    const m = st.ev.find(x => x.e === 'start' && x.name === 'orphanFind').match;
    expect(m.status).toBe('completed');
    expect(m.$or).toEqual([{ paymentMethod: 'convenio' }, { billingType: 'convenio' }]);
    expect(m.$and[0].$or).toEqual([{ insuranceGuide: { $exists: false } }, { insuranceGuide: null }]);
  });
});

describe('getInsuranceGuidesView — ordem das consultas', () => {
  it('órfãs começam antes de as guias terminarem; Payment e lotes começam antes de as submissões terminarem', async () => {
    st.cfg.guides.delay = 40;
    st.cfg.submissions = { result: [], delay: 60 };
    await getInsuranceGuidesView({});
    expect(idx('start', 'orphanFind')).toBeLessThan(idx('end', 'guides'));
    expect(idx('start', 'payments')).toBeLessThan(idx('end', 'submissions'));
    expect(idx('start', 'batches')).toBeLessThan(idx('end', 'submissions'));
  });

  it('a cadeia submissões → comunicações continua em série (comunicações dependem dos ids)', async () => {
    st.cfg.submissions = { result: [{ _id: 'sub1', sessionIds: ['s1'] }], delay: 20 };
    st.cfg.subComms = { result: [{ _id: 'c1', guideId: 'g1', billingSubmissionId: 'sub1', sentAt: D }] };
    await getInsuranceGuidesView({});
    expect(idx('end', 'submissions')).toBeLessThan(idx('start', 'subComms'));
  });
});

describe('getInsuranceGuidesView — falhas na consulta antecipada de órfãs', () => {
  const boom = new Error('orphans down');

  it('lista de órfãs falha (guias presentes): rejeita com o mesmo erro, sem unhandledRejection', async () => {
    st.cfg.orphanFind = { error: boom };
    await expect(getInsuranceGuidesView({})).rejects.toBe(boom);
    await noUnhandled();
  });

  it('contagem de órfãs falha (summary): rejeita com o mesmo erro, sem unhandledRejection', async () => {
    st.cfg.orphanCount = { error: boom };
    await expect(getInsuranceGuidesView({ detail: 'summary' })).rejects.toBe(boom);
    await noUnhandled();
  });

  it('retorno antecipado sem guias com a consulta de órfãs falhando: retorna normalmente, sem unhandledRejection', async () => {
    st.cfg.guides = { result: [] };
    st.cfg.orphanFind = { error: boom, delay: 10 };
    const r = await getInsuranceGuidesView({});
    expect(r.guides).toEqual([]);
    await noUnhandled();
  });

  it('retorno antecipado sem guias, modo summary, contagem falhando: retorna e não vaza rejeição', async () => {
    st.cfg.guides = { result: [] };
    st.cfg.orphanCount = { error: boom, delay: 10 };
    const r = await getInsuranceGuidesView({ detail: 'summary' });
    expect(r.guides).toEqual([]);
    await noUnhandled();
  });

  it('outra consulta falha (Payment) e órfãs também: rejeita com o erro de Payment, sem unhandledRejection', async () => {
    const payErr = new Error('payments down');
    st.cfg.payments = { error: payErr };
    st.cfg.orphanFind = { error: boom, delay: 30 };
    await expect(getInsuranceGuidesView({})).rejects.toBe(payErr);
    await noUnhandled();
  });

  it('a busca das guias falha e órfãs também: rejeita com o erro das guias, sem unhandledRejection', async () => {
    const guideErr = new Error('guides down');
    st.cfg.guides = { error: guideErr, delay: 10 };
    st.cfg.orphanFind = { error: boom };
    await expect(getInsuranceGuidesView({})).rejects.toBe(guideErr);
    await noUnhandled();
  });

  it('erro em batches/submissões (parte paralela nova) também propaga sem unhandledRejection', async () => {
    const subErr = new Error('submissions down');
    st.cfg.submissions = { error: subErr };
    st.cfg.batches = { error: new Error('batches down'), delay: 20 };
    await expect(getInsuranceGuidesView({})).rejects.toBe(subErr);
    await noUnhandled();
  });
});
