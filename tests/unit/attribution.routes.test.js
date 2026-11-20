/**
 * Rotas da Frente 2 (somente leitura), com models FALSOS em memória e dados fictícios:
 *   GET /api/v2/analytics/roi/revenue-attribution
 *   GET /api/v2/analytics/attribution-health  (destinos simulados: nada chama Meta/Google/TikTok)
 * Os models falsos só têm find().select().lean(): qualquer tentativa de escrita quebraria o teste.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createAttributionRouter, parsePeriod } from '../../routes/analytics/attribution.routes.js';
import { buildAttributionHealth } from '../../services/attribution/attributionHealth.js';
import { amostra, ESPERADO, P } from '../../services/attribution/fixtures/receitaFicticia.js';

// ── Model falso: filtro mínimo (igualdade, $in, $gte, $lte, $ne, $type objectId, $or, caminho com ponto) ──
const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const eq = (a, b) => (a instanceof Date || b instanceof Date ? +new Date(a) === +new Date(b) : String(a) === String(b));
function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    const v = get(doc, k);
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === '$in') return v != null && arg.some((a) => eq(a, v));
        if (op === '$gte') return v != null && +new Date(v) >= +new Date(arg);
        if (op === '$lte') return v != null && +new Date(v) <= +new Date(arg);
        if (op === '$ne') return v == null ? arg != null : !eq(v, arg);
        if (op === '$type' && arg === 'objectId') return v != null && /^[0-9a-f]{24}$/.test(String(v));
        throw new Error(`operador não suportado no model falso: ${op}`);
      });
    }
    return v != null && eq(v, cond);
  });
}
function fakeModel(rows) {
  const calls = [];
  return {
    calls,
    find: vi.fn((filter = {}) => {
      calls.push(filter);
      const out = rows.filter((r) => matches(r, filter)).map((r) => structuredClone(r));
      const q = { select: () => q, lean: () => Promise.resolve(out) };
      return q;
    }),
  };
}
const models = () => ({
  FinancialLedger: fakeModel(amostra.ledgerEntries),
  AdConversion: fakeModel(amostra.adConversions),
  LeadAttribution: fakeModel(amostra.leadAttributions),
  Patient: fakeModel(amostra.patients),
});

function app({ auth = (req, res, next) => next(), m = models() } = {}) {
  const a = express();
  a.use('/api/v2/analytics', createAttributionRouter({ auth, models: m }));
  return a;
}

describe('GET /api/v2/analytics/roi/revenue-attribution', () => {
  it('devolve 480 + 570 + 240 = 1.290 para novembro/2026 (fictício)', async () => {
    const m = models();
    const res = await request(app({ m })).get('/api/v2/analytics/roi/revenue-attribution?from=2026-11-01&to=2026-11-30');
    expect(res.status).toBe(200);
    expect(res.body.data.totalLiquidoLedger).toBe(ESPERADO.total);
    expect(res.body.data.porNivel).toEqual({ comprovada: 480, provavel: 570, sem_vinculo: 240 });
    expect(res.body.data.invariante.fecha).toBe(true);
    expect(res.body.meta.periodo.campo).toBe('FinancialLedger.occurredAt');
    // nenhuma consulta sem filtro indexado: AdConversion só pela aquisição do paciente, nunca por telefone
    expect(m.AdConversion.calls).toEqual([{ patient: { $in: expect.any(Array), $type: 'objectId' }, isAcquisition: true }]);
    expect(m.Patient.calls.every((f) => f._id || f.phone)).toBe(true);
    // filtro de período aplicado no ledger
    expect(m.FinancialLedger.calls[0]).toHaveProperty('occurredAt.$gte');
    expect(m.FinancialLedger.calls[0]).toHaveProperty('occurredAt.$lte');
  });

  it('período sem lançamentos → zero, e o invariante continua fechando', async () => {
    const res = await request(app()).get('/api/v2/analytics/roi/revenue-attribution?from=2026-12-01&to=2026-12-31');
    expect(res.status).toBe(200);
    expect(res.body.data.totalLiquidoLedger).toBe(0);
    expect(res.body.data.invariante.fecha).toBe(true);
  });

  it('data inválida → 400', async () => {
    const res = await request(app()).get('/api/v2/analytics/roi/revenue-attribution?from=01/11/2026');
    expect(res.status).toBe(400);
  });

  it('telefone compartilhado é detectado com o número sem o 9 (Eva) e com outra grafia (irmão da Iris)', async () => {
    const res = await request(app()).get('/api/v2/analytics/roi/revenue-attribution?from=2026-11-01&to=2026-11-30');
    const prov = res.body.data.linhas.find((l) => l.nivel === 'provavel' && l.origem === 'google_ads');
    expect(prov).toMatchObject({ liquido: 470, pacientes: 3 }); // Davi 200 + Eva 140 + Iris 130
    const comprovadaGoogle = res.body.data.linhas.find((l) => l.nivel === 'comprovada' && l.origem === 'google_ads');
    expect(comprovadaGoogle).toMatchObject({ liquido: 120, pacientes: 1 }); // só a Ana
  });

  it('Iris paga e o irmão (cadastro "+55 62 99999-0009", sem lançamento no período) é achado pelo telefone', async () => {
    const m = models();
    m.FinancialLedger = fakeModel(amostra.ledgerEntries.filter((e) => String(e.patient) === P.iris));
    const res = await request(app({ m })).get('/api/v2/analytics/roi/revenue-attribution?from=2026-11-01&to=2026-11-30');
    expect(res.body.data.porNivel).toEqual({ comprovada: 0, provavel: 130, sem_vinculo: 0 });
    expect(res.body.data.linhas[0].motivosPorLancamento).toEqual({ sinal_forte_em_telefone_compartilhado: 1 });
    // sem o irmão no cadastro, a mesma Iris seria comprovada
    m.Patient = fakeModel(amostra.patients.filter((p) => p._id !== P.joao));
    const sozinha = await request(app({ m })).get('/api/v2/analytics/roi/revenue-attribution?from=2026-11-01&to=2026-11-30');
    expect(sozinha.body.data.porNivel.comprovada).toBe(130);
  });

  it('estorno de um pagamento de outro mês busca o recebimento original e usa a data dele', async () => {
    const m = models();
    const antigo = { _id: '0000000000000000000000a1', type: 'payment_received', direction: 'credit', amount: 70, patient: P.hugo, payment: '0000000000000000000000b1', occurredAt: new Date('2026-10-20T15:00:00Z') };
    const estorno = { _id: '0000000000000000000000a2', type: 'refund', direction: 'debit', amount: 70, patient: P.hugo, payment: antigo.payment, occurredAt: new Date('2026-11-26T15:00:00Z') };
    m.FinancialLedger = fakeModel([...amostra.ledgerEntries, antigo, estorno]);
    const res = await request(app({ m })).get('/api/v2/analytics/roi/revenue-attribution?from=2026-11-01&to=2026-11-30');
    // o pagamento de outubro foi antes do anúncio do Hugo (20/11): o estorno sai do sem vínculo
    expect(res.body.data.porNivel).toEqual({ comprovada: 480, provavel: 570, sem_vinculo: 170 });
    expect(res.body.data.linhas.find((l) => l.adId === 'AD-FICTICIO-2')).toMatchObject({ liquido: 160, estornos: 0 });
    // estorno só do pagamento: busca TODOS os créditos dele (o do TikTok, no período, também
    // entra, porque o estorno é rateado entre os recebimentos daquele pagamento)
    expect(m.FinancialLedger.calls[1].$or[0].payment.$in).toContain(antigo.payment);
    expect(m.FinancialLedger.calls[1]).toEqual({ $or: [{ payment: { $in: expect.arrayContaining([antigo.payment]) }, type: { $in: ['payment_received', 'package_purchase', 'insurance_received'] } }] });
  });
});

// ── Saúde da integração: destinos simulados por AdConversion fictícios ─────────
const NOW = new Date('2026-11-20T12:00:00Z').getTime();
const h = (n) => new Date(NOW - n * 36e5);
const healthDocs = [
  // Meta: aceito com prova (events_received) / "sent" antigo sem prova / ignorado / falha / pendente
  { _id: 'c1', isAcquisition: true, source: 'meta_ads', eventTime: h(48), createdAt: h(48), done: true, gclid: null,
    meta: { status: 'sent', sentAt: h(47), eventsReceived: 1 }, google: { status: 'skipped', reason: 'sem_gclid' }, tiktok: { status: 'sent', sentAt: h(47), code: 0 } },
  { _id: 'c2', isAcquisition: true, source: 'google_ads', eventTime: h(24 * 20), createdAt: h(24 * 20), done: true, gclid: 'G-FICT-1',
    meta: { status: 'sent', sentAt: h(24 * 20) }, google: { status: 'sent', sentAt: h(24 * 20) }, tiktok: { status: 'sent', sentAt: h(24 * 20), trace: 'req-x' } },
  { _id: 'c3', isAcquisition: false, source: 'unknown', unknownReason: 'sem_telefone', eventTime: h(10), createdAt: h(10), done: true, gclid: null,
    meta: { status: 'skipped', reason: 'nao_e_primeiro_agendamento' }, google: { status: 'skipped', reason: 'nao_e_primeiro_agendamento' }, tiktok: { status: 'skipped', reason: 'nao_e_primeiro_agendamento' } },
  { _id: 'c4', isAcquisition: true, source: 'google_ads', eventTime: h(30), createdAt: h(30), done: false, gclid: 'G-FICT-2',
    meta: { status: 'failed', reason: 'token ausente' }, google: { status: 'pending' }, tiktok: { status: 'skipped', reason: 'sem_identificador' } },
  { _id: 'c5', isAcquisition: true, source: 'unknown', unknownReason: 'sem_origem_capturada', eventTime: h(5), createdAt: h(5), done: false, gclid: null,
    meta: { status: 'pending' }, google: { status: 'skipped', reason: 'sem_gclid' }, tiktok: { status: 'pending' } },
  // gclid antigo, fora da janela de 60 dias do CSV, e não-aquisição legada com gclid
  { _id: 'c6', isAcquisition: true, source: 'google_ads', eventTime: h(24 * 70), createdAt: h(24 * 70), done: true, gclid: 'G-FICT-3',
    meta: { status: 'skipped', reason: 'fora_janela_7d_meta' }, google: { status: 'sent', sentAt: h(24 * 70) }, tiktok: { status: 'skipped', reason: 'fora_janela_7d_tiktok' } },
  { _id: 'c7', isAcquisition: false, source: 'google_ads', eventTime: h(24 * 3), createdAt: h(24 * 3), done: true, gclid: 'G-FICT-LEGADO',
    meta: { status: 'skipped', reason: 'nao_e_primeiro_agendamento' }, google: { status: 'skipped', reason: 'nao_e_primeiro_agendamento' }, tiktok: { status: 'skipped', reason: 'nao_e_primeiro_agendamento' } },
  // pendente em registro já finalizado = inconsistência
  { _id: 'c8', isAcquisition: true, source: 'meta_ads', eventTime: h(100), createdAt: h(100), done: true, gclid: null,
    meta: { status: 'pending' }, google: { status: 'skipped', reason: 'sem_gclid' }, tiktok: { status: 'skipped', reason: 'sem_identificador' } },
];
// pendente antigo FORA do período consultado (para a idade do mais antigo)
const oldPending = { _id: 'c9', isAcquisition: true, source: 'meta_ads', eventTime: h(24 * 45), createdAt: h(24 * 45), done: false,
  meta: { status: 'pending' }, google: { status: 'skipped', reason: 'sem_gclid' }, tiktok: { status: 'skipped', reason: 'sem_identificador' } };

describe('buildAttributionHealth (núcleo)', () => {
  const r = buildAttributionHealth({ docs: healthDocs, pendingDocs: [...healthDocs, oldPending], now: NOW });

  it('Meta: com prova, sem prova (histórico), ignorado por motivo, falha, pendente, inconsistente', () => {
    expect(r.destinos.meta).toMatchObject({
      enviadoComProva: 1, enviadoSemProvaHistorico: 1, ignorado: 3, falha: 1, pendente: 1, pendenteEmRegistroFinalizado: 1,
      ignoradoPorMotivo: { nao_e_primeiro_agendamento: 2, fora_janela_7d_meta: 1 }, falhaPorMotivo: { 'token ausente': 1 },
      pendentesEmQualquerData: 2, pendenteMaisAntigoHoras: 24 * 45,
    });
  });

  it('TikTok: request_id sozinho não comprova (histórico); code:0 comprova', () => {
    expect(r.destinos.tiktok).toMatchObject({ enviadoComProva: 1, enviadoSemProvaHistorico: 1, pendente: 1, pendenteMaisAntigoHoras: 5 });
  });

  it('Google API: pendente mais antigo e motivos de ignorado', () => {
    expect(r.destinos.google_api).toMatchObject({
      enviadoComProva: 2, pendente: 1, pendenteMaisAntigoHoras: 30,
      ignoradoPorMotivo: { sem_gclid: 3, nao_e_primeiro_agendamento: 2 },
    });
  });

  it('Google CSV: no feed (sem prova de importação), fora da janela de 60 dias, não-aquisição com gclid', () => {
    expect(r.destinos.google_csv).toMatchObject({
      noFeedSemProvaDeImportacao: 3, foraDaJanelaDoFeed: 1, naoAquisicaoComGclidNoFeed: 1,
      ignoradoPorMotivo: { sem_gclid: 3, nao_e_primeiro_agendamento: 1 }, // c1, c5, c8 sem gclid
    });
  });

  it('origem não identificada por unknownReason', () => {
    expect(r.origemNaoIdentificada).toEqual({ sem_telefone: 1, sem_origem_capturada: 1 });
  });
});

describe('GET /api/v2/analytics/attribution-health', () => {
  it('lê só AdConversion (find), sem nenhuma chamada de plataforma nem escrita', async () => {
    const m = { AdConversion: fakeModel([...healthDocs, oldPending]) };
    const res = await request(app({ m })).get('/api/v2/analytics/attribution-health?from=2026-09-01&to=2026-11-30');
    expect(res.status).toBe(200);
    expect(res.body.meta.somenteLeitura).toBe(true);
    expect(Object.keys(res.body.data.destinos).sort()).toEqual(['google_api', 'google_csv', 'meta', 'tiktok']);
    expect(res.body.data.destinos.meta.pendentesEmQualquerData).toBe(2);
    expect(m.AdConversion.find).toHaveBeenCalledTimes(2);
    expect(Object.keys(m.AdConversion)).toEqual(['calls', 'find']);
  });
});

describe('parsePeriod', () => {
  it('dia inteiro em -03:00; sem datas = últimos 30 dias; inválido = erro', () => {
    const p = parsePeriod({ from: '2026-11-01', to: '2026-11-30' });
    expect(p.since.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect(p.until.toISOString()).toBe('2026-12-01T02:59:59.999Z');
    const d = parsePeriod({}, NOW);
    expect(NOW - d.since.getTime()).toBe(30 * 864e5);
    expect(parsePeriod({ from: '2026-12-01', to: '2026-11-01' }).error).toBeTruthy();
    expect(parsePeriod({ to: 'ontem' }).error).toBeTruthy();
  });
});

// ── Acesso: só admin (auth real de middleware/auth.js + authorize(['admin'])) ──
// JWT assinado com segredo FICTÍCIO de teste; a checagem "usuário existe" do auth é respondida
// por um model falso (sem banco).
describe('acesso às rotas de receita (só admin)', () => {
  const SEGREDO = 'segredo-de-teste-ficticio';
  const ADMIN_ID = new mongoose.Types.ObjectId().toString();
  const SECRETARIA_ID = new mongoose.Types.ObjectId().toString();
  let envAnterior;
  let spy;
  beforeAll(() => {
    envAnterior = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SEGREDO;
    spy = vi.spyOn(mongoose, 'model').mockImplementation(() => ({ exists: async () => ({ _id: 'x' }) }));
  });
  afterAll(() => {
    spy.mockRestore();
    if (envAnterior === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = envAnterior;
  });
  const appReal = () => {
    const a = express();
    a.use('/api/v2/analytics', createAttributionRouter({ models: { ...models(), AdConversion: fakeModel([...amostra.adConversions, ...healthDocs]) } }));
    return a;
  };
  const token = (id, role) => `Bearer ${jwt.sign({ id, role }, SEGREDO)}`;

  for (const rota of ['/api/v2/analytics/roi/revenue-attribution?from=2026-11-01&to=2026-11-30', '/api/v2/analytics/attribution-health']) {
    it(`${rota.split('?')[0]}: admin 200, secretária 403, sem token 401`, async () => {
      const a = appReal();
      expect((await request(a).get(rota).set('Authorization', token(ADMIN_ID, 'admin'))).status).toBe(200);
      expect((await request(a).get(rota).set('Authorization', token(SECRETARIA_ID, 'secretary'))).status).toBe(403);
      expect((await request(a).get(rota)).status).toBe(401);
    });
  }
});
