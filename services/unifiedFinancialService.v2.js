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

// ============================================================
// 1) CAIXA — Payment only (imutável)
// ============================================================

export async function calculateCash(start, end) {
    // 🎯 FONTE ÚNICA DE VERDADE — Aggregation direta no MongoDB
    // NÃO usar filtragem manual. NÃO usar heurística de texto.
    const match = {
        status: 'paid',
        amount: { $gt: 0 },
        kind: { $ne: 'package_consumed' },
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
    };

    // 1. Total geral
    const totalAgg = await Payment.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const total = totalAgg[0]?.total || 0;
    const count = totalAgg[0]?.count || 0;

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

    // 5. Receita real/diferida (simplificado — total = real por padrão)
    const receitaReal = total;
    const receitaDiferida = 0;

    return {
        total,
        receitaReal,
        receitaDiferida,
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
        const sessVal = pkg.sessionValue > 0 ? pkg.sessionValue
            : pkg.totalValue && pkg.totalSessions ? pkg.totalValue / pkg.totalSessions : 0;
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

    // 1. Total geral
    const totalAgg = await Session.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: '$sessionValue' }, count: { $sum: 1 } } }
    ]);
    const total = totalAgg[0]?.total || 0;
    const count = totalAgg[0]?.count || 0;

    // 2. Por tipo (particular / pacote / convenio / liminar)
    // Campos disponíveis em Session: paymentMethod, paymentOrigin, package
    // Session NÃO tem billingType.
    const typeAgg = await Session.aggregate([
        { $match: match },
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
            total: { $sum: '$sessionValue' }
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
        { $group: { _id: null, total: { $sum: '$sessionValue' } } }
    ]);
    const recebido = recebidoAgg[0]?.total || 0;
    const pendente = total - recebido;

    // 4. Particular Pendente vs Pacote Pendente (risco de inadimplência)
    const naoPagoMatch = {
        date: { $gte: start, $lte: end },
        status: 'completed',
        $and: [
            { paymentMethod: { $ne: 'convenio' } },
            { paymentOrigin: { $ne: 'convenio' } },
            { paymentMethod: { $ne: 'liminar_credit' } },
            { paymentOrigin: { $ne: 'liminar' } },
            { paymentOrigin: { $ne: 'liminar_credit' } }
        ],
        $nor: [
            { isPaid: true },
            { paymentStatus: { $in: ['paid', 'package_paid'] } },
            { paymentOrigin: 'package_prepaid' }
        ]
    };

    const particularPendenteAgg = await Session.aggregate([
        { $match: { ...naoPagoMatch, $or: [{ package: { $exists: false } }, { package: null }] } },
        { $group: { _id: null, total: { $sum: '$sessionValue' } } }
    ]);
    const particularPendente = particularPendenteAgg[0]?.total || 0;

    const pacotePendenteAgg = await Session.aggregate([
        { $match: { ...naoPagoMatch, package: { $exists: true, $ne: null } } },
        { $group: { _id: null, total: { $sum: '$sessionValue' } } }
    ]);
    const pacotePendente = pacotePendenteAgg[0]?.total || 0;

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
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: 'America/Sao_Paulo' } },
            producao: { $sum: '$sessionValue' },
            atendimentos: { $sum: 1 }
        }}
    ]);
    const map = new Map();
    agg.forEach(r => map.set(r._id, { producao: r.producao, atendimentos: r.atendimentos }));

    const totalAgg = await Session.aggregate([
        { $match: { date: { $gte: start, $lte: end }, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$sessionValue' }, count: { $sum: 1 } } }
    ]);

    return { map, total: totalAgg[0]?.total || 0, count: totalAgg[0]?.count || 0 };
}

export default {
    calculateCash,
    calculateCashByDay,
    calculateProduction,
    calculateProductionByDay
};
