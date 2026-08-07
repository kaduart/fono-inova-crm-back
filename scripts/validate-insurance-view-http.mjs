// back/scripts/validate-insurance-view-http.mjs
/**
 * Smoke test HTTP da Read View de Convênios — /api/v2/insurance/guides/view.
 *
 * SOMENTE LEITURA. Só faz GET. Não escreve, não apaga, não toca em faturamento.
 *
 * Monta o router REAL numa porta efêmera (supertest) e exercita a cadeia
 * completa: middleware `auth` → rota → controller → `insuranceGuidesReadView` →
 * MongoDB. Não sobe o dev server: subir `npm run dev` em background neste repo
 * disputa a porta 5000 e gera timeouts falsos.
 *
 * Quando rodar: antes de qualquer deploy que mexa em convênio.
 *
 * Uso: node scripts/validate-insurance-view-http.mjs
 * Saída: exit 0 se todas as checagens passarem, 1 caso contrário.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

await mongoose.connect(process.env.MONGO_URI);
await import('../models/index.js');
await import('../models/Admin.js'); // `auth` resolve mongoose.model('Admin') em runtime

const { default: insuranceV2Routes } = await import('../routes/insuranceV2.routes.js');

const app = express();
app.use(express.json());
app.use('/api/v2', insuranceV2Routes);

const admin = await mongoose.connection.db
  .collection('admins')
  .findOne({}, { projection: { _id: 1 } });
if (!admin) {
  console.error('❌ Nenhum Admin no banco — o middleware auth exige um usuário existente.');
  process.exit(1);
}
const token = jwt.sign(
  { id: admin._id.toString(), role: 'admin' },
  process.env.JWT_SECRET || 'secreta',
  { expiresIn: '1h' }
);
const AUTH = ['Authorization', `Bearer ${token}`];

const R = [];
const t = (id, desc, ok, detail) => {
  R.push({ id, ok });
  console.log(`${ok ? '✅' : '❌'} ${id} ${desc}\n   ${detail}\n`);
};
const BRL = n => (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

console.log(`\n🌐 Smoke test HTTP — banco ${mongoose.connection.name}\n${'─'.repeat(72)}\n`);

// ── 1. Autenticação e resposta da fonte única ──────────────────────────────
const semAuth = await request(app).get('/api/v2/insurance/guides/view');
t('H0', 'sem token → 401 (prova que o middleware auth está na cadeia)',
  semAuth.status === 401, `status ${semAuth.status} · code=${semAuth.body?.code}`);

const resp = await request(app).get('/api/v2/insurance/guides/view').set(...AUTH);
t('H1', 'com token → 200, sem flag e sem parâmetro de fonte',
  resp.status === 200 && resp.body?.success === true, `status ${resp.status}`);

// A infraestrutura de migração (flag, gate 409, ?source=v2) foi removida:
// existe uma única fonte de leitura. `source` sobrando na query não pode
// mudar nada nem derrubar a rota.
const comSourceLegado = await request(app).get('/api/v2/insurance/guides/view?source=legacy').set(...AUTH);
t('H2', 'parâmetro `source` residual é ignorado (fonte única, sem gate)',
  comSourceLegado.status === 200
  && (comSourceLegado.body?.data?.length || 0) === (resp.body?.data?.length || 0),
  `status ${comSourceLegado.status} · guias=${comSourceLegado.body?.data?.length} (igual a ${resp.body?.data?.length})`);

t('H3', 'resposta não carrega mais resíduo da migração (meta/source)',
  !('meta' in resp.body) && !('source' in resp.body),
  `chaves do envelope: ${Object.keys(resp.body).join(', ')}`);

// ── 2. Contrato consumido pelo InsuranceTab ────────────────────────────────
const body = resp.body;
const guides = body.data || [];
const g0 = guides[0] || {};

const camposGuia = ['guideId', 'number', 'insurance', 'specialty', 'patient', 'guideStatus',
  'sessions', 'financialSummary', 'billingState', 'hasMixedStates',
  'documentationSentAt', 'documentationSentAtIsProxy', 'invoiceNumber', 'sessionDetails'];
const faltando = camposGuia.filter(c => !(c in g0));
t('H5', 'contrato da guia: todos os campos que o front consome',
  faltando.length === 0,
  faltando.length ? `FALTAM: ${faltando.join(', ')}` : `${camposGuia.length} campos presentes`);

const contadores = ['total', 'pendingBilling', 'documentationSent', 'billed', 'received', 'outOfCycle'];
const valores = ['pendingAmount', 'documentationSentAmount', 'billedAmount', 'receivedAmount', 'totalAmount'];
const faltaC = contadores.filter(c => !(c in (g0.sessions || {})));
const faltaV = valores.filter(v => !(v in (g0.financialSummary || {})));
t('H6', 'contadores por fase + valores por fase',
  faltaC.length === 0 && faltaV.length === 0,
  (faltaC.length || faltaV.length)
    ? `FALTAM contadores=${faltaC} valores=${faltaV}`
    : `${contadores.length} contadores + ${valores.length} valores`);

const topo = ['success', 'data', 'orphanSessions', 'totals', 'pagination'];
const faltaT = topo.filter(c => !(c in body));
t('H7', 'envelope: totals + pagination usados pela tela',
  faltaT.length === 0,
  faltaT.length ? `FALTAM: ${faltaT}` : `guias=${guides.length} · pagination=${JSON.stringify(body.pagination)}`);

t('H8', 'billingState nunca é "mixed" (mistura é hasMixedStates + contadores)',
  !guides.some(g => g.billingState === 'mixed'),
  `rótulos: ${JSON.stringify([...new Set(guides.map(g => g.billingState))])}`);

// ── 3. As quatro abas como buckets de fase ─────────────────────────────────
const PH = ['pendingBilling', 'documentationSent', 'billed', 'received'];
const AK = {
  pendingBilling: 'pendingAmount',
  documentationSent: 'documentationSentAmount',
  billed: 'billedAmount',
  received: 'receivedAmount'
};
const abas = {};
for (const p of PH) {
  const r = await request(app).get(`/api/v2/insurance/guides/view?phase=${p}`).set(...AUTH);
  abas[p] = { status: r.status, guides: r.body?.data || [], totals: r.body?.totals };
}
t('H9', 'as 4 abas respondem 200 e só trazem guia com conteúdo na fase',
  PH.every(p => abas[p].status === 200) && PH.every(p => abas[p].guides.every(g => g.sessions[p] > 0)),
  PH.map(p => `${p}: ${abas[p].status} → ${abas[p].guides.length} guias · ${BRL(abas[p].totals?.financialSummary?.[AK[p]])}`).join('\n   '));

const presenca = new Map();
for (const p of PH) for (const g of abas[p].guides) presenca.set(g.guideId, [...(presenca.get(g.guideId) || []), p]);
const multiAba = [...presenca.entries()].filter(([, ps]) => ps.length > 1);
t('H10', 'OBRIGATÓRIO: a mesma guia aparece em mais de uma aba',
  multiAba.length > 0, `${multiAba.length} guias em ≥2 abas`);

// ── 4. Guia mista real: parcelas preservadas ───────────────────────────────
const mista = guides.filter(g => g.hasMixedStates).sort((a, b) => b.sessions.total - a.sessions.total)[0];
if (mista) {
  const abasDaMista = presenca.get(mista.guideId) || [];
  const parcelas = PH.filter(p => mista.sessions[p] > 0)
    .map(p => `${p}=${mista.sessions[p]} (${BRL(mista.financialSummary[AK[p]])})`);
  const soma = PH.reduce((s, p) => s + mista.financialSummary[AK[p]], 0);
  t('H11', `guia mista real ${mista.number}: parcelas preservadas, sem colapso`,
    abasDaMista.length > 1 && Math.abs(soma - mista.financialSummary.totalAmount) < 0.01,
    `paciente=${mista.patient?.fullName} · billingState=${mista.billingState}\n   ` +
    `${parcelas.join(' + ')}\n   soma=${BRL(soma)} = total ${BRL(mista.financialSummary.totalAmount)} · abas=[${abasDaMista}]`);
} else {
  t('H11', 'guia mista real', false, 'nenhuma guia mista encontrada');
}

// ── 5. Guia 100% faturada (era invisível na leitura legada) ────────────────
const soFaturada = abas.billed.guides.find(g =>
  g.sessions.pendingBilling === 0 && g.sessions.documentationSent === 0 && g.sessions.billed > 0);
t('H12', 'guia 100% faturada aparece em Faturados',
  !!soFaturada,
  soFaturada
    ? `guia ${soFaturada.number} (${soFaturada.patient?.fullName}) · billed=${soFaturada.sessions.billed} · ${BRL(soFaturada.financialSummary.billedAmount)} · pendentes=0`
    : 'nenhuma encontrada');

// ── 6. Recebido: quantidade, valor, data e status ──────────────────────────
const rec = abas.received.guides[0];
let recOk = false;
let recDetalhe = 'nenhuma guia recebida';
if (rec) {
  const sessoesRec = (rec.sessionDetails || []).filter(s => s.phase === 'received');
  const somaRec = sessoesRec.reduce((s, x) => s + (x.value || 0), 0);
  const comData = sessoesRec.filter(s => s.competenceDate).length;
  const statusPmt = [...new Set(sessoesRec.map(s => s.paymentStatus))];
  recOk = sessoesRec.length === rec.sessions.received
    && Math.abs(somaRec - rec.financialSummary.receivedAmount) < 0.01
    && comData === sessoesRec.length
    && statusPmt.every(s => s === 'received');
  recDetalhe = `guia ${rec.number} (${rec.patient?.fullName}) · received=${rec.sessions.received} sessões · ` +
    `${BRL(rec.financialSummary.receivedAmount)}\n   Payment.insurance.status=${JSON.stringify(statusPmt)} · ` +
    `com receivedAt=${comData}/${sessoesRec.length}`;
}
t('H13', 'aba Recebidos: quantidade, receivedAmount, receivedAt e status conferem', recOk, recDetalhe);

// ── 7. Sem dupla contagem, via HTTP ────────────────────────────────────────
const somaAbas = PH.reduce((s, p) => s + (abas[p].totals?.financialSummary?.[AK[p]] || 0), 0);
const acumulado = body.totals?.financialSummary?.totalAmount || 0;
// `acumulado > 0` evita o falso-positivo 0 === 0 num banco vazio.
t('H14', 'somar as 4 abas reproduz o acumulado exatamente uma vez',
  acumulado > 0 && Math.abs(somaAbas - acumulado) < 0.01,
  `abas=${BRL(somaAbas)} · acumulado=${BRL(acumulado)}${acumulado === 0 ? ' ← SEM DADOS, checagem inválida' : ''}`);

// Guarda contra suíte verde sobre resposta vazia.
t('H15', 'a resposta trouxe dados reais',
  guides.length > 0 && (body.totals?.sessions?.total || 0) > 0,
  `${guides.length} guias · ${body.totals?.sessions?.total || 0} sessões no ciclo`);

// ── 8. Invariante de completude ────────────────────────────────────────────
const guiasNoBanco = await mongoose.connection.db.collection('insuranceguides').countDocuments();
t('H16', 'toda guia do banco aparece na resposta sem filtros',
  guiasNoBanco === guides.length, `banco=${guiasNoBanco} · resposta=${guides.length}`);

console.log('─'.repeat(72));
const falhas = R.filter(r => !r.ok);
console.log(falhas.length === 0
  ? `\n✅ ${R.length}/${R.length} checagens HTTP passaram.\n`
  : `\n❌ ${falhas.length}/${R.length} FALHARAM: ${falhas.map(f => f.id).join(', ')}\n`);

await mongoose.disconnect();
process.exit(falhas.length === 0 ? 0 : 1);
