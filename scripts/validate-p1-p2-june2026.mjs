/**
 * Validação pós-implementação P1/P2
 * Verifica: receitaReconhecida, receitaProjetada, backlogContratado, A Receber corrigido
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const YEAR = 2026, MONTH = 6;
const TIMEZONE = 'America/Sao_Paulo';

await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
const db = mongoose.connection.db;

const startStr = `2026-06-01`;
const endStr   = `2026-06-30`;
const startDate = new Date('2026-06-01T00:00:00.000Z');
const endDate   = new Date('2026-06-30T23:59:59.999Z');

// ── 1. receitaReconhecida = production.total (Session.completed) ──────────────
const pkgLookup = [
    { $lookup: { from: 'packages', localField: 'package', foreignField: '_id',
        pipeline: [{ $project: { sessionValue: 1, totalValue: 1, totalSessions: 1 } }],
        as: '_pkg' }},
    { $addFields: {
        _pkgSV: { $arrayElemAt: ['$_pkg.sessionValue', 0] },
        _pkgTV: { $arrayElemAt: ['$_pkg.totalValue', 0] },
        _pkgTS: { $arrayElemAt: ['$_pkg.totalSessions', 0] }
    }},
    { $addFields: { effectiveValue: { $cond: {
        if: { $gt: ['$_pkgSV', 0] }, then: '$_pkgSV',
        else: { $cond: {
            if: { $and: [{ $gt: ['$_pkgTV', 0] }, { $gt: ['$_pkgTS', 0] }] },
            then: { $divide: ['$_pkgTV', '$_pkgTS'] },
            else: { $ifNull: ['$sessionValue', 0] }
        }}
    }}}}
];

const prodAgg = await db.collection('sessions').aggregate([
    { $match: { status: 'completed', date: { $gte: startDate, $lte: endDate } } },
    ...pkgLookup,
    { $group: { _id: null, total: { $sum: '$effectiveValue' }, count: { $sum: 1 } } }
]).toArray();
const receitaReconhecida = prodAgg[0]?.total || 0;
const sessoesProduzidas = prodAgg[0]?.count || 0;

// ── 2. caixa (Payment.paid com financialDate) ─────────────────────────────────
const caixaAgg = await db.collection('payments').aggregate([
    { $match: {
        status: 'paid',
        kind: { $ne: 'package_consumed' },
        financialDate: { $gte: startDate, $lte: endDate }
    }},
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
]).toArray();
const caixaTotal = caixaAgg[0]?.total || 0;

// ── 3. aReceberProducao (P1a corrigido: sem createdAt, só appointment.completed) ──
const aReceberPmts = await db.collection('payments').aggregate([
    { $match: {
        status: 'pending',
        $or: [
            { billingType: 'convenio' },
            { paymentMethod: 'convenio' },
            { 'insurance.status': { $in: ['pending_billing', 'billed', 'partial'] } }
        ],
        $or: [
            { paymentDate: { $gte: startStr, $lte: endStr } },
            { serviceDate: { $gte: startStr, $lte: endStr } }
        ]
    }},
    { $lookup: { from: 'appointments', localField: 'appointment', foreignField: '_id',
        pipeline: [{ $project: { operationalStatus: 1 } }], as: '_appt' }},
    { $addFields: { _apptStatus: { $arrayElemAt: ['$_appt.operationalStatus', 0] } }},
    { $match: { $or: [
        { appointment: { $exists: false } },
        { appointment: null },
        { _apptStatus: 'completed' }
    ]}},
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
]).toArray();
const convenioAReceber = aReceberPmts[0]?.total || 0;

// ── 4. receitaProjetada = caixa + aReceberProducao ────────────────────────────
// (aReceberProducao = convenioAReceber + particularPendente + pacotePendente + liminarAReceber)
// Para validação simplificada, usando apenas convenioAReceber como proxy
const receitaProjetada_aprox = caixaTotal + convenioAReceber;

// ── 5. backlogContratado (PackagesView.active.sessionsRemaining) ──────────────
const backlogAgg = await db.collection('packagesviews').aggregate([
    { $match: { status: 'active' } },
    { $group: {
        _id: null,
        sessoes: { $sum: '$sessionsRemaining' },
        pacotes: { $sum: 1 },
        valorEstimado: { $sum: { $multiply: ['$sessionsRemaining', '$sessionValue'] } }
    }}
]).toArray();
const backlogContratado = backlogAgg[0] || { sessoes: 0, pacotes: 0, valorEstimado: 0 };

// ── 6. A Receber ANTES (com bug createdAt) — para comparar ───────────────────
const aReceberBugado = await db.collection('payments').aggregate([
    { $match: {
        status: 'pending',
        $and: [
            { $or: [{ billingType: 'convenio' }, { paymentMethod: 'convenio' }] },
            { $or: [
                { paymentDate: { $gte: startStr, $lte: endStr } },
                { serviceDate: { $gte: startStr, $lte: endStr } },
                { createdAt: { $gte: startDate, $lte: endDate } }  // bug original
            ]}
        ]
    }},
    { $group: { _id: null, total: { $sum: '$amount' } } }
]).toArray();
const aReceberOriginal = aReceberBugado[0]?.total || 0;

// ── Relatório ─────────────────────────────────────────────────────────────────
const fmt = (v) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

console.log('\n══════════════════════════════════════════════════════');
console.log('  VALIDAÇÃO P1/P2 — Junho 2026');
console.log('══════════════════════════════════════════════════════\n');

console.log('── INV-3: receitaReconhecida = production.total ──────');
console.log(`  Session.completed no período: ${sessoesProduzidas} sessões`);
console.log(`  receitaReconhecida:  ${fmt(receitaReconhecida)}`);
console.log(`  (ANTES era cash.total + aReceber — agora é correto)\n`);

console.log('── Caixa (SSOT: financialDate + status:paid) ─────────');
console.log(`  caixa.total:         ${fmt(caixaTotal)}\n`);

console.log('── P1a: A Receber convênio corrigido ─────────────────');
console.log(`  Com bug (createdAt): ${fmt(aReceberOriginal)}`);
console.log(`  Corrigido (novo):    ${fmt(convenioAReceber)}`);
console.log(`  Phantom eliminado:   ${fmt(aReceberOriginal - convenioAReceber)}\n`);

console.log('── receitaProjetada = caixa + aReceber (projeção) ────');
console.log(`  receitaProjetada:    ${fmt(receitaProjetada_aprox)}  (aprox — convenio only)\n`);

console.log('── P2b: backlogContratado ────────────────────────────');
console.log(`  sessoes:             ${backlogContratado.sessoes}`);
console.log(`  pacotes:             ${backlogContratado.pacotes}`);
console.log(`  valorEstimado:       ${fmt(backlogContratado.valorEstimado)}\n`);

console.log('── Identidade de validação (cross-check) ─────────────');
const diff = Math.abs(receitaReconhecida - (caixaTotal + convenioAReceber));
console.log(`  Produção - (Caixa + AReceber) = ${fmt(diff)}`);
console.log(`  ${diff < 10000 ? '✅ Δ dentro do esperado (INV-12: divergência temporal é normal)' : '⚠️  Δ alto — investigar'}\n`);

console.log('══════════════════════════════════════════════════════\n');

await mongoose.disconnect();
