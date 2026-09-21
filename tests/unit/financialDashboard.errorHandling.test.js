import { describe, it, expect, vi, beforeEach } from 'vitest';

// Handler REAL de GET /v2/financial/dashboard; toda consulta ao banco/serviço rejeita ("mongo fora").
const { failing, stats } = vi.hoisted(() => {
  const stats = { calls: 0 };
  const failing = () => {
    const err = new Error('mongo down');
    const chain = new Proxy(function () {}, {
      get: (_t, p) => {
        if (p === 'then') { stats.calls++; return (_res, rej) => rej(err); }
        if (p === Symbol.toPrimitive || p === 'toJSON') return undefined;
        return chain;
      },
      apply: () => chain,
      construct: () => chain,
    });
    return chain;
  };
  return { failing, stats };
});

vi.mock('../../middleware/auth.js', () => ({ auth: (_q, _s, n) => n(), authorize: () => (_q, _s, n) => n() }));
vi.mock('../../models/Payment.js', () => ({ default: failing() }));
vi.mock('../../models/Appointment.js', () => ({ default: failing() }));
vi.mock('../../models/Session.js', () => ({ default: failing() }));
vi.mock('../../models/Expense.js', () => ({ default: failing() }));
vi.mock('../../models/Doctor.js', () => ({ default: failing() }));
vi.mock('../../models/FinancialGoal.js', () => ({ default: failing() }));
vi.mock('../../models/Planning.js', () => ({ default: failing() }));
vi.mock('../../models/FinancialLedger.js', () => ({ default: failing() }));
vi.mock('../../models/FinancialDailySnapshot.js', () => ({ default: failing() }));
vi.mock('../../models/Package.js', () => ({ default: failing() }));
vi.mock('../../services/commissionService.js', () => ({ calculateDoctorCommission: vi.fn() }));
vi.mock('../../services/commissionRule.service.js', () => ({ calculateCommissionBatch: vi.fn() }));
vi.mock('../../services/financialMetrics.service.js', () => ({ default: failing() }));
vi.mock('../../services/financialExpenseSnapshot.service.js', () => ({ default: failing() }));
vi.mock('../../services/financialEngine.js', () => ({ calculatePendentesEngine: failing(), getPatientPendingPayments: failing() }));
vi.mock('../../services/insuranceGuide/insuranceGuidesReadView.js', () => ({ getInsuranceGuidesView: failing() }));
vi.mock('../../services/unifiedFinancialService.v2.js', () => ({
  default: failing(), invalidateUFSCache: vi.fn(), invalidateUFSCacheForDates: vi.fn(),
}));
vi.mock('../../scripts/audits/lib/classifica-payments-convenio.js', () => ({ classifyConvenioPayments: vi.fn() }));
vi.mock('../../utils/logMetric.js', () => ({ logMetric: () => {} }));

import router from '../../routes/financialDashboard.v2.js';

const handler = router.stack.find(l => l.route?.path === '/' && l.route.methods.get).route.stack.at(-1).handle;

const makeRes = () => {
  const res = {
    statusCode: 200, body: undefined, finished: false, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.finished = true; return this; },
  };
  return res;
};
const call = (month = '9', year = '2026') => {
  const res = makeRes();
  const p = handler({ query: { month, year }, user: { id: 'u1', role: 'admin' } }, res);
  return { res, p };
};
const settle = (p, ms = 1500) => Promise.race([
  p.then(() => 'resolved', () => 'rejected'),
  new Promise(r => setTimeout(() => r('HANG'), ms)),
]);

describe('GET /v2/financial/dashboard — falha no cálculo', () => {
  beforeEach(() => { stats.calls = 0; vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); });

  it('responde 500 (o catch não pode lançar)', async () => {
    const { res, p } = call('9', '2026');
    expect(await settle(p)).toBe('resolved');
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ success: false });
  });

  it('não deixa o mês travado em PENDING: nova requisição é processada e responde', async () => {
    await settle(call('8', '2026').p);
    const before = stats.calls;
    const second = call('8', '2026');
    expect(await settle(second.p)).toBe('resolved');   // sem o fix: pendura para sempre
    expect(second.res.statusCode).toBe(500);
    expect(stats.calls).toBeGreaterThan(before);        // recalculou de fato
  });

  it('requisição concorrente que aguardava a primeira também é atendida', async () => {
    const a = call('7', '2026');
    const b = call('7', '2026');                        // entra em PENDING
    expect(await settle(a.p)).toBe('resolved');
    expect(await settle(b.p)).toBe('resolved');
    expect(a.res.statusCode).toBe(500);
    expect(b.res.statusCode).toBe(500);
  });

  it('o corpo de erro NÃO é cacheado como resposta válida do mês', async () => {
    await settle(call('6', '2026').p);
    const before = stats.calls;
    const again = call('6', '2026');
    await settle(again.p);
    expect(again.res.headers['X-Cache-Status']).not.toBe('HIT');
    expect(again.res.statusCode).toBe(500);
    expect(stats.calls).toBeGreaterThan(before);
  });
});
