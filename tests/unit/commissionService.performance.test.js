import { describe, it, expect, vi, beforeEach } from 'vitest';

// Faturamento x custo por profissional (09/11/2026): salário fixo entra no painel
// com o fixo como custo; quem é por comissão usa a comissão calculada.
const st = vi.hoisted(() => ({ doctors: [], sessionsByDoctor: {} }));

const q = (result) => { const c = { select: () => c, populate: () => c, lean: () => c, session: () => c, then: (a, b) => Promise.resolve(result).then(a, b) }; return c; };

vi.mock('../../models/Doctor.js', () => ({
  default: {
    find: () => q(st.doctors),
    findById: (id) => q(st.doctors.find(d => String(d._id) === String(id)) || null),
  },
}));
vi.mock('../../models/Session.js', () => ({
  default: { find: (m) => q(st.sessionsByDoctor[String(m.doctor)] || []) },
}));
const expenseMock = vi.hoisted(() => ({ existing: null, created: [] }));
vi.mock('../../models/Expense.js', () => ({ default: {
  findOne: () => q(expenseMock.existing),
  create: vi.fn(async (docs) => { expenseMock.created.push(...docs); return docs.map((d, i) => ({ ...d, _id: `e${i}` })); }),
  deleteOne: vi.fn(),
} }));
vi.mock('mongoose', async (orig) => {
  const m = await orig();
  const fakeSession = { startTransaction: async () => {}, commitTransaction: async () => {}, abortTransaction: async () => {}, endSession: () => {} };
  return { ...m, default: { ...m.default, startSession: async () => fakeSession } };
});
vi.mock('../../routes/expenses.v2.js', () => ({ invalidateExpenseCache: vi.fn() }));
vi.mock('../../utils/resolveSessionFinancialValue.js', () => ({ resolveSessionFinancialValue: (s) => s.sessionValue }));
vi.mock('../../services/commissionRule.service.js', () => ({
  classifySessionForCommission: (s) => ({ billingType: s.billingType || 'particular' }),
  calculateCommissionBatch: (doctor, sessions) => {
    const base = sessions.reduce((s, x) => s + x.sessionValue, 0);
    const perSession = doctor.commissionRules?.rules?.length ? 65 : 0;
    return { totalCommission: perSession * sessions.length, totalProductionBase: base, breakdown: { standardSessions: { count: sessions.length, value: 0, byInsurance: {} }, evaluations: { count: 0, value: 0 }, neuropsychEvaluations: { count: 0, value: 0 } } };
  },
}));

const { buildProfessionalPerformance, resolveCompensation, generateMonthlyCommissions } = await import('../../services/commissionService.js');

const sessions = (n, value, billingType = 'particular') => Array.from({ length: n }, (_, i) => ({ _id: `s${billingType}${i}`, status: 'completed', sessionValue: value, billingType, patient: `p${i % 7}` }));

describe('resolveCompensation', () => {
  it('só é fixo com model fixed_monthly e valor > 0', () => {
    expect(resolveCompensation({ compensation: { model: 'fixed_monthly', fixedMonthlyAmount: 4800 } })).toEqual({ model: 'fixed_monthly', fixedMonthlyAmount: 4800 });
    expect(resolveCompensation({ compensation: { model: 'fixed_monthly', fixedMonthlyAmount: 0 } }).model).toBe('commission');
    expect(resolveCompensation({}).model).toBe('commission');
  });
});

describe('buildProfessionalPerformance', () => {
  beforeEach(() => {
    st.doctors = [
      { _id: 'd1', fullName: 'Fixa', specialty: 'fonoaudiologia', compensation: { model: 'fixed_monthly', fixedMonthlyAmount: 4800 } },
      { _id: 'd2', fullName: 'Comissionada', specialty: 'psicologia', commissionRules: { rules: [{}] } },
      { _id: 'd3', fullName: 'Sem regra', specialty: 'psicologia' },
      { _id: 'd4', fullName: 'Sem sessão', specialty: 'psicologia', commissionRules: { rules: [{}] } },
    ];
    st.sessionsByDoctor = { d1: [...sessions(21, 200, 'convenio'), ...sessions(20, 200, 'package')], d2: sessions(10, 150), d3: sessions(3, 100) };
    expenseMock.existing = null; expenseMock.created = [];
  });

  it('usa o fixo como custo, a comissão para os demais e ordena por faturamento', async () => {
    const { rows, totals } = await buildProfessionalPerformance(10, 2099);
    expect(rows.map(r => r.doctorName)).toEqual(['Fixa', 'Comissionada', 'Sem regra']);

    const fixa = rows[0];
    expect(fixa).toMatchObject({ compensationModel: 'fixed_monthly', sessions: 41, revenue: 8200, cost: 4800, result: 3400, commission: 0 });
    expect(fixa.costShare).toBeCloseTo(58.54, 2);
    expect(fixa.missingCommissionRules).toBe(false);
    expect(fixa.revenueByOrigin).toEqual({ convenio: 4200, pacote: 4000, liminar: 0, avulso: 0 });
    expect(fixa.patientsCount).toBe(7);
    // Sem regra própria: simula com a regra padrão da equipe (mock = 65/sessão)
    expect(fixa).toMatchObject({ commissionIfPerSession: 41 * 65, simulatedWithStandardRules: true });

    expect(rows[1]).toMatchObject({ compensationModel: 'commission', revenue: 1500, cost: 650, result: 850 });
    expect(rows[2]).toMatchObject({ cost: 0, missingCommissionRules: true });

    expect(totals).toMatchObject({ sessions: 54, revenue: 10000, cost: 5450, result: 4550 });
  });

  it('profissional fixo aparece mesmo sem atendimento no mês', async () => {
    st.sessionsByDoctor = {};
    const { rows } = await buildProfessionalPerformance(9, 2099);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ doctorName: 'Fixa', revenue: 0, cost: 4800, result: -4800, costShare: null });
  });
});

describe('generateMonthlyCommissions com salário fixo', () => {
  beforeEach(() => {
    st.doctors = [
      { _id: 'f1', fullName: 'Fixa', specialty: 'fonoaudiologia', compensation: { model: 'fixed_monthly', fixedMonthlyAmount: 4800 } },
    ];
    st.sessionsByDoctor = { f1: sessions(5, 200, 'convenio') };
    expenseMock.existing = null; expenseMock.created = [];
  });

  it('cria a despesa de folha do fixo com o faturamento no detalhe', async () => {
    const r = await generateMonthlyCommissions(8, 2099);
    expect(r.generated).toBe(1);
    const e = expenseMock.created[0];
    expect(e).toMatchObject({ category: 'payroll', subcategory: 'salary', amount: 4800, status: 'pending' });
    expect(e.description).toContain('(salário fixo)');
    expect(e.workPeriod).toMatchObject({ sessionsCount: 5, revenueGenerated: 1000 });
    expect(JSON.parse(e.notes)).toMatchObject({ revenueByOrigin: { convenio: 1000 }, result: -3800 });
  });

  it('não cria de novo se já existe folha do profissional no mês', async () => {
    expenseMock.existing = { _id: 'x1', status: 'pending' };
    const r = await generateMonthlyCommissions(7, 2099);
    expect(r.generated).toBe(0);
    expect(expenseMock.created).toHaveLength(0);
    expect(r.details[0]).toMatchObject({ skipped: true });
  });
});
