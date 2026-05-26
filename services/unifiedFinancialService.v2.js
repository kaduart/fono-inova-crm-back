/**
 * 💰 UNIFIED FINANCIAL SERVICE V2 — Fonte única de verdade para Caixa e Produção
 *
 * Regras arquiteturais (imutáveis):
 *   CAIXA     = Payment only. Sempre. Evento imutável no momento do pagamento.
 *   PRODUÇÃO  = Session only. Sempre. Independe de appointment e paciente.
 *
 * HARDENING:
 *   - Caixa NÃO depende de Appointment (imutabilidade financeira)
 *   - Caixa NÃO depende de estado atual de pacote (quitado/pendente)
 *   - Produção NÃO depende de Appointment (sessão realizada = produção)
 *   - Produção NÃO depende de estado do paciente (deletado ou não)
 */

import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Session from '../models/Session.js';
import Package from '../models/Package.js';
import { resolveSessionFinancialValue, resolveSessionFinancialValueAggregate } from '../utils/resolveSessionFinancialValue.js';

// ============================================================
// 1) CAIXA — Payment only (imutável)
// ============================================================

export async function calculateCash(start, end) {
    // 🎯 FONTE ÚNICA DE VERDADE — Aggregation direta no MongoDB
    // NÃO usar filtragem manual. NÃO usar heurística de texto.
    const match = {
        status: 'paid',
        amount: { $gt: 0 },
        isFromPackage: { $ne: true },   // defense-in-depth: consumo de pacote nunca é caixa
        kind: { $ne: 'package_consumed' },
        // convenio entra no caixa apenas quando status='paid' (via processReturn do lote)
        // não excluir billingType: 'convenio' aqui — pagamentos pendentes/billed não passam pelo status: 'paid'
        $and: [
            {
                $or: [
                    { isFromPackage: { $ne: true } },
                    { kind: 'session_payment' }
                ]
            },
            {
                $or: [
                    { financialDate: { $gte: start, $lte: end } },
                    { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
                    { financialDate: null, paymentDate: { $gte: start, $lte: end } },
                    // 🛡️ Último fallback: createdAt garante que pagamentos recentes nunca sumam
                    { financialDate: { $exists: false }, paymentDate: { $exists: false }, createdAt: { $gte: start, $lte: end } },
                    { financialDate: null, paymentDate: null, createdAt: { $gte: start, $lte: end } }
                ]
            }
        ]
    };

    // 🔍 DIAGNÓSTICO: logar range e resultados
    console.log(`[calculateCash] Range: ${start?.toISOString?.()} → ${end?.toISOString?.()}`);

    // 1. Total geral
    const totalAgg = await Payment.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const total = totalAgg[0]?.total || 0;
    const count = totalAgg[0]?.count || 0;
    console.log(`[calculateCash] Encontrados: ${count} payments, total=${total}`);

    // Diagnóstico extra: listar primeiros payments do período
    if (count > 0) {
        const samples = await Payment.find(match).select('amount paymentDate financialDate billingType paymentMethod kind').limit(5).lean();
        console.log(`[calculateCash] Amostras:`, samples.map(p => ({
            amount: p.amount,
            paymentDate: p.paymentDate,
            financialDate: p.financialDate,
            billingType: p.billingType,
            method: p.paymentMethod,
            kind: p.kind
        })));
    }

    // 2. Por método de pagamento
    const methodAgg = await Payment.aggregate([
        { $match: match },
        { $group: {
            _id: {
                $switch: {
                    branches: [
                        { case: { $regexMatch: { input: { $toLower: '$paymentMethod' }, regex: /^pix$/ } }, then: 'pix' },
                        { case: { $regexMatch: { input: { $toLower: '$paymentMethod' }, regex: /cartao|card|crédito|debito|credit|debit/ } }, then: 'cartao' },
                        { case: { $regexMatch: { input: { $toLower: '$paymentMethod' }, regex: /dinheiro|cash/ } }, then: 'dinheiro' }
                    ],
                    default: 'outros'
                }
            },
            total: { $sum: '$amount' }
        }}
    ]);
    const byMethod = { pix: 0, dinheiro: 0, cartao: 0, outros: 0 };
    methodAgg.forEach(r => { byMethod[r._id] = r.total; });

    // 3. Por tipo (particular / pacote / convenio / liminar)
    // Campos disponíveis em Payment: billingType, paymentMethod, serviceType, kind, package
    const typeAgg = await Payment.aggregate([
        { $match: match },
        { $group: {
            _id: {
                $switch: {
                    branches: [
                        { case: { $eq: [{ $toLower: '$billingType' }, 'liminar'] }, then: 'liminar' },
                        { case: { $eq: [{ $toLower: '$paymentMethod' }, 'liminar_credit'] }, then: 'liminar' },
                        { case: { $eq: [{ $toLower: '$billingType' }, 'convenio'] }, then: 'convenio' },
                        { case: { $eq: [{ $toLower: '$paymentMethod' }, 'convenio'] }, then: 'convenio' }
                    ],
                    default: {
                        $cond: {
                            if: { $or: [
                                { $ifNull: ['$package', false] },
                                { $eq: [{ $toLower: '$serviceType' }, 'package_session'] },
                                { $eq: ['$kind', 'package_receipt'] }
                            ]},
                            then: 'pacote',
                            else: 'particular'
                        }
                    }
                }
            },
            total: { $sum: '$amount' }
        }}
    ]);
    const particular = typeAgg.find(r => r._id === 'particular')?.total || 0;
    const pacote = typeAgg.find(r => r._id === 'pacote')?.total || 0;
    const convenio = typeAgg.find(r => r._id === 'convenio')?.total || 0;
    const liminar = typeAgg.find(r => r._id === 'liminar')?.total || 0;

    // 4. Buscar payments completos para compatibilidade com endpoints legados
    let payments = await Payment.find(match).populate('patient', 'fullName').lean();
    // Filtro de nome de teste (não expressível eficientemente em aggregation)
    payments = payments.filter(p => {
        const nome = (p.patient?.fullName || '').toLowerCase();
        return !nome.includes('teste') && !nome.includes('test ');
    });

    return {
        total,
        particular,
        pacote,
        convenio,
        liminar,
        pix: byMethod.pix,
        dinheiro: byMethod.dinheiro,
        cartao: byMethod.cartao,
        outros: byMethod.outros,
        byMethod,
        count,
        payments
    };
}

/**
 * Calcula receita real vs diferida para pacotes full pré-pagos.
 * Receita diferida = valor pago por sessões ainda não realizadas.
 */
async function _calcReceitaReal(payments) {
    const fullPkgPayments = payments.filter(p => p.package && !p.session && !p.appointment);
    if (fullPkgPayments.length === 0) {
        return { receitaReal: payments.reduce((s, p) => s + p.amount, 0), receitaDiferida: 0 };
    }

    const pkgIds = [...new Set(fullPkgPayments.map(p => p.package.toString()))];
    const [pacotes, sessionCounts] = await Promise.all([
        Package.find({ _id: { $in: pkgIds } }, 'sessionValue totalValue totalSessions').lean(),
        Session.aggregate([
            { $match: { package: { $in: pkgIds.map(id => new mongoose.Types.ObjectId(id)) }, status: 'completed' } },
            { $group: { _id: '$package', count: { $sum: 1 } } }
        ])
    ]);

    const pkgMap = new Map(pacotes.map(p => [p._id.toString(), p]));
    const countMap = new Map(sessionCounts.map(s => [s._id.toString(), s.count]));

    let receitaDiferida = 0;
    for (const p of fullPkgPayments) {
        const pkg = pkgMap.get(p.package.toString());
        if (!pkg) continue;
        const sessVal = resolveSessionFinancialValue({ sessionValue: 0, package: pkg });
        if (sessVal <= 0) continue;
        const feitas = countMap.get(p.package.toString()) || 0;
        const ganho = feitas * sessVal;
        receitaDiferida += Math.max(0, p.amount - ganho);
    }

    const totalCaixa = payments.reduce((s, p) => s + p.amount, 0);
    return { receitaReal: totalCaixa - receitaDiferida, receitaDiferida };
}

export async function calculateCashByDay(start, end) {
    const agg = await Payment.aggregate([
        { $match: {
            status: 'paid',
            amount: { $gt: 0 },
            kind: { $ne: 'package_consumed' },
            // convenio entra apenas quando status='paid' (via processReturn) — não excluir aqui
            $and: [
                {
                    $or: [
                        { isFromPackage: { $ne: true } },
                        { kind: 'session_payment' }
                    ]
                },
                {
                    $or: [
                        { financialDate: { $gte: start, $lte: end } },
                        { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
                        { financialDate: null, paymentDate: { $gte: start, $lte: end } }
                    ]
                }
            ]
        }},
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: { $ifNull: ['$financialDate', '$paymentDate'] }, timezone: 'America/Sao_Paulo' } },
            caixa: { $sum: '$amount' },
            transacoes: { $sum: 1 }
        }}
    ]);
    const map = new Map();
    agg.forEach(r => map.set(r._id, { caixa: r.caixa, transacoes: r.transacoes }));
    return map;
}

// ============================================================
// 2) PRODUÇÃO — Session only (status = 'completed')
// ============================================================

/**
 * Stages que resolvem o valor unitário correto por sessão.
 * Importado do módulo centralizado para garantir consistência
 * entre aggregation (MongoDB) e objetos JavaScript.
 */
const pkgLookupStages = [
    { $lookup: {
        from: 'packages',
        localField: 'package',
        foreignField: '_id',
        pipeline: [{ $project: { sessionValue: 1, totalValue: 1, totalSessions: 1 } }],
        as: '_pkg'
    }},
    ...resolveSessionFinancialValueAggregate()
];

/**
 * Busca sessions completadas no período.
 *
 * Regras imutáveis:
 *   - status: 'completed'
 *   - date no range
 *
 * 🚨 NÃO filtra por appointment deletado/cancelado — produção é execução clínica.
 * 🚨 NÃO filtra por paciente deletado — a sessão foi realizada.
 */
export async function calculateProduction(start, end) {
    // 🎯 FONTE ÚNICA DE VERDADE — Aggregation direta no MongoDB
    const match = {
        date: { $gte: start, $lte: end },
        status: 'completed'
    };

    // 🔍 DIAGNÓSTICO: logar range e resultados
    console.log(`[calculateProduction] Range: ${start?.toISOString?.()} → ${end?.toISOString?.()}`);

    // 1. Total geral
    const totalAgg = await Session.aggregate([
        { $match: match },
        ...pkgLookupStages,
        { $group: { _id: null, total: { $sum: '$effectiveValue' }, count: { $sum: 1 } } }
    ]);
    const total = totalAgg[0]?.total || 0;
    const count = totalAgg[0]?.count || 0;
    console.log(`[calculateProduction] Encontradas: ${count} sessions, total=${total}`);

    // Diagnóstico extra: listar primeiras sessions do período
    if (count > 0) {
        const samples = await Session.find(match).select('date sessionValue package status paymentMethod paymentOrigin').limit(5).lean();
        console.log(`[calculateProduction] Amostras:`, samples.map(s => ({
            date: s.date,
            sessionValue: s.sessionValue,
            package: s.package,
            status: s.status,
            method: s.paymentMethod,
            origin: s.paymentOrigin
        })));
    }

    // 2. Por tipo (particular / pacote / convenio / liminar)
    // Campos disponíveis em Session: paymentMethod, paymentOrigin, package
    // Session NÃO tem billingType.
    const typeAgg = await Session.aggregate([
        { $match: match },
        ...pkgLookupStages,
        { $group: {
            _id: {
                $switch: {
                    branches: [
                        { case: { $eq: [{ $toLower: '$paymentMethod' }, 'liminar_credit'] }, then: 'liminar' },
                        { case: { $eq: [{ $toLower: '$paymentOrigin' }, 'liminar'] }, then: 'liminar' },
                        { case: { $eq: [{ $toLower: '$paymentOrigin' }, 'liminar_credit'] }, then: 'liminar' },
                        { case: { $eq: [{ $toLower: '$paymentMethod' }, 'convenio'] }, then: 'convenio' },
                        { case: { $eq: [{ $toLower: '$paymentOrigin' }, 'convenio'] }, then: 'convenio' },
                        { case: { $and: [
                            { $ne: [{ $ifNull: ['$insuranceGuide', null] }, null] },
                            { $ne: [{ $ifNull: ['$insuranceGuide', ''] }, ''] }
                        ] }, then: 'convenio' }
                    ],
                    default: {
                        $cond: {
                            if: { $ifNull: ['$package', false] },
                            then: 'pacote',
                            else: 'particular'
                        }
                    }
                }
            },
            total: { $sum: '$effectiveValue' }
        }}
    ]);
    const particular = typeAgg.find(r => r._id === 'particular')?.total || 0;
    const pacote = typeAgg.find(r => r._id === 'pacote')?.total || 0;
    const convenio = typeAgg.find(r => r._id === 'convenio')?.total || 0;
    const liminar = typeAgg.find(r => r._id === 'liminar')?.total || 0;

    // 3. Recebido vs Pendente (para compatibilidade com sanity-check e consumers)
    const recebidoAgg = await Session.aggregate([
        { $match: {
            date: { $gte: start, $lte: end },
            status: 'completed',
            $or: [
                { isPaid: true },
                { paymentStatus: { $in: ['paid', 'package_paid'] } },
                { paymentOrigin: 'package_prepaid' },
                { paymentMethod: 'convenio' },
                { paymentOrigin: 'convenio' }
            ]
        }},
        ...pkgLookupStages,
        { $group: { _id: null, total: { $sum: '$effectiveValue' } } }
    ]);
    const recebido = recebidoAgg[0]?.total || 0;
    const pendente = total - recebido;

    // 4. Particular Pendente vs Pacote Pendente — fonte: Payment.pending (fonte correta)
    // Session como fonte classifica erroneamente por presença de package, ignorando billingType real.
    // Isis Caldas e similares: tem package operacional mas billingType=particular nos payments.
    const pendingDateMatch = {
        status: 'pending',
        amount: { $gt: 0 },
        billingType: { $nin: ['convenio', 'liminar'] },
        paymentMethod: { $nin: ['convenio', 'liminar_credit'] },
        $or: [
            { financialDate: { $gte: start, $lte: end } },
            { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
            { financialDate: null, paymentDate: { $gte: start, $lte: end } }
        ]
    };
    const pendingByTypeAgg = await Payment.aggregate([
        { $match: pendingDateMatch },
        { $group: { _id: '$billingType', total: { $sum: '$amount' } } }
    ]);
    const particularPendente = pendingByTypeAgg.find(r => r._id === 'particular')?.total || 0;
    const pacotePendente     = pendingByTypeAgg.find(r => ['pacote', 'package', 'package_session'].includes(r._id))?.total || 0;

    // 5. Buscar sessions completas para compatibilidade com endpoints legados
    const sessions = await Session.find({
        date: { $gte: start, $lte: end },
        status: 'completed'
    }).populate('package', 'sessionValue totalValue totalSessions').lean();

    return {
        total,
        particular,
        pacote,
        convenio,
        liminar,
        recebido,
        pendente,
        particularPendente,
        pacotePendente,
        count,
        sessions
    };
}

export async function calculateProductionByDay(start, end) {
    const agg = await Session.aggregate([
        { $match: { date: { $gte: start, $lte: end }, status: 'completed' } },
        ...pkgLookupStages,
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: 'America/Sao_Paulo' } },
            producao: { $sum: '$effectiveValue' },
            atendimentos: { $sum: 1 }
        }}
    ]);
    const map = new Map();
    agg.forEach(r => map.set(r._id, { producao: r.producao, atendimentos: r.atendimentos }));

    const totalAgg = await Session.aggregate([
        { $match: { date: { $gte: start, $lte: end }, status: 'completed' } },
        ...pkgLookupStages,
        { $group: { _id: null, total: { $sum: '$effectiveValue' }, count: { $sum: 1 } } }
    ]);

    return { map, total: totalAgg[0]?.total || 0, count: totalAgg[0]?.count || 0 };
}

/**
 * Recebimento da Produção do Mês (regime de competência).
 * Responde: "quanto da produção clínica DESTE mês já foi efetivamente pago?"
 *
 * Filtro por serviceDate (data da sessão), não por financialDate/paymentDate.
 * Exclui:
 *   - package_receipt  → venda antecipada de pacote, sem sessão vinculada
 *   - monthly_settlement → recibo agregado; os session_payment originais já são contados
 *   - package_consumed / isFromPackage → débitos internos de consumo
 *
 * A diferença (produçãoTotal - recebimentoProducao) = "a receber da produção do mês"
 * A diferença (caixaFinanceiro - recebimentoProducao) = "recebimentos retroativos"
 */
export async function calculateCashByCompetencia(start, end) {
    const match = {
        status: 'paid',
        amount: { $gt: 0 },
        isFromPackage: { $ne: true },
        kind: { $nin: ['package_consumed', 'package_receipt', 'monthly_settlement'] },
        serviceDate: { $gte: start, $lte: end }
    };

    const [totalAgg, typeAgg] = await Promise.all([
        Payment.aggregate([
            { $match: match },
            { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        Payment.aggregate([
            { $match: match },
            { $group: {
                _id: {
                    $switch: {
                        branches: [
                            { case: { $eq: [{ $toLower: '$billingType' }, 'liminar'] }, then: 'liminar' },
                            { case: { $eq: [{ $toLower: '$paymentMethod' }, 'liminar_credit'] }, then: 'liminar' },
                            { case: { $eq: [{ $toLower: '$billingType' }, 'convenio'] }, then: 'convenio' },
                            { case: { $eq: [{ $toLower: '$paymentMethod' }, 'convenio'] }, then: 'convenio' },
                        ],
                        default: {
                            $cond: {
                                if: { $or: [{ $ifNull: ['$package', false] }, { $eq: ['$kind', 'package_receipt'] }] },
                                then: 'pacote',
                                else: 'particular'
                            }
                        }
                    }
                },
                total: { $sum: '$amount' }
            }}
        ])
    ]);

    const total   = totalAgg[0]?.total || 0;
    const count   = totalAgg[0]?.count || 0;
    const particular = typeAgg.find(r => r._id === 'particular')?.total || 0;
    const pacote     = typeAgg.find(r => r._id === 'pacote')?.total || 0;
    const convenio   = typeAgg.find(r => r._id === 'convenio')?.total || 0;
    const liminar    = typeAgg.find(r => r._id === 'liminar')?.total || 0;

    return { total, count, particular, pacote, convenio, liminar };
}

export default {
    calculateCash,
    calculateCashByDay,
    calculateProduction,
    calculateProductionByDay,
    calculateCashByCompetencia
};
