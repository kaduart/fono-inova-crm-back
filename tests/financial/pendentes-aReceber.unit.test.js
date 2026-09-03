/**
 * =============================================================================
 * TESTES UNITÁRIOS — calculatePendentes / calculateAReceber
 * =============================================================================
 *
 * Valida que as funções do dashboard financeiro filtram e calculam no MongoDB
 * (aggregation / $lookup) em vez de trazer todos os pendentes e filtrar em JS.
 *
 * Run: npx vitest run tests/financial/pendentes-aReceber.unit.test.js
 * =============================================================================
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import moment from 'moment-timezone';

const TZ = 'America/Sao_Paulo';

const mockPaymentAggregate = vi.fn();
const mockPaymentFind = vi.fn();

function mockAggregateResult(result) {
  const p = Promise.resolve(result);
  p.allowDiskUse = vi.fn().mockReturnValue(p);
  return p;
}

vi.mock('../../models/Payment.js', () => ({
  default: {
    aggregate: (...args) => mockPaymentAggregate(...args),
    find:      (...args) => mockPaymentFind(...args),
  }
}));

vi.mock('../../models/Payment.js', () => ({
  default: {
    aggregate: (...args) => mockPaymentAggregate(...args),
    find:      (...args) => mockPaymentFind(...args),
  }
}));

// Models importados pelo router mas não usados por estas funções
vi.mock('../../models/Appointment.js', () => ({ default: {} }));
vi.mock('../../models/Session.js',     () => ({ default: {} }));
vi.mock('../../models/Expense.js',     () => ({ default: {} }));
vi.mock('../../models/Doctor.js',      () => ({ default: {} }));
vi.mock('../../models/FinancialGoal.js', () => ({ default: {} }));
vi.mock('../../models/Planning.js',    () => ({ default: {} }));
vi.mock('../../models/FinancialLedger.js', () => ({ default: {} }));
vi.mock('../../models/FinancialDailySnapshot.js', () => ({ default: {} }));
vi.mock('../../models/Package.js',      () => ({ default: {} }));

vi.mock('../../services/financialEngine.js', () => ({
  calculatePendentesEngine: vi.fn(),
  getPatientPendingPayments: vi.fn(),
}));
vi.mock('../../services/financialMetrics.service.js', () => ({ default: {} }));
vi.mock('../../services/financialSnapshot.service.js', () => ({ default: {} }));
vi.mock('../../services/financialExpenseSnapshot.service.js', () => ({ default: {} }));
vi.mock('../../services/unifiedFinancialService.v2.js', () => ({ default: {}, invalidateUFSCache: vi.fn() }));
vi.mock('../../contracts/FinancialReport.js', () => ({ buildCaixaBlock: vi.fn(), buildProducaoBlock: vi.fn() }));
vi.mock('../../utils/logMetric.js', () => ({ logMetric: vi.fn() }));
vi.mock('../../scripts/audits/lib/classifica-payments-convenio.js', () => ({ classifyConvenioPayments: vi.fn() }));
vi.mock('../../utils/billingHelpers.js', () => ({ isConvenioSession: vi.fn() }));
// calculateAReceber passou a chamar getInsuranceGuidesView() pra preencher
// `historico` (fix 2026-09-02) — sem mock, a chamada real tenta abrir modelos
// Mongoose sem conexão de banco e trava até o timeout do teste. Retorna
// competenceBreakdown vazio: historico=0, preservando o valor original
// esperado por este teste (que não exercita esse caminho).
vi.mock('../../services/insuranceGuide/insuranceGuidesReadView.js', () => ({
  getInsuranceGuidesView: vi.fn().mockResolvedValue({ competenceBreakdown: { previous: { value: 0 } } }),
}));

import { calculatePendentes, calculateAReceber } from '../../routes/financialDashboard.v2.js';

function buildPayment(overrides = {}) {
  return {
    _id: 'payment-id',
    amount: 100,
    status: 'pending',
    billingType: 'particular',
    paymentMethod: 'pix',
    paymentDate: moment.tz('2026-05-10', TZ).startOf('day').toDate(),
    serviceDate: null,
    appointment: null,
    patient: { _id: 'patient-id', fullName: 'Paciente Teste' },
    doctor: null,
    notes: null,
    insurance: { provider: null, insuranceCompany: null },
    ...overrides
  };
}

function buildPaymentWithAppointment(overrides = {}) {
  return buildPayment({
    appointment: {
      _id: 'appt-id',
      date: moment.tz('2026-05-10', TZ).startOf('day').toDate(),
      time: '09:00',
      operationalStatus: 'completed'
    },
    ...overrides
  });
}

function buildPaymentConvenio(overrides = {}) {
  return buildPaymentWithAppointment({
    billingType: 'convenio',
    paymentMethod: 'convenio',
    insurance: { provider: 'Unimed', insuranceCompany: 'Unimed' },
    ...overrides
  });
}

describe('calculateAReceber', () => {
  beforeEach(() => {
    mockPaymentAggregate.mockReset();
    mockPaymentFind.mockReset();
  });

  it('usa aggregation com $match, $lookup em appointments e $group — sem populate/filter em JS', async () => {
    mockPaymentAggregate.mockImplementation(() => mockAggregateResult([{ total: 250, count: 2 }]));

    const result = await calculateAReceber(2026, 5);

    expect(result).toEqual({ total: 250, mesAtual: 250, historico: 0 });
    expect(mockPaymentFind).not.toHaveBeenCalled();
    expect(mockPaymentAggregate).toHaveBeenCalledTimes(1);

    const pipeline = mockPaymentAggregate.mock.calls[0][0];
    expect(pipeline[0]).toHaveProperty('$match');
    expect(pipeline[0].$match).toHaveProperty('status', 'pending');
    expect(pipeline[0].$match).toHaveProperty('$and');
    expect(pipeline.some(stage => stage.$lookup && stage.$lookup.from === 'appointments')).toBe(true);
    expect(pipeline.some(stage => stage.$group && stage.$group.total)).toBe(true);
  });
});

describe('calculatePendentes', () => {
  beforeEach(() => {
    mockPaymentAggregate.mockReset();
    mockPaymentFind.mockReset();
  });

  it('não usa Payment.find({ status: pending }) para carregar histórico — usa aggregation filtrada', async () => {
    // Primeira chamada = fetchPendingPaymentsByDateRange (mês)
    // Segunda chamada = total absoluto de pendentes
    // Terceira chamada = fetchPendingPaymentsPreviousCompetence
    let call = 0;
    mockPaymentAggregate.mockImplementation(() => {
      call++;
      if (call === 1) {
        return mockAggregateResult([
          buildPaymentWithAppointment({ amount: 150 }),
          buildPaymentConvenio({ amount: 200 })
        ]);
      }
      if (call === 2) {
        return mockAggregateResult([{ total: 10000, count: 50 }]);
      }
      return mockAggregateResult([buildPaymentWithAppointment({ amount: 300, appointment: {
        _id: 'prev-appt',
        date: moment.tz('2026-04-10', TZ).startOf('day').toDate(),
        time: '10:00',
        operationalStatus: 'completed'
      }})]);
    });

    const result = await calculatePendentes(2026, 5);

    expect(mockPaymentFind).not.toHaveBeenCalled();
    expect(mockPaymentAggregate).toHaveBeenCalledTimes(3);

    // Contrato de retorno preservado
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('allPendingTotal');
    expect(result).toHaveProperty('convenio');
    expect(result).toHaveProperty('particular');
    expect(result).toHaveProperty('vencidos');
    expect(result).toHaveProperty('v2_financial');
    expect(result).toHaveProperty('previousCompetenceDebt');

    expect(result.convenio.total).toBe(200);
    expect(result.convenio.count).toBe(1);
    expect(result.particular.total).toBe(150);
    expect(result.particular.count).toBe(1);
    expect(result.total).toBe(350);
    expect(result.allPendingTotal).toBe(10000);
    expect(result.previousCompetenceDebt.total).toBe(300);
  });
});
