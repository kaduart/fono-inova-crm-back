import { describe, it, expect, vi, beforeEach } from 'vitest';
import moment from 'moment-timezone';

// calculateProfissionais(year, month): não depende do resultado de realTime (o antigo parâmetro `data` nunca
// era lido) e por isso o handler a dispara em t0. Cobre: valores completos, independência e ordem/paralelismo.
const { st, delayedFail } = vi.hoisted(() => {
  const st = { events: [], delay: 100, doctors: [], sessions: [], sessionCash: [], particular: [], convenio: [], sessionFindMatches: [], otherSettled: false };
  const rec = name => st.events.push({ name, t: Date.now() });
  // Qualquer consulta que NÃO é de calculateProfissionais: lenta e falha (simula realTime demorando/quebrando).
  const delayedFail = () => {
    const err = new Error('mongo lento');
    const chain = new Proxy(function () {}, {
      get: (_t, p) => {
        if (p === 'then') return (_res, rej) => setTimeout(() => { if (!st.otherSettled) { st.otherSettled = true; rec('other:settled'); } rej(err); }, st.delay);
        if (p === Symbol.toPrimitive || p === 'toJSON') return undefined;
        return chain;
      },
      apply: () => chain,
      construct: () => chain,
    });
    return chain;
  };
  st.rec = rec;
  return { st, delayedFail };
});

// Query de calculateProfissionais: devolve a fixture; as demais chamadas ao mesmo modelo caem no delayedFail.
const q = (result) => { const c = { select: () => c, populate: () => c, lean: () => c, then: (a, b) => Promise.resolve(result).then(a, b) }; return c; };
vi.mock('../../middleware/auth.js', () => ({ auth: (_q, _s, n) => n(), authorize: () => (_q, _s, n) => n() }));
vi.mock('../../models/Doctor.js', () => ({
  default: {
    find: () => {
      let sel = '';
      const c = { select: s => { sel = s; return c; }, lean: () => c,
        then: (a, b) => {
          if (/specialty/.test(sel)) { st.rec('prof:doctors'); return Promise.resolve(st.doctors).then(a, b); }
          return delayedFail().then(a, b);
        } };
      return c;
    },
  },
}));
vi.mock('../../models/Session.js', () => ({
  default: {
    find: (m) => {
      let sel = '';
      const c = { select: s => { sel = s; return c; }, populate: () => c, lean: () => c,
        then: (a, b) => {
          if (/paymentOrigin/.test(sel)) { st.sessionFindMatches.push(m); return Promise.resolve(st.sessions).then(a, b); }
          return delayedFail().then(a, b);
        } };
      return c;
    },
    aggregate: (p) => (JSON.stringify(p).includes('"isPaid":true') ? Promise.resolve(st.sessionCash) : delayedFail()),
  },
}));
vi.mock('../../models/Payment.js', () => ({
  default: {
    find: (m) => {
      const c = { select: () => c, lean: () => c,
        then: (a, b) => {
          if (m?.billingType === 'particular' && m?.session) return Promise.resolve(st.particular).then(a, b);
          if (m?.billingType === 'convenio' && m?.session && m?.['insurance.status']) return Promise.resolve(st.convenio).then(a, b);
          return delayedFail().then(a, b);
        } };
      return c;
    },
    aggregate: () => delayedFail(),
  },
}));
vi.mock('../../models/Appointment.js', () => ({ default: delayedFail() }));
vi.mock('../../models/Expense.js', () => ({ default: delayedFail() }));
vi.mock('../../models/FinancialGoal.js', () => ({ default: delayedFail() }));
vi.mock('../../models/Planning.js', () => ({ default: delayedFail() }));
vi.mock('../../models/FinancialLedger.js', () => ({ default: delayedFail() }));
vi.mock('../../models/FinancialDailySnapshot.js', () => ({ default: delayedFail() }));
vi.mock('../../models/Package.js', () => ({ default: delayedFail() }));
vi.mock('../../services/commissionService.js', () => ({ calculateDoctorCommission: vi.fn() }));
// Comissão determinística (10% do sessionValue BRUTO das sessões, não o valor resolvido de pacote) — o teste verifica a aritmética de calculateProfissionais, não as regras de comissão.
vi.mock('../../services/commissionRule.service.js', () => ({
  calculateCommissionBatch: (_doctor, sessions) => ({ totalCommission: sessions.reduce((s, x) => s + (x.sessionValue || 0), 0) * 0.1, breakdown: { n: sessions.length } }),
}));
vi.mock('../../services/financialMetrics.service.js', () => ({ default: delayedFail() }));
vi.mock('../../services/financialExpenseSnapshot.service.js', () => ({ default: delayedFail() }));
vi.mock('../../services/financialEngine.js', () => ({ calculatePendentesEngine: delayedFail(), getPatientPendingPayments: delayedFail() }));
vi.mock('../../services/insuranceGuide/insuranceGuidesReadView.js', () => ({ getInsuranceGuidesView: () => new Promise((_r, rej) => setTimeout(() => rej(new Error('lento')), st.delay)) }));
vi.mock('../../services/unifiedFinancialService.v2.js', () => ({ default: delayedFail(), invalidateUFSCache: vi.fn(), invalidateUFSCacheForDates: vi.fn() }));
vi.mock('../../scripts/audits/lib/classifica-payments-convenio.js', () => ({ classifyConvenioPayments: vi.fn() }));
vi.mock('../../utils/logMetric.js', () => ({ logMetric: () => {} }));

import router, { calculateProfissionais } from '../../routes/financialDashboard.v2.js';

const oid = s => ({ toString: () => s });
const S = (id, doctor, extra) => ({ _id: oid(id), doctor: oid(doctor), sessionValue: 0, paymentMethod: 'particular', date: new Date('2026-09-10T15:00:00Z'), ...extra });
function seedFixtures() {
  st.doctors = [
    { _id: oid('d1'), fullName: 'Ana', specialty: 'fonoaudiologia' },
    { _id: oid('d2'), fullName: 'Bruno' },                       // sem especialidade => 'Outra'
    { _id: oid('d3'), fullName: 'Carla', specialty: 'psicologia' }, // sem sessões nem recebido => fora da lista
  ];
  st.sessions = [
    S('s1', 'd1', { sessionValue: 100 }),                                               // particular 100
    S('s2', 'd1', { sessionValue: 150, paymentMethod: 'convenio' }),                    // convênio 150
    S('s3', 'd1', { sessionValue: 80, package: { sessionValue: 90 } }),                 // pacote: package.sessionValue vence => 90
    S('s4', 'd2', { sessionValue: 200, paymentMethod: 'liminar_credit' }),              // liminar 200
    S('s5', 'd2', { sessionValue: 0, package: { totalValue: 600, totalSessions: 6 } }), // pacote: 600/6 => 100
    S('s6', 'd2', { sessionValue: 120, paymentOrigin: 'liminar' }),                     // liminar 120
  ];
  st.particular = [{ session: oid('s1'), amount: 100 }];
  st.convenio = [{ session: oid('s2'), amount: 150, insurance: { receivedAmount: 140 } }];
  st.sessionCash = [{ _id: oid('s3'), doctor: oid('d1'), amount: 90 }];
}

const EXPECTED = (() => {
  const d1 = { id: 'd1', nome: 'Ana', especialidade: 'fonoaudiologia', producao: 340, realizado: 340, quantidade: 3, particular: 100, convenio: 150, pacote: 90, liminar: 0,
    comissao: { total: 33, sessoes: 3, breakdown: { n: 3 } }, lucro: 307, margem: 90.3, ticketMedio: 113.33, eficiencia: 100, produtividade: 89.5 };
  const d2 = { id: 'd2', nome: 'Bruno', especialidade: 'Outra', producao: 420, realizado: 0, quantidade: 3, particular: 0, convenio: 0, pacote: 100, liminar: 320,
    comissao: { total: 32, sessoes: 3, breakdown: { n: 3 } }, lucro: 388, margem: 92.4, ticketMedio: 140, eficiencia: 0, produtividade: 110.5 };
  return { lista: [d1, d2], ranking: [d1, d2], rankingPorProducao: [d2, d1], rankingPorLucro: [d2, d1], mediaProducao: 380, totalProfissionais: 2 };
})();

beforeEach(() => {
  st.events.length = 0; st.sessionFindMatches.length = 0; st.otherSettled = false; st.delay = 100;
  seedFixtures();
  vi.spyOn(console, 'log').mockImplementation(() => {}); st.errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('calculateProfissionais(year, month) — valores completos', () => {
  it('produção, realizado, tipos, comissão, lucro, margem, ranking e média idênticos ao esperado', async () => {
    const r = await calculateProfissionais(2026, 4); // mês próprio (evita o cache por mês entre testes)
    expect(r).toEqual(EXPECTED);
  });

  it('profissional sem atendimento e sem recebido fica fora; sem especialidade vira "Outra"', async () => {
    const r = await calculateProfissionais(2026, 5);
    expect(r.lista.map(p => p.id)).toEqual(['d1', 'd2']);
    expect(r.lista.find(p => p.id === 'd2').especialidade).toBe('Outra');
  });

  it('intervalo do mês consultado é o do (year, month) em America/Sao_Paulo', async () => {
    await calculateProfissionais(2026, 6);
    const m = st.sessionFindMatches.at(-1);
    expect(m.status).toBe('completed');
    expect(m.date.$gte).toEqual(moment.tz([2026, 5], 'America/Sao_Paulo').startOf('month').utc().toDate());
    expect(m.date.$lte).toEqual(moment.tz([2026, 5], 'America/Sao_Paulo').endOf('month').utc().toDate());
  });
});

describe('calculateProfissionais — não depende do resultado de realTime', () => {
  it('assinatura (year, month): não recebe o objeto de realTime', () => {
    expect(calculateProfissionais.length).toBe(2);
  });

  it('argumento extra (um "data" de realTime qualquer) é ignorado: mesmo resultado', async () => {
    const semData = await calculateProfissionais(2026, 7);
    const comData = await calculateProfissionais(2026, 8, { caixa: 999999, producao: 1, visaoSemantica: { projecao: { total: 5 } } });
    expect(semData).toEqual(EXPECTED);
    expect(comData).toEqual(EXPECTED);
  });
});

describe('handler GET /v2/financial/dashboard — profissionais roda em paralelo com realTime', () => {
  const handler = router.stack.find(l => l.route?.path === '/' && l.route.methods.get).route.stack.at(-1).handle;
  const makeRes = () => ({ statusCode: 200, body: undefined, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

  it('a consulta de profissionais começa em t0, ANTES de qualquer outra etapa (realTime) terminar — e mesmo que realTime falhe', async () => {
    st.delay = 120;
    const t0 = Date.now();
    const res = makeRes();
    await handler({ query: { month: '10', year: '2026' }, user: { id: 'u', role: 'admin' } }, res);
    const prof = st.events.find(e => e.name === 'prof:doctors');
    const firstOther = st.events.find(e => e.name === 'other:settled');
    expect(prof, 'profissionais nunca iniciou (ainda esperando realTime)').toBeDefined();
    expect(prof.t - t0).toBeLessThan(60);          // disparada no início do handler
    expect(firstOther).toBeDefined();
    expect(prof.t).toBeLessThan(firstOther.t);     // antes de qualquer etapa lenta (realTime, etc.) terminar
    expect(res.statusCode).toBe(500);              // as demais etapas falham (mock) e o handler responde 500, sem travar
  });
});
