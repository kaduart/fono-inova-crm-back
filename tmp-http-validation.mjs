/**
 * Validação HTTP ponta a ponta da rota /api/v2/insurance/guides/view.
 * SOMENTE GET. Nenhuma escrita, nenhum script de cleanup.
 *
 * Monta o router REAL numa porta efêmera (supertest) — exercita middleware auth
 * + rota + gate + controller + service. Não sobe o dev server (porta 5000).
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

dotenv.config({ path: '/home/user/projetos/crm/back/.env' });
delete process.env.USE_INSURANCE_READ_VIEW; // garante default OFF

await mongoose.connect(process.env.MONGO_URI);
await import('./models/index.js');
await import('./models/Admin.js'); // auth resolve mongoose.model('Admin') dinamicamente

const { default: insuranceV2Routes } = await import('./routes/insuranceV2.routes.js');
const { setFlag } = await import('./infrastructure/featureFlags/featureFlags.js');

const app = express();
app.use(express.json());
app.use('/api/v2', insuranceV2Routes);

// Token real: precisa de um Admin existente (auth valida existência no banco)
const admin = await mongoose.connection.db.collection('admins').findOne({}, { projection: { _id: 1, role: 1 } });
if (!admin) { console.error('sem Admin no banco'); process.exit(1); }
const token = jwt.sign({ id: admin._id.toString(), role: 'admin' }, process.env.JWT_SECRET || 'secreta', { expiresIn: '1h' });
const AUTH = ['Authorization', `Bearer ${token}`];

const R = [];
const t = (id, desc, ok, detail) => { R.push({ id, ok }); console.log(`${ok ? '✅' : '❌'} ${id} ${desc}\n   ${detail}\n`); };
const BRL = n => (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

console.log(`\n🌐 Validação HTTP — rota real, banco ${mongoose.connection.name}\n${'─'.repeat(72)}\n`);

// ── 1. GATE ────────────────────────────────────────────────────────────────
setFlag('USE_INSURANCE_READ_VIEW', false);

const semAuth = await request(app).get('/api/v2/insurance/guides/view?source=v2');
t('H0', 'sem token → 401 (prova que o middleware auth está na cadeia)',
    semAuth.status === 401, `status ${semAuth.status} · code=${semAuth.body?.code}`);

const flagOffSemSource = await request(app).get('/api/v2/insurance/guides/view').set(...AUTH);
t('H1', 'flag OFF, sem source → 409 INSURANCE_READ_VIEW_DISABLED',
    flagOffSemSource.status === 409 && flagOffSemSource.body?.code === 'INSURANCE_READ_VIEW_DISABLED',
    `status ${flagOffSemSource.status} · code=${flagOffSemSource.body?.code} · meta=${JSON.stringify(flagOffSemSource.body?.meta)}`);

const flagOffComSource = await request(app).get('/api/v2/insurance/guides/view?source=v2').set(...AUTH);
t('H2', 'flag OFF, ?source=v2 → 200',
    flagOffComSource.status === 200 && flagOffComSource.body?.success === true,
    `status ${flagOffComSource.status} · meta=${JSON.stringify(flagOffComSource.body?.meta)}`);

setFlag('USE_INSURANCE_READ_VIEW', true);
const flagOnSemSource = await request(app).get('/api/v2/insurance/guides/view').set(...AUTH);
t('H3', 'flag ON, sem source → 200 (reason=feature-flag)',
    flagOnSemSource.status === 200 && flagOnSemSource.body?.meta?.reason === 'feature-flag',
    `status ${flagOnSemSource.status} · meta=${JSON.stringify(flagOnSemSource.body?.meta)}`);

const flagOnLegacy = await request(app).get('/api/v2/insurance/guides/view?source=legacy').set(...AUTH);
t('H4', 'flag ON, ?source=legacy → 409 (rollback por request funciona)',
    flagOnLegacy.status === 409,
    `status ${flagOnLegacy.status} · code=${flagOnLegacy.body?.code}`);

setFlag('USE_INSURANCE_READ_VIEW', false); // volta ao default

// ── 2. CONTRATO ────────────────────────────────────────────────────────────
const body = flagOffComSource.body;
const guides = body.data || [];
const g0 = guides[0] || {};
const camposGuia = ['guideId', 'number', 'insurance', 'specialty', 'patient', 'guideStatus',
    'sessions', 'financialSummary', 'billingState', 'hasMixedStates',
    'documentationSentAt', 'documentationSentAtIsProxy', 'invoiceNumber', 'sessionDetails'];
const faltando = camposGuia.filter(c => !(c in g0));
t('H5', 'contrato da guia: todos os campos que o front consome',
    faltando.length === 0, faltando.length ? `FALTAM: ${faltando.join(', ')}` : `${camposGuia.length} campos presentes`);

const contadores = ['total', 'pendingBilling', 'documentationSent', 'billed', 'received', 'outOfCycle'];
const valores = ['pendingAmount', 'documentationSentAmount', 'billedAmount', 'receivedAmount', 'totalAmount'];
const faltaC = contadores.filter(c => !(c in (g0.sessions || {})));
const faltaV = valores.filter(v => !(v in (g0.financialSummary || {})));
t('H6', 'contadores por fase + valores por fase',
    faltaC.length === 0 && faltaV.length === 0,
    faltaC.length || faltaV.length ? `FALTAM contadores=${faltaC} valores=${faltaV}` : `${contadores.length} contadores + ${valores.length} valores`);

const topo = ['success', 'data', 'orphanSessions', 'totals', 'pagination', 'meta'];
const faltaT = topo.filter(c => !(c in body));
t('H7', 'envelope: totals + pagination + meta usados pela tela',
    faltaT.length === 0, faltaT.length ? `FALTAM: ${faltaT}` : `guias=${guides.length} · pagination=${JSON.stringify(body.pagination)}`);

t('H8', 'billingState nunca é "mixed" na resposta HTTP',
    !guides.some(g => g.billingState === 'mixed'),
    `rótulos: ${JSON.stringify([...new Set(guides.map(g => g.billingState))])}`);

// ── 3. AS QUATRO ABAS ──────────────────────────────────────────────────────
const PH = ['pendingBilling', 'documentationSent', 'billed', 'received'];
const AK = { pendingBilling: 'pendingAmount', documentationSent: 'documentationSentAmount', billed: 'billedAmount', received: 'receivedAmount' };
const abas = {};
for (const p of PH) {
    const r = await request(app).get(`/api/v2/insurance/guides/view?source=v2&phase=${p}`).set(...AUTH);
    abas[p] = { status: r.status, guides: r.body?.data || [], totals: r.body?.totals };
}
const statusOk = PH.every(p => abas[p].status === 200);
const semSujeira = PH.every(p => abas[p].guides.every(g => g.sessions[p] > 0));
t('H9', 'as 4 abas respondem 200 e só trazem guia com conteúdo na fase',
    statusOk && semSujeira,
    PH.map(p => `${p}: ${abas[p].status} → ${abas[p].guides.length} guias · ${BRL(abas[p].totals?.financialSummary?.[AK[p]])}`).join('\n   '));

// mesma guia em mais de uma aba (obrigatório)
const presenca = new Map();
for (const p of PH) for (const g of abas[p].guides) presenca.set(g.guideId, [...(presenca.get(g.guideId) || []), p]);
const multiAba = [...presenca.entries()].filter(([, ps]) => ps.length > 1);
t('H10', 'OBRIGATÓRIO: a mesma guia aparece em mais de uma aba',
    multiAba.length > 0, `${multiAba.length} guias em ≥2 abas`);

// ── 4. GUIA MISTA REAL ─────────────────────────────────────────────────────
const mistas = guides.filter(g => g.hasMixedStates);
const mista = mistas.sort((a, b) => b.sessions.total - a.sessions.total)[0];
if (mista) {
    const abasDaMista = presenca.get(mista.guideId) || [];
    const parcelas = PH.filter(p => mista.sessions[p] > 0)
        .map(p => `${p}=${mista.sessions[p]} (${BRL(mista.financialSummary[AK[p]])})`);
    const somaParcelas = PH.reduce((s, p) => s + mista.financialSummary[AK[p]], 0);
    t('H11', `guia mista real ${mista.number}: parcelas preservadas e sem colapso`,
        abasDaMista.length > 1 && Math.abs(somaParcelas - mista.financialSummary.totalAmount) < 0.01,
        `paciente=${mista.patient?.fullName} · billingState=${mista.billingState} · hasMixedStates=${mista.hasMixedStates}\n   ` +
        `${parcelas.join(' + ')}\n   soma=${BRL(somaParcelas)} = total ${BRL(mista.financialSummary.totalAmount)} · abas=[${abasDaMista}]`);
} else t('H11', 'guia mista real', false, 'nenhuma guia mista na resposta');

// ── 5. GUIA 100% FATURADA (invisível no legado) ────────────────────────────
const soFaturada = abas.billed.guides.find(g => g.sessions.pendingBilling === 0 && g.sessions.documentationSent === 0 && g.sessions.billed > 0);
t('H12', 'guia 100% faturada aparece em Faturados (era invisível no legado)',
    !!soFaturada,
    soFaturada ? `guia ${soFaturada.number} (${soFaturada.patient?.fullName}) · billed=${soFaturada.sessions.billed} · ${BRL(soFaturada.financialSummary.billedAmount)} · pendentes=0` : 'nenhuma encontrada');

// ── 6. RECEBIDO ────────────────────────────────────────────────────────────
const rec = abas.received.guides[0];
let recOk = false, recDetalhe = 'nenhuma guia recebida';
if (rec) {
    const sessoesRec = (rec.sessionDetails || []).filter(s => s.phase === 'received');
    const somaRec = sessoesRec.reduce((s, x) => s + (x.value || 0), 0);
    const comReceivedAt = sessoesRec.filter(s => s.competenceDate).length;
    const statusPmt = [...new Set(sessoesRec.map(s => s.paymentStatus))];
    recOk = sessoesRec.length === rec.sessions.received
        && Math.abs(somaRec - rec.financialSummary.receivedAmount) < 0.01
        && comReceivedAt === sessoesRec.length
        && statusPmt.every(s => s === 'received');
    recDetalhe = `guia ${rec.number} (${rec.patient?.fullName}) · received=${rec.sessions.received} sessões · ` +
        `${BRL(rec.financialSummary.receivedAmount)}\n   Payment.insurance.status=${JSON.stringify(statusPmt)} · ` +
        `com receivedAt=${comReceivedAt}/${sessoesRec.length} · 1ª competência=${sessoesRec[0]?.competenceDate}`;
}
t('H13', 'aba Recebidos: quantidade, receivedAmount, receivedAt e status conferem', recOk, recDetalhe);

// ── 7. SEM DUPLA CONTAGEM VIA HTTP ─────────────────────────────────────────
const somaAbas = PH.reduce((s, p) => s + (abas[p].totals?.financialSummary?.[AK[p]] || 0), 0);
const acumulado = body.totals?.financialSummary?.totalAmount || 0;
// guarda contra falso-positivo: 0 === 0 não prova nada
t('H14', 'somar as 4 abas (HTTP) reproduz o acumulado exatamente uma vez',
    acumulado > 0 && Math.abs(somaAbas - acumulado) < 0.01,
    `abas=${BRL(somaAbas)} · acumulado=${BRL(acumulado)}${acumulado === 0 ? ' ← SEM DADOS, checagem inválida' : ''}`);

t('H15', 'a resposta trouxe dados reais (guarda contra suíte verde vazia)',
    guides.length > 0 && (body.totals?.sessions?.total || 0) > 0,
    `${guides.length} guias · ${body.totals?.sessions?.total || 0} sessões no ciclo`);

console.log('─'.repeat(72));
const falhas = R.filter(r => !r.ok);
console.log(falhas.length === 0
    ? `\n✅ ${R.length}/${R.length} checagens HTTP passaram.\n`
    : `\n❌ ${falhas.length}/${R.length} FALHARAM: ${falhas.map(f => f.id).join(', ')}\n`);

await mongoose.disconnect();
process.exit(falhas.length === 0 ? 0 : 1);
