import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fixture "banco": documentos completos de Payment (com campos pesados que a lista projetada não traz).
const { db, findCalls, aggCalls, delay } = vi.hoisted(() => ({
  db: { payments: [] },
  findCalls: [],
  aggCalls: [],
  delay: ms => new Promise(r => setTimeout(r, ms))
}));

// Simula Payment.find(match).select(sel).populate(...).lean() — thenable como o Query real.
// A projeção é aplicada de verdade (só os campos pedidos + _id), pra provar o que chega ao caller.
vi.mock('../../models/Payment.js', () => {
  const project = (doc, sel) => {
    if (!sel) return structuredClone(doc);
    const keep = new Set(sel.split(/\s+/).filter(Boolean));
    const out = {};
    for (const k of Object.keys(doc)) if (keep.has(k) || k === '_id') out[k] = structuredClone(doc[k]);
    return out;
  };
  return {
    default: {
      find: (match) => {
        const call = { select: null, match };
        findCalls.push(call);
        const q = {
          select(sel) { call.select = sel; return q; },
          populate() { return q; },
          lean() {
            return delay(15).then(() => db.payments.map(d => project(d, call.select)));
          }
        };
        return q;
      },
      aggregate: (pipeline) => {
        aggCalls.push(pipeline);
        const total = db.payments.reduce((s, p) => s + p.amount, 0);
        return delay(5).then(() => [{
          total: [{ _id: null, total, count: db.payments.length }],
          byMethod: [{ _id: 'pix', total }],
          byType: [{ _id: 'particular', total }]
        }]);
      }
    }
  };
});
vi.mock('../../models/Session.js', () => ({ default: {} }));
vi.mock('../../models/Package.js', () => ({ default: {} }));
vi.mock('../../models/Appointment.js', () => ({ default: {} }));
vi.mock('../../utils/logMetric.js', () => ({ logMetric: () => {} }));

import {
  calculateCash,
  invalidateUFSCache,
  invalidateUFSCacheForDates
} from '../../services/unifiedFinancialService.v2.js';

const MONTH_FIELDS = '_id amount session kind financialDate paymentDate patient';
const YESTERDAY_FIELDS = '_id amount appointment session notes description billingType paymentMethod type serviceType package financialDate createdAt patient';

const range = (s, e) => [new Date(s), new Date(e)];
const [S1, E1] = range('2026-09-01T03:00:00.000Z', '2026-10-01T02:59:59.999Z'); // setembro
const [S2, E2] = range('2026-08-01T03:00:00.000Z', '2026-09-01T02:59:59.999Z'); // agosto

const fullDoc = (id, amount) => ({
  _id: id,
  amount,
  kind: 'session_payment',
  session: `s-${id}`,
  appointment: `a-${id}`,
  patient: { _id: `p-${id}`, fullName: `Paciente ${id}` },
  financialDate: new Date('2026-09-10T15:00:00Z'),
  paymentDate: new Date('2026-09-10T15:00:00Z'),
  billingType: 'particular',
  paymentMethod: 'pix',
  // campos pesados que só a lista completa carrega
  insurance: { provider: 'unimed', authorizationCode: 'X1' },
  integrityMetadata: { hash: 'abc', version: 2 },
  notes: 'nota longa'
});

const HEAVY = ['insurance', 'integrityMetadata'];

beforeEach(() => {
  invalidateUFSCache();
  findCalls.length = 0;
  aggCalls.length = 0;
  db.payments = [fullDoc('1', 100), fullDoc('2', 250)];
});

describe('calculateCash — detailSelect não mistura resultados completos e projetados', () => {
  it('completo primeiro, projetado depois: cada um recebe o seu formato', async () => {
    const full = await calculateCash(S1, E1);
    const slim = await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });

    for (const h of HEAVY) expect(full.payments[0]).toHaveProperty(h);
    for (const h of [...HEAVY, 'notes', 'billingType', 'paymentMethod', 'appointment']) {
      expect(slim.payments[0]).not.toHaveProperty(h);
    }
    expect(slim.payments[0]).toHaveProperty('financialDate');
    expect(findCalls).toHaveLength(2);
    expect(findCalls[0].select).toBeNull();
    expect(findCalls[1].select).toBe(MONTH_FIELDS);
  });

  it('projetado primeiro, completo depois: o completo NÃO herda a lista enxuta', async () => {
    const slim = await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });
    const full = await calculateCash(S1, E1);

    expect(slim.payments[0]).not.toHaveProperty('insurance');
    expect(full.payments[0]).toHaveProperty('insurance');
    expect(full.payments[0]).toHaveProperty('integrityMetadata');
    expect(findCalls).toHaveLength(2);
  });

  it('chamadas simultâneas (em andamento): completo e projetado não compartilham resultado', async () => {
    const [slim, full, slimY] = await Promise.all([
      calculateCash(S1, E1, { detailSelect: MONTH_FIELDS }),
      calculateCash(S1, E1),
      calculateCash(S1, E1, { detailSelect: YESTERDAY_FIELDS })
    ]);
    expect(slim.payments[0]).not.toHaveProperty('insurance');
    expect(slim.payments[0]).not.toHaveProperty('notes');
    expect(full.payments[0]).toHaveProperty('insurance');
    expect(slimY.payments[0]).toHaveProperty('notes');          // projeção "ontem" traz notes
    expect(slimY.payments[0]).not.toHaveProperty('insurance');  // mas não insurance
    expect(findCalls.map(c => c.select).sort()).toEqual([null, MONTH_FIELDS, YESTERDAY_FIELDS].sort());
  });

  it('duas projeções distintas no mesmo período têm entradas de cache distintas', async () => {
    const month = await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });
    const yest = await calculateCash(S1, E1, { detailSelect: YESTERDAY_FIELDS });
    expect(month.payments[0]).not.toHaveProperty('notes');
    expect(yest.payments[0]).toHaveProperty('notes');
    expect(findCalls).toHaveLength(2);
  });

  it('cache hit devolve a MESMA forma de cada variante (repetido, ordem cruzada)', async () => {
    const a1 = await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });
    const b1 = await calculateCash(S1, E1);
    const a2 = await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });
    const b2 = await calculateCash(S1, E1);

    expect(findCalls).toHaveLength(2); // 2 e 3 vieram do cache
    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
    expect(a2.payments[0]).not.toHaveProperty('insurance');
    expect(b2.payments[0]).toHaveProperty('insurance');
  });

  it('KPIs (total, count, byMethod, tipos) são idênticos entre completo e projetado', async () => {
    const full = await calculateCash(S1, E1);
    const slim = await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });
    const { payments: _p1, ...kFull } = full;
    const { payments: _p2, ...kSlim } = slim;
    expect(kSlim).toEqual(kFull);
    expect(slim.payments.map(p => [p._id, p.amount])).toEqual(full.payments.map(p => [p._id, p.amount]));
  });

  it('filtro de paciente de teste continua valendo com a projeção (patient está na lista)', async () => {
    db.payments.push({ ...fullDoc('3', 999), patient: { _id: 'p-3', fullName: 'Paciente Teste' } });
    const full = await calculateCash(S1, E1);
    const slim = await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });
    expect(full.payments.map(p => p._id)).toEqual(['1', '2']);
    expect(slim.payments.map(p => p._id)).toEqual(['1', '2']);
  });

  it('includeDetails:false / skipPayments:true não usam nem poluem o cache das listas', async () => {
    const light = await calculateCash(S1, E1, { includeDetails: false });
    const slim = await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });
    const skip = await calculateCash(S1, E1, { skipPayments: true, detailSelect: MONTH_FIELDS });
    expect(light.payments).toEqual([]);
    expect(skip.payments).toEqual([]);
    expect(slim.payments).toHaveLength(2);
  });

  it('invalidateUFSCacheForDates limpa completo E projetado do período afetado e preserva os outros', async () => {
    await calculateCash(S1, E1);                                   // set/2026 completo
    await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });   // set/2026 projetado (chave com `_id`/`_` no sufixo)
    await calculateCash(S2, E2);                                   // ago/2026 completo
    await calculateCash(S2, E2, { detailSelect: MONTH_FIELDS });   // ago/2026 projetado
    expect(findCalls).toHaveLength(4);

    const { cleared } = invalidateUFSCacheForDates(['2026-09-10']);
    expect(cleared).toBe(2);

    // agosto continua em cache (nenhum find novo)
    await calculateCash(S2, E2);
    await calculateCash(S2, E2, { detailSelect: MONTH_FIELDS });
    expect(findCalls).toHaveLength(4);

    // setembro foi limpo nas DUAS variantes e recalcula com o dado novo
    db.payments = [fullDoc('1', 100), fullDoc('2', 250), fullDoc('9', 40)];
    const full = await calculateCash(S1, E1);
    const slim = await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });
    expect(findCalls).toHaveLength(6);
    expect(full.payments).toHaveLength(3);
    expect(slim.payments).toHaveLength(3);
    expect(full.payments[0]).toHaveProperty('insurance');
    expect(slim.payments[0]).not.toHaveProperty('insurance');
  });

  it('invalidateUFSCache (total) limpa todas as variantes', async () => {
    await calculateCash(S1, E1);
    await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });
    invalidateUFSCache();
    await calculateCash(S1, E1);
    await calculateCash(S1, E1, { detailSelect: MONTH_FIELDS });
    expect(findCalls).toHaveLength(4);
  });
});
