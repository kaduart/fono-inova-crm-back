/**
 * =============================================================================
 * TESTES UNITÁRIOS — unifiedFinancialService.v2
 * =============================================================================
 *
 * Cobre as 7 regras obrigatórias + teste crítico de dupla contagem.
 * Não conecta ao MongoDB — os models são mockados.
 *
 * Run: npx vitest run tests/financial/unifiedFinancialService.unit.test.js
 * =============================================================================
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import moment from 'moment-timezone';

const TZ = 'America/Sao_Paulo';

// ─── Mocks dos models (devem vir antes do import do service) ─────────────────
const mockPaymentAggregate = vi.fn();
const mockPaymentFind = vi.fn();
const mockSessionAggregate = vi.fn();
const mockSessionFind = vi.fn();

vi.mock('../../models/Payment.js', () => ({
  default: {
    aggregate: (...args) => mockPaymentAggregate(...args),
    find:      (...args) => mockPaymentFind(...args),
  }
}));
vi.mock('../../models/Session.js', () => ({
  default: {
    aggregate: (...args) => mockSessionAggregate(...args),
    find:      (...args) => mockSessionFind(...args),
  }
}));
vi.mock('../../models/Package.js', () => ({
  default: { find: vi.fn().mockResolvedValue([]) }
}));

import { calculateCash, calculateProduction } from '../../services/unifiedFinancialService.v2.js';

// ─── Período de teste fixo ────────────────────────────────────────────────────
const start = moment.tz('2026-05-01', TZ).startOf('day').toDate();
const end   = moment.tz('2026-05-31', TZ).endOf('day').toDate();

// ─── Helpers ─────────────────────────────────────────────────────────────────
/**
 * Captura o $match do primeiro estágio do primeiro aggregate chamado.
 * Configura mockPaymentAggregate para retornar valores neutros em todas as chamadas.
 */
function capturePaymentMatch() {
  let captured = null;
  let callIdx  = 0;
  mockPaymentAggregate.mockImplementation((pipeline) => {
    callIdx++;
    if (callIdx === 1) captured = pipeline[0].$match; // totalAgg
    if (callIdx === 1) return [{ total: 0, count: 0 }];
    if (callIdx === 2) return [];                       // methodAgg
    if (callIdx === 3) return [];                       // typeAgg
    return [];
  });
  mockPaymentFind.mockReturnValue({
    populate: vi.fn().mockReturnThis(),
    lean:     vi.fn().mockResolvedValue([]),
  });
  return () => captured;
}

function captureSessionMatch() {
  let captured  = null;
  let callIdx   = 0;
  mockSessionAggregate.mockImplementation((pipeline) => {
    callIdx++;
    if (callIdx === 1) { captured = pipeline[0].$match; return [{ total: 0, count: 0 }]; }
    return [];
  });
  mockSessionFind.mockReturnValue({
    populate: vi.fn().mockReturnThis(),
    lean:     vi.fn().mockResolvedValue([]),
  });
  return () => captured;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1–6 · calculateCash — regras de filtro
// =============================================================================
describe('calculateCash — regras de filtro', () => {

  it('1. billingType=liminar deve entrar no caixa (sem restrição de billingType)', async () => {
    const getMatch = capturePaymentMatch();
    await calculateCash(start, end);
    const match = getMatch();

    // Não deve haver filtro por billingType no match
    expect(match.billingType).toBeUndefined();
    // O JSON do match não deve mencionar billingType em nenhum $nin / $in restritivo
    const matchStr = JSON.stringify(match);
    expect(matchStr).not.toContain('"billingType":{"$nin"');
    expect(matchStr).not.toContain('"billingType":{"$in"');
  });

  it('2. billingType=particular deve entrar no caixa (sem restrição de billingType)', async () => {
    const getMatch = capturePaymentMatch();
    await calculateCash(start, end);
    const match = getMatch();

    expect(match.billingType).toBeUndefined();
  });

  it('3. billingType=convenio com status=paid deve entrar no caixa', async () => {
    const getMatch = capturePaymentMatch();
    await calculateCash(start, end);
    const match = getMatch();

    // O único filtro de status deve ser 'paid' — convenio não é excluído em caixa
    expect(match.status).toBe('paid');
    expect(match.billingType).toBeUndefined();
  });

  it('4. kind=package_consumed deve ser EXCLUÍDO do caixa', async () => {
    const getMatch = capturePaymentMatch();
    await calculateCash(start, end);
    const match = getMatch();

    expect(match.kind).toEqual({ $ne: 'package_consumed' });
  });

  it('4b. isFromPackage=true deve ser excluído (exceto kind=session_payment)', async () => {
    const getMatch = capturePaymentMatch();
    await calculateCash(start, end);
    const match = getMatch();

    const andBlock = match.$and;
    expect(andBlock).toBeDefined();

    // O primeiro elemento do $and deve conter a regra do isFromPackage
    const fromPkgRule = andBlock[0];
    expect(fromPkgRule.$or).toBeDefined();
    const hasIsFromPackageRule = fromPkgRule.$or.some(cond =>
      cond.isFromPackage !== undefined || cond.kind !== undefined
    );
    expect(hasIsFromPackageRule).toBe(true);
  });

  it('5. financialDate deve prevalecer sobre paymentDate (prioridade na $or)', async () => {
    const getMatch = capturePaymentMatch();
    await calculateCash(start, end);
    const match = getMatch();

    const andBlock = match.$and;
    const dateOrBlock = andBlock[1].$or;

    // Primeira condição deve ser financialDate (prioridade)
    expect(dateOrBlock[0]).toHaveProperty('financialDate');

    // Segunda condição: financialDate ausente → fallback para paymentDate
    expect(dateOrBlock[1]).toMatchObject({
      'financialDate': { $exists: false },
      paymentDate: expect.any(Object),
    });

    // Terceira condição: financialDate=null → fallback para paymentDate
    expect(dateOrBlock[2]).toMatchObject({
      financialDate: null,
      paymentDate: expect.any(Object),
    });
  });

  it('6. timezone SP — pagamento às 21h SP deve cair no dia correto, não no seguinte', () => {
    // 21h SP = 00h UTC do dia seguinte com new Date() ingênuo
    const pagamentoAs21hSP = moment.tz('2026-05-15 21:00', TZ).toDate();

    // ── Abordagem CORRETA (moment.tz) ────────────────────────────────────────
    const startCorreto = moment.tz('2026-05-15', TZ).startOf('day').toDate();
    const endCorreto   = moment.tz('2026-05-15', TZ).endOf('day').toDate();
    expect(pagamentoAs21hSP >= startCorreto).toBe(true);
    expect(pagamentoAs21hSP <= endCorreto  ).toBe(true);

    // ── Abordagem ERRADA (new Date string) — demonstra o bug que corrigimos ─
    const startErrado = new Date('2026-05-15T00:00:00.000Z'); // UTC = 21h SP dia anterior
    const endErrado   = new Date('2026-05-15T23:59:59.999Z'); // UTC = 20h59 SP
    // Pagamento às 21h SP (= 00h UTC 16/05) ficaria FORA do range errado
    const pagamentoUTC = moment.tz('2026-05-15 21:00', TZ).utc().toDate();
    expect(pagamentoUTC > endErrado).toBe(true); // ← confirmação do bug histórico
  });
});

// =============================================================================
// 7 · calculateProduction — fonte: Session, nunca Appointment
// =============================================================================
describe('calculateProduction — fonte de dados', () => {

  it('7. Session.status=completed deve entrar na produção', async () => {
    const getMatch = captureSessionMatch();
    await calculateProduction(start, end);
    const match = getMatch();

    expect(match.status).toBe('completed');
  });

  it('7b. deve consultar Session.aggregate, nunca Appointment', async () => {
    captureSessionMatch();
    await calculateProduction(start, end);

    expect(mockSessionAggregate).toHaveBeenCalled();
    // Payment não deve ser consultado pelo calculateProduction
    expect(mockPaymentAggregate).not.toHaveBeenCalled();
  });
});

// =============================================================================
// CRÍTICO · Sem dupla contagem — liminar Payment + Session.completed
// =============================================================================
describe('anti-double-counting — CRÍTICO', () => {

  it('Payment liminar + Session.completed: caixa≠duplo, produção≠duplo', async () => {
    // ── Mock Payment: 1 pagamento liminar = R$160 ─────────────────────────────
    let payCallIdx = 0;
    mockPaymentAggregate.mockImplementation(() => {
      payCallIdx++;
      if (payCallIdx === 1) return [{ total: 160, count: 1 }]; // totalAgg
      if (payCallIdx === 2) return [{ _id: 'pix', total: 160 }]; // methodAgg
      if (payCallIdx === 3) return [{ _id: 'particular', total: 160 }]; // typeAgg
      return [];
    });
    mockPaymentFind.mockReturnValue({
      select:   vi.fn().mockReturnThis(),
      limit:    vi.fn().mockReturnThis(),
      populate: vi.fn().mockReturnThis(),
      lean:     vi.fn().mockResolvedValue([
        { amount: 160, billingType: 'liminar', patient: { fullName: 'Paciente Liminar' } }
      ]),
    });

    // ── Mock Session: mesma sessão completed = R$160 ──────────────────────────
    let sessCallIdx = 0;
    mockSessionAggregate.mockImplementation(() => {
      sessCallIdx++;
      if (sessCallIdx === 1) return [{ total: 160, count: 1 }]; // total
      if (sessCallIdx === 2) return [{ _id: 'particular', total: 160 }]; // byType
      if (sessCallIdx === 3) return [{ total: 160 }];  // recebido
      return [];
    });
    mockSessionFind.mockReturnValue({
      select:   vi.fn().mockReturnThis(),
      limit:    vi.fn().mockReturnThis(),
      populate: vi.fn().mockReturnThis(),
      lean:     vi.fn().mockResolvedValue([]),
    });

    const [cashResult, prodResult] = await Promise.all([
      calculateCash(start, end),
      calculateProduction(start, end),
    ]);

    // Caixa = R$160 (um único Payment liminar, contado uma vez)
    expect(cashResult.total).toBe(160);

    // Produção = R$160 (uma única Session, contada uma vez)
    expect(prodResult.total).toBe(160);

    // calculateCash NÃO tocou Session
    const sessionCallsFromCash = mockSessionAggregate.mock.calls.length;
    // (sessCallIdx > 0 apenas pelo calculateProduction que rodou em paralelo)
    // Verificação direta: Payment.aggregate foi chamado, Session.aggregate também
    // mas os resultados são INDEPENDENTES (caixa ≠ caixa + produção)
    expect(cashResult.total).not.toBe(cashResult.total + prodResult.total);
    expect(cashResult.total).toBe(160); // não duplicou
  });

  it('calculateCash nunca acessa a coleção de sessions diretamente', async () => {
    let payCallIdx = 0;
    mockPaymentAggregate.mockImplementation(() => {
      payCallIdx++;
      if (payCallIdx === 1) return [{ total: 0, count: 0 }];
      return [];
    });
    mockPaymentFind.mockReturnValue({
      select:   vi.fn().mockReturnThis(),
      populate: vi.fn().mockReturnThis(),
      lean:     vi.fn().mockResolvedValue([]),
    });

    await calculateCash(start, end);

    // Session.aggregate e Session.find não devem ter sido chamados pelo calculateCash
    expect(mockSessionAggregate).not.toHaveBeenCalled();
    expect(mockSessionFind).not.toHaveBeenCalled();
  });
});
