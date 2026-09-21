import { describe, it, expect, vi, beforeEach } from 'vitest';

// A view passou a usar `select` (guia, sessão, payment). Aqui os modelos simulados APLICAM a projeção sobre
// fixtures com campos extras; a saída com projeção tem de ser idêntica à saída sem ela. Se o código passar a
// ler um campo que não está nas listas, a saída muda e o teste falha.
const { st, mkQuery } = vi.hoisted(() => {
  const st = { project: true, selects: {}, cfg: {} };
  const clone = v => structuredClone(v);
  const projectDoc = (doc, sel) => {
    const out = {};
    if (doc._id !== undefined) out._id = clone(doc._id);
    for (const tok of sel.split(/\s+/).filter(Boolean)) {
      const [a, b] = tok.split('.');
      if (b) { if (doc[a] && doc[a][b] !== undefined) { out[a] ??= {}; out[a][b] = clone(doc[a][b]); } }
      else if (doc[a] !== undefined) out[a] = clone(doc[a]);
    }
    return out;
  };
  const mkQuery = (name) => {
    let sel = null;
    const q = {
      select: s => { sel = s; st.selects[name] = s; return q; },
      populate: () => q, sort: () => q, lean: () => q,
      exec: () => Promise.resolve().then(() => {
        const rows = st.cfg[name] || [];
        return st.project && sel ? rows.map(d => projectDoc(d, sel)) : clone(rows);
      }),
      then: (a, b) => q.exec().then(a, b), catch: b => q.exec().catch(b),
    };
    return q;
  };
  return { st, mkQuery };
});

const isOrphan = m => m?.status === 'completed' && Array.isArray(m.$or);
vi.mock('../../models/InsuranceGuide.js', () => ({ default: { find: () => mkQuery('guides') } }));
vi.mock('../../models/Session.js', () => ({
  default: { find: m => mkQuery(isOrphan(m) ? 'orphanFind' : 'sessions'), countDocuments: () => mkQuery('orphanCount') },
}));
vi.mock('../../models/Payment.js', () => ({ default: { find: () => mkQuery('payments') } }));
vi.mock('../../models/InsuranceCommunication.js', () => ({ default: { find: m => mkQuery(m?.guideId ? 'legacyComms' : 'subComms') } }));
vi.mock('../../models/InsuranceBatch.js', () => ({ default: { find: () => mkQuery('batches') } }));
vi.mock('../../models/BillingSubmission.js', () => ({ default: { find: () => mkQuery('submissions') } }));
vi.mock('../../utils/logger.js', () => ({ createContextLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));

import { getInsuranceGuidesView } from '../../services/insuranceGuide/insuranceGuidesReadView.js';

const d = s => new Date(s);
const EXTRA = { notes: 'não lido', history: [1, 2, 3], documents: ['x'], internalFlag: true };
const guides = [
  { _id: 'g1', number: '111', insurance: 'unimed', specialty: 'fonoaudiologia', patientId: { _id: 'p1', fullName: 'Ana', phone: '1' }, status: 'active',
    expiresAt: d('2026-12-01'), closedAt: null, billingMode: 'per_month', totalSessions: 10, usedSessions: 4, sessionValue: 90, totalAuthorizedValue: 900, createdAt: d('2026-05-01'), ...EXTRA },
  { _id: 'g2', number: '222', insurance: 'bradesco', specialty: 'psicologia', patientId: { _id: 'p2', fullName: 'Bia', phone: '2' }, status: 'active',
    expiresAt: d('2026-11-01'), closedAt: d('2026-09-10'), billingMode: 'per_guide', totalSessions: 5, usedSessions: 5, sessionValue: 80, totalAuthorizedValue: null, createdAt: d('2026-04-01'), ...EXTRA },
];
const S = (id, guide, date, status, extra = {}) => ({ _id: id, insuranceGuide: guide, date: d(date), status, sessionValue: 100, specialty: 'fonoaudiologia',
  doctor: { _id: 'd1', fullName: 'Dra Lu' }, appointmentId: { _id: 'a' + id, time: '09:00' }, billingBatchId: null, notes: 'x', ...extra });
const sessions = [
  S('s1', 'g1', '2026-07-05', 'completed'),                           // pendente de faturamento (mês anterior)
  S('s2', 'g1', '2026-09-03', 'completed'),                           // pendente (mês atual)
  S('s3', 'g1', '2026-08-10', 'completed', { billingBatchId: 'b1' }), // faturada por lote
  S('s4', 'g2', '2026-08-20', 'completed'),                           // recebida
  S('s5', 'g2', '2026-09-08', 'completed'),                           // conflito de integridade (2 payments ativos)
  S('s6', 'g2', '2026-09-09', 'scheduled', { sessionValue: 0 }),      // fora do ciclo
  S('s7', 'g1', '2026-06-15', 'completed', { sessionValue: 0 }),      // pendente; valor vem do payment.grossAmount
  S('s8', 'g1', '2026-08-12', 'completed'),                           // faturada só pelo status do payment (legado, sem lote)
];
const P = (id, session, status, ins, amount = 100) => ({ _id: id, session, insuranceGuide: 'g?', amount, status, notes: 'x', history: [1], integrityMetadata: { a: 1 },
  insurance: { status: ins, grossAmount: amount + 5, billedAt: d('2026-09-01'), receivedAt: d('2026-09-12'), authorizationCode: 'X', extra: 'y' } });
const payments = [
  P('p1', 's1', 'pending', 'pending_billing'), P('p2', 's2', 'pending', 'pending_billing', 120),
  P('p3', 's3', 'pending', 'pending_billing'), P('p4', 's4', 'paid', 'received', 110),
  P('p5', 's5', 'pending', 'pending_billing'), P('p6', 's5', 'pending', 'pending_billing'),
  P('p7', 's7', 'pending', 'pending_billing', 50), P('p8', 's8', 'pending', 'billed'),
];
const submissions = [{ _id: 'sub1', sessionIds: ['s2'], internal: 1 }];
const subComms = [{ _id: 'c2', guideId: null, billingSubmissionId: 'sub1', invoiceNumber: 'NF9', sentAt: d('2026-09-05'), updatedAt: d('2026-09-05'), x: 1 }];
const batches = [{ _id: 'b1', status: 'sent', createdAt: d('2026-08-15'), invoiceNumber: 'NF1', invoiceDate: d('2026-08-16'), origin: 'system', big: 'x' }];

beforeEach(() => {
  st.project = true; st.selects = {};
  st.cfg = { guides, sessions, payments, legacyComms: [], subComms, submissions, batches, orphanFind: [], orphanCount: [] };
});

const run = async (filters, project) => { st.project = project; return JSON.parse(JSON.stringify(await getInsuranceGuidesView({ ...filters }))); };
const CASES = {
  'full all': {}, 'full pendingBilling': { phase: 'pendingBilling' }, 'full billed': { phase: 'billed' }, 'full received': { phase: 'received' },
  'full documentationSent': { phase: 'documentationSent' }, 'full phases': { phases: 'pendingBilling,billed,received,documentationSent' },
  'full from/to': { from: '2026-08-01', to: '2026-09-30' }, 'summary all': { detail: 'summary' },
  'dashboard': { phase: 'pendingBilling', detail: 'summary' }, 'summary phases': { detail: 'summary', phases: 'pendingBilling,billed' },
  'insurance': { insurance: 'unimed' }, 'paginado': { limit: 1, page: 2 },
};

describe('insuranceGuidesReadView — projeções (select) não mudam a saída', () => {
  for (const [name, f] of Object.entries(CASES)) {
    it(`idêntica com e sem projeção: ${name}`, async () => {
      const without = await run(f, false);
      const withProj = await run(f, true);
      expect(withProj).toEqual(without);
    });
  }

  it('a fixture exercita as fases, o lote, a NF e o conflito de integridade (a comparação não é vazia)', async () => {
    const r = await run({}, true);
    expect(r.paymentIntegrityConflictCount).toBe(1);
    expect(r.totals.sessions.pendingBilling).toBeGreaterThan(0);
    expect(r.totals.sessions.documentationSent).toBeGreaterThan(0);
    expect(r.totals.sessions.billed).toBeGreaterThan(0);
    expect(r.totals.sessions.received).toBeGreaterThan(0);
    const g1 = r.guides.find(g => g.guideId === 'g1');
    expect(g1.sessionDetails.some(s => s.batchInvoiceNumber === 'NF1')).toBe(true);
    expect(r.guides.find(g => g.guideId === 'g2').closedAt).toBeTruthy();
    const dash = await run({ phase: 'pendingBilling', detail: 'summary' }, true);
    expect(dash.competenceBreakdown.previous.value).toBeGreaterThan(0);
  });

  it('campos não lidos não vazam para a saída', async () => {
    const r = JSON.stringify(await run({}, true));
    for (const leaked of ['não lido', 'internalFlag', 'authorizationCode', 'integrityMetadata']) expect(r).not.toContain(leaked);
  });

  it('as consultas recebem as projeções esperadas (summary sem specialty/doctor/appointmentId)', async () => {
    await run({ phase: 'pendingBilling', detail: 'summary' }, true);
    const sel = st.selects;
    expect(sel.guides).toContain('closedAt');
    expect(sel.sessions).not.toMatch(/specialty|doctor|appointmentId/);
    expect(sel.sessions).toMatch(/billingBatchId/);
    expect(sel.payments).toMatch(/insurance\.status/);
    expect(sel.payments).not.toMatch(/(^|\s)insurance(\s|$)/); // subdocumento inteiro não é mais trazido
    await run({}, true);
    expect(st.selects.sessions).toMatch(/specialty/);
  });
});
