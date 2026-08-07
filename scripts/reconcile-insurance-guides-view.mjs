// back/scripts/reconcile-insurance-guides-view.mjs
/**
 * Fase 2 — Reconciliação da nova fonte de leitura de convênios.
 *
 * SOMENTE LEITURA. Não escreve nada. Roda antes de trocar o endpoint consumido
 * pelo frontend (Fase 3).
 *
 * Garantias verificadas:
 *   G1 - toda guia existente aparece na view sem filtros
 *   G2 - nenhuma sessão desaparece (cada sessão completed em exatamente 1 fase)
 *   G3 - nenhum payment muda de valor (view não escreve; soma preservada)
 *   G4 - soma dos valores bate com Payment (SSOT financeiro)
 *   G5 - paridade com listGuidesPendingBilling (autoriza a troca da fonte)
 *
 * Uso: node scripts/reconcile-insurance-guides-view.mjs
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { default: InsuranceGuide } = await import('../models/InsuranceGuide.js');
const { default: Session } = await import('../models/Session.js');
const { default: Payment } = await import('../models/Payment.js');
const { getInsuranceGuidesView } = await import('../services/insuranceGuide/insuranceGuidesReadView.js');
const { listGuidesPendingBilling } = await import('../services/insuranceBatchGuideAdapter.js');

const BRL = n => (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const results = [];
function check(id, titulo, ok, detalhe) {
    results.push({ id, titulo, ok, detalhe });
    console.log(`${ok ? '✅' : '❌'} ${id} ${titulo}\n   ${detalhe}\n`);
}

await mongoose.connect(process.env.MONGO_URI);
console.log(`\n🔍 Reconciliação — banco: ${mongoose.connection.name}\n${'─'.repeat(70)}\n`);

const snapshotAntes = {
    guides: await InsuranceGuide.countDocuments(),
    payments: await Payment.countDocuments({ billingType: 'convenio' }),
    somaPayments: (await Payment.aggregate([
        { $match: { billingType: 'convenio', status: { $nin: ['canceled', 'cancelled'] }, amount: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount'] } } } }
    ]))[0]?.total || 0
};

const view = await getInsuranceGuidesView({});

// ── G1: completude ──────────────────────────────────────────────────────────
const totalGuiasBanco = snapshotAntes.guides;
check('G1', 'Toda guia existente aparece na view',
    view.guides.length === totalGuiasBanco,
    `banco: ${totalGuiasBanco} guias · view: ${view.guides.length} guias`);

// ── G2: conservação de sessão ───────────────────────────────────────────────
const sessoesCompletedComGuia = await Session.countDocuments({
    insuranceGuide: { $ne: null }, status: 'completed'
});
const somaFases = view.guides.reduce((acc, g) => acc
    + g.sessions.pendingBilling + g.sessions.documentationSent
    + g.sessions.billed + g.sessions.received, 0);

const totalDivergente = view.guides.filter(g =>
    g.sessions.total !== (g.sessions.pendingBilling + g.sessions.documentationSent
        + g.sessions.billed + g.sessions.received));

check('G2', 'Nenhuma sessão desaparece nem é contada duas vezes',
    somaFases === sessoesCompletedComGuia && totalDivergente.length === 0,
    `banco: ${sessoesCompletedComGuia} sessões completed com guia · view: ${somaFases} classificadas · ` +
    `guias com total ≠ soma das fases: ${totalDivergente.length}`);

// ── G3: nenhuma escrita ─────────────────────────────────────────────────────
const snapshotDepois = {
    guides: await InsuranceGuide.countDocuments(),
    payments: await Payment.countDocuments({ billingType: 'convenio' }),
    somaPayments: (await Payment.aggregate([
        { $match: { billingType: 'convenio', status: { $nin: ['canceled', 'cancelled'] }, amount: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount'] } } } }
    ]))[0]?.total || 0
};
const intacto = JSON.stringify(snapshotAntes) === JSON.stringify(snapshotDepois);
check('G3', 'Nenhum payment mudou de valor (view é read-only)', intacto,
    `soma Payment antes: ${BRL(snapshotAntes.somaPayments)} · depois: ${BRL(snapshotDepois.somaPayments)}`);

// ── G4: valores batem com Payment (SSOT) ────────────────────────────────────
// Compara fase a fase contra a agregação direta em Payment.
const [pmtBilled, pmtReceived] = await Promise.all([
    Payment.aggregate([
        { $match: { billingType: 'convenio', status: { $nin: ['canceled', 'cancelled'] }, amount: { $gt: 0 }, 'insurance.status': 'billed', session: { $ne: null } } },
        { $group: { _id: null, n: { $sum: 1 }, total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount'] } } } }
    ]),
    Payment.aggregate([
        { $match: { billingType: 'convenio', status: { $nin: ['canceled', 'cancelled'] }, amount: { $gt: 0 }, 'insurance.status': 'received', session: { $ne: null } } },
        { $group: { _id: null, n: { $sum: 1 }, total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount'] } } } }
    ])
]);

const recebidoView = view.totals.financialSummary.receivedAmount;
const recebidoPmt = pmtReceived[0]?.total || 0;
check('G4', 'Valor "recebido" da view bate com Payment (SSOT)',
    Math.abs(recebidoView - recebidoPmt) < 0.01,
    `view: ${BRL(recebidoView)} (${view.totals.sessions.received} sessões) · ` +
    `Payment: ${BRL(recebidoPmt)} (${pmtReceived[0]?.n || 0} payments)`);

// "billed" na view inclui sessão com billingBatchId mas Payment ainda pending_billing
// (fluxo em que o lote foi criado e o Payment não acompanhou). Divergência aqui é
// dado a investigar, não erro da view — por isso é reportada como informação.
const faturadoView = view.totals.financialSummary.billedAmount;
const faturadoPmt = pmtBilled[0]?.total || 0;
console.log(`ℹ️  G4b Faturado — view: ${BRL(faturadoView)} (${view.totals.sessions.billed} sessões) · ` +
    `Payment billed: ${BRL(faturadoPmt)} (${pmtBilled[0]?.n || 0} payments) · ` +
    `delta: ${BRL(faturadoView - faturadoPmt)}\n`);

// ── G5: paridade com a leitura atual ────────────────────────────────────────
// O universo do legado é "guia com sessão pendente de faturamento", que abrange
// DUAS fases da view: pendingBilling e documentationSent (o front é que separa as
// duas abas depois). Comparar só contra pendingBilling acusa falso positivo.
const legado = await listGuidesPendingBilling({ limit: 1000 });
const legadoIds = new Set(legado.guides.map(g => g.guideId));

const viewPendentes = await getInsuranceGuidesView({ from: '2026-03-01' });
const viewIds = new Set(viewPendentes.guides
    .filter(g => g.sessions.pendingBilling > 0 || g.sessions.documentationSent > 0)
    .map(g => g.guideId));

const soNoLegado = [...legadoIds].filter(id => !viewIds.has(id));
const soNaView = [...viewIds].filter(id => !legadoIds.has(id));

check('G5', 'Paridade com listGuidesPendingBilling (mesmo recorte)',
    soNoLegado.length === 0 && soNaView.length === 0,
    `legado: ${legadoIds.size} guias · view (pendingBilling ∪ documentationSent, from=2026-03-01): ${viewIds.size} · ` +
    `só no legado: ${soNoLegado.length} · só na view: ${soNaView.length}`);

// ── G6: buckets das abas — sem dupla contagem ───────────────────────────────
// Cada aba é um bucket de fase. A MESMA guia pode estar em várias; somar as 4
// abas tem de reproduzir o total exatamente uma vez.
const PHASES = ['pendingBilling', 'documentationSent', 'billed', 'received'];
const AMOUNT_KEY = {
    pendingBilling: 'pendingAmount',
    documentationSent: 'documentationSentAmount',
    billed: 'billedAmount',
    received: 'receivedAmount'
};

const buckets = {};
for (const p of PHASES) buckets[p] = await getInsuranceGuidesView({ phase: p });

const somaBuckets = PHASES.reduce((acc, p) => acc + buckets[p].totals.financialSummary[AMOUNT_KEY[p]], 0);
const somaSessoesBuckets = PHASES.reduce((acc, p) => acc + buckets[p].totals.sessions[p], 0);
const totalAcumulado = view.totals.financialSummary.totalAmount;

check('G6', 'Somar as 4 abas reproduz o total uma única vez (sem dupla contagem)',
    Math.abs(somaBuckets - totalAcumulado) < 0.01 && somaSessoesBuckets === view.totals.sessions.total,
    `abas somadas: ${BRL(somaBuckets)} / ${somaSessoesBuckets} sessões · ` +
    `acumulado: ${BRL(totalAcumulado)} / ${view.totals.sessions.total} sessões`);

// Toda guia devolvida num bucket precisa ter conteúdo naquela fase
const bucketsSujos = PHASES.filter(p => buckets[p].guides.some(g => g.sessions[p] === 0));
check('G7', 'Nenhum bucket devolve guia sem conteúdo na fase',
    bucketsSujos.length === 0,
    PHASES.map(p => `${p}: ${buckets[p].guides.length} guias`).join(' · '));

// ── G8: comparação nova view × Payment SSOT × abas atuais ───────────────────
const [legadoBilled, legadoReceived] = await Promise.all([
    Payment.aggregate([
        { $match: { billingType: 'convenio', amount: { $gt: 0 }, status: { $ne: 'canceled' }, 'insurance.status': 'billed' } },
        { $group: { _id: null, n: { $sum: 1 }, total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount'] } } } }
    ]),
    Payment.aggregate([
        { $match: { billingType: 'convenio', amount: { $gt: 0 }, status: { $ne: 'canceled' }, 'insurance.status': 'received' } },
        { $group: { _id: null, n: { $sum: 1 }, total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount'] } } } }
    ])
]);

console.log('─'.repeat(70));
console.log('\n📐 Comparação: nova view × Payment SSOT × abas atuais (acumulado)\n');
console.log('   Aba          | ReadView V2                    | Payment SSOT (aba atual)');
console.log('   ' + '-'.repeat(66));
const linha = (nome, vSess, vVal, pSess, pVal) =>
    console.log(`   ${nome.padEnd(12)} | ${String(vSess).padStart(4)} sess · ${BRL(vVal).padEnd(16)} | ${pSess === null ? 'n/a (aba nova)' : `${String(pSess).padStart(4)} pmts · ${BRL(pVal)}`}`);

linha('A Faturar', buckets.pendingBilling.totals.sessions.pendingBilling, buckets.pendingBilling.totals.financialSummary.pendingAmount, null, 0);
linha('Aguardando', buckets.documentationSent.totals.sessions.documentationSent, buckets.documentationSent.totals.financialSummary.documentationSentAmount, null, 0);
linha('Faturados', buckets.billed.totals.sessions.billed, buckets.billed.totals.financialSummary.billedAmount, legadoBilled[0]?.n || 0, legadoBilled[0]?.total || 0);
linha('Recebidos', buckets.received.totals.sessions.received, buckets.received.totals.financialSummary.receivedAmount, legadoReceived[0]?.n || 0, legadoReceived[0]?.total || 0);

const deltaBilled = buckets.billed.totals.financialSummary.billedAmount - (legadoBilled[0]?.total || 0);
const deltaReceived = buckets.received.totals.financialSummary.receivedAmount - (legadoReceived[0]?.total || 0);
console.log(`\n   delta Faturados: ${BRL(deltaBilled)} · delta Recebidos: ${BRL(deltaReceived)}`);
console.log('   Delta esperado é ZERO nos dois. Se aparecer diferença em Faturados, a causa');
console.log('   provável é sessão com billingBatchId cujo Payment ficou em pending_billing —');
console.log('   investigar o dado, não presumir erro da view.\n');

// ── Ganho: o que a view destrava ────────────────────────────────────────────
console.log('─'.repeat(70));
console.log('\n📊 O que a nova fonte destrava\n');

const porRotulo = {};
for (const g of view.guides) porRotulo[g.billingState] = (porRotulo[g.billingState] || 0) + 1;
console.log('   billingState:', JSON.stringify(porRotulo));
console.log(`   guias com fases misturadas: ${view.guides.filter(g => g.hasMixedStates).length}`);
console.log(`   guias invisíveis na leitura antiga: ${totalGuiasBanco - legadoIds.size} de ${totalGuiasBanco}`);
console.log(`   sessões órfãs (convênio sem guia): ${view.orphanSessions.length}`);
console.log(`\n   totais da tela: ${JSON.stringify(view.totals.sessions)}`);
console.log(`   ${JSON.stringify(view.totals.financialSummary)}\n`);

const proxies = view.guides.filter(g => g.documentationSentAtIsProxy).length;
if (proxies > 0) {
    console.log(`   ⚠️  ${proxies} guias usam updatedAt como proxy de data de envio ` +
        `(InsuranceCommunication não tem campo sentAt)\n`);
}

// ── Veredito ────────────────────────────────────────────────────────────────
console.log('─'.repeat(70));
const falhas = results.filter(r => !r.ok);
console.log(falhas.length === 0
    ? `\n✅ RECONCILIAÇÃO OK — ${results.length}/${results.length} garantias.\n`
    : `\n❌ RECONCILIAÇÃO FALHOU — ${falhas.length} de ${results.length}: ${falhas.map(f => f.id).join(', ')}.\n`);

await mongoose.disconnect();
process.exit(falhas.length === 0 ? 0 : 1);
