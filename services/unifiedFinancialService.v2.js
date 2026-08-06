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
import { logMetric } from '../utils/logMetric.js';
import { resolveSessionFinancialValue, resolveSessionFinancialValueAggregate } from '../utils/resolveSessionFinancialValue.js';

// Cache interno para funções dashboard-optimized — reduz recálculo quando múltiplos callers
// pedem o mesmo período (ex: calculateRealTime pede month + today).
const _ufsCache = new Map();
const UFS_DASHBOARD_TTL = 30_000; // 30s — dados financeiros de curto prazo são estáveis o suficiente

function _ufsCacheKey(fnName, start, end, opts = {}) {
    const suffix = Object.entries(opts)
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
    return `${fnName}_${start?.toISOString?.()}_${end?.toISOString?.()}${suffix ? '_' + suffix : ''}`;
}

function _getUfsCached(key) {
    const entry = _ufsCache.get(key);
    if (entry && Date.now() - entry.ts < UFS_DASHBOARD_TTL) {
        console.log(`[unifiedFinancialService] CACHE HIT ${key} age=${Date.now() - entry.ts}ms`);
        return entry.data;
    }
    return null;
}

function _setUfsCached(key, data) {
    if (_ufsCache.size > 100) _ufsCache.clear();
    _ufsCache.set(key, { data, ts: Date.now() });
    console.log(`[unifiedFinancialService] CACHE SET ${key}`);
}

/**
 * Invalida todo o cache interno do Unified Financial Service.
 * Deve ser chamado após mutações financeiras para evitar dados stale no dashboard.
 */
export function invalidateUFSCache() {
    const size = _ufsCache.size;
    _ufsCache.clear();
    console.log(`[unifiedFinancialService] Cache invalidado (${size} entradas limpas)`);
}

// ============================================================
// 1) CAIXA — Payment only (imutável)
// ============================================================

export async function calculateCash(start, end, { skipPayments = false, includeDetails = true } = {}) {
    const startedAt = Date.now();
    const cacheKey = _ufsCacheKey('calculateCash', start, end, { skipPayments, includeDetails });
    const cached = _getUfsCached(cacheKey);
    if (cached) return cached;
    // 🎯 FONTE ÚNICA DE VERDADE — Aggregation direta no MongoDB
    // NÃO usar filtragem manual. NÃO usar heurística de texto.
    const match = {
        status: 'paid',
        amount: { $gt: 0 },
        kind: { $ne: 'package_consumed' },
        // convenio entra no caixa apenas quando status='paid' (via processReturn do lote)
        // não excluir billingType: 'convenio' aqui — pagamentos pendentes/billed não passam pelo status: 'paid'
        $and: [
            {
                // ⛔ Pacote pré-pago consumido NÃO é entrada de caixa — o dinheiro entrou na compra do pacote.
                // Exceção: per_session (kind=session_payment) tem pagamento real na data da sessão.
                // NÃO adicionar isFromPackage:{$ne:true} no topo — isso bloqueia per_session. Ver 2026-06-01.
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

    // 1-3. Total, método e tipo em uma única aggregation com $facet.
    // 🚀 Reduz 3 round-trips ao MongoDB para 1, economizando ~360-540ms em latência de rede.
    const totalAggStartedAt = Date.now();
    const facetResult = (await Payment.aggregate([
        { $match: match },
        { $facet: {
            total: [
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ],
            byMethod: [
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
            ],
            byType: [
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
            ]
        }}
    ]))[0];
    const totalAggMs = Date.now() - totalAggStartedAt;

    const totalAgg = facetResult.total;
    const methodAgg = facetResult.byMethod;
    const typeAgg = facetResult.byType;

    const total = totalAgg[0]?.total || 0;
    const count = totalAgg[0]?.count || 0;

    const byMethod = { pix: 0, dinheiro: 0, cartao: 0, outros: 0 };
    methodAgg.forEach(r => { byMethod[r._id] = r.total; });

    const particular = typeAgg.find(r => r._id === 'particular')?.total || 0;
    const pacote = typeAgg.find(r => r._id === 'pacote')?.total || 0;
    const convenio = typeAgg.find(r => r._id === 'convenio')?.total || 0;
    const liminar = typeAgg.find(r => r._id === 'liminar')?.total || 0;

    // Diagnóstico extra: listar primeiros payments do período (apenas desenvolvimento)
    let samplesMs = 0;
    if (count > 0 && process.env.NODE_ENV === 'development') {
        const samplesStartedAt = Date.now();
        const samples = await Payment.find(match).select('amount paymentDate financialDate billingType paymentMethod kind').limit(5).lean();
        samplesMs = Date.now() - samplesStartedAt;
        console.log(`[calculateCash] Amostras:`, samples.map(p => ({
            amount: p.amount,
            paymentDate: p.paymentDate,
            financialDate: p.financialDate,
            billingType: p.billingType,
            method: p.paymentMethod,
            kind: p.kind
        })));
    }

    // 4. Buscar payments completos — apenas quando caller precisa da lista (endpoints legados)
    let payments = [];
    let paymentsQueryMs = 0;
    let paymentsFilterMs = 0;
    if (includeDetails && !skipPayments) {
        const paymentsStartedAt = Date.now();
        payments = await Payment.find(match).populate('patient', 'fullName').lean();
        paymentsQueryMs = Date.now() - paymentsStartedAt;
        const paymentsFilterStartedAt = Date.now();
        payments = payments.filter(p => {
            const nome = (p.patient?.fullName || '').toLowerCase();
            return !nome.includes('teste') && !nome.includes('test ');
        });
        paymentsFilterMs = Date.now() - paymentsFilterStartedAt;
    }

    const executionTimeMs = Date.now() - startedAt;
    logMetric('UnifiedFinancialService', 'calculateCash', {
      executionTimeMs,
      paymentCount: count,
      total,
      stages: {
        totalAggMs,
        samplesMs,
        methodAndTypeAggMs: 0, // agora dentro do totalAggMs via $facet
        paymentsQueryMs,
        paymentsFilterMs
      }
    });

    const result = {
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

    _setUfsCached(cacheKey, result);
    return result;
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

/**
 * Versão do calculateCash otimizada para o dashboard V3.
 * Elimina Payment.find().populate('patient') desnecessário — o dashboard não usa a lista de payments.
 * Mantém receitaReal/receitaDiferida calculando apenas sobre pacotes full pré-pagos.
 */
export async function calculateCashForDashboard(start, end) {
    const startedAt = Date.now();
    const cacheKey = _ufsCacheKey('calculateCashForDashboard', start, end);
    const cached = _getUfsCached(cacheKey);
    if (cached) return cached;

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
                    { financialDate: null, paymentDate: { $gte: start, $lte: end } },
                    { financialDate: { $exists: false }, paymentDate: { $exists: false }, createdAt: { $gte: start, $lte: end } },
                    { financialDate: null, paymentDate: null, createdAt: { $gte: start, $lte: end } }
                ]
            }
        ]
    };

    // 🚀 OTIMIZAÇÃO: uma única aggregation com $facet reduz round-trips ao MongoDB
    // de 3 chamadas para 1. Cada chamada custa ~180ms no Render (latência Atlas),
    // então essa mudança economiza ~360ms por execução.
    const [facetResultRaw, pkgPayments] = await Promise.all([
        Payment.aggregate([
            { $match: match },
            { $facet: {
                total: [
                    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
                ],
                byMethod: [
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
                ],
                byType: [
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
                ]
            }}
        ]),
        Payment.find({
            status: 'paid',
            amount: { $gt: 0 },
            package: { $exists: true, $ne: null },
            $or: [
                { session: { $exists: false } },
                { session: null }
            ],
            $or: [
                { appointment: { $exists: false } },
                { appointment: null }
            ],
            $and: [
                {
                    $or: [
                        { financialDate: { $gte: start, $lte: end } },
                        { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
                        { financialDate: null, paymentDate: { $gte: start, $lte: end } },
                        { financialDate: { $exists: false }, paymentDate: { $exists: false }, createdAt: { $gte: start, $lte: end } },
                        { financialDate: null, paymentDate: null, createdAt: { $gte: start, $lte: end } }
                    ]
                }
            ]
        }).select('amount package').lean()
    ]);
    const facetResult = facetResultRaw[0];

    const totalAgg = facetResult.total;
    const methodAgg = facetResult.byMethod;
    const typeAgg = facetResult.byType;

    const total = totalAgg[0]?.total || 0;
    const count = totalAgg[0]?.count || 0;

    const byMethod = { pix: 0, dinheiro: 0, cartao: 0, outros: 0 };
    methodAgg.forEach(r => { byMethod[r._id] = r.total; });

    const particular = typeAgg.find(r => r._id === 'particular')?.total || 0;
    const pacote = typeAgg.find(r => r._id === 'pacote')?.total || 0;
    const convenio = typeAgg.find(r => r._id === 'convenio')?.total || 0;
    const liminar = typeAgg.find(r => r._id === 'liminar')?.total || 0;

    const { receitaReal, receitaDiferida } = await _calcReceitaReal(pkgPayments);

    const result = {
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
        receitaReal,
        receitaDiferida
    };

    _setUfsCached(cacheKey, result);
    console.log(`[calculateCashForDashboard] ${Date.now() - startedAt}ms (payments=${count})`);
    return result;
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
export async function calculateProduction(start, end, { skipPendente = false, includeDetails = true } = {}) {
    const startedAt = Date.now();
    const cacheKey = _ufsCacheKey('calculateProduction', start, end, { skipPendente, includeDetails });
    const cached = _getUfsCached(cacheKey);
    if (cached) return cached;
    // 🎯 FONTE ÚNICA DE VERDADE — Aggregation direta no MongoDB
    const match = {
        date: { $gte: start, $lte: end },
        status: 'completed'
    };

    // 1-2. Total e tipo em uma única aggregation com $facet (mesmo match + pkgLookupStages).
    // 🚀 Reduz 2 round-trips para 1.
    const totalAggStartedAt = Date.now();
    const totalAndTypeFacet = (await Session.aggregate([
        { $match: match },
        ...pkgLookupStages,
        { $facet: {
            total: [
                { $group: { _id: null, total: { $sum: '$effectiveValue' }, count: { $sum: 1 } } }
            ],
            byType: [
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
            ]
        }}
    ]))[0];
    const totalAggMs = Date.now() - totalAggStartedAt;

    const totalAgg = totalAndTypeFacet.total;
    const typeAgg = totalAndTypeFacet.byType;

    const total = totalAgg[0]?.total || 0;
    const count = totalAgg[0]?.count || 0;

    const particular = typeAgg.find(r => r._id === 'particular')?.total || 0;
    const pacote = typeAgg.find(r => r._id === 'pacote')?.total || 0;
    const convenio = typeAgg.find(r => r._id === 'convenio')?.total || 0;
    const liminar = typeAgg.find(r => r._id === 'liminar')?.total || 0;

    // Diagnóstico extra: listar primeiras sessions do período (apenas desenvolvimento)
    let samplesMs = 0;
    if (count > 0 && process.env.NODE_ENV === 'development') {
        const samplesStartedAt = Date.now();
        const samples = await Session.find(match).select('date sessionValue package status paymentMethod paymentOrigin').limit(5).lean();
        samplesMs = Date.now() - samplesStartedAt;
        console.log(`[calculateProduction] Amostras:`, samples.map(s => ({
            date: s.date,
            sessionValue: s.sessionValue,
            package: s.package,
            status: s.status,
            method: s.paymentMethod,
            origin: s.paymentOrigin
        })));
    }

    // 3. Recebido vs Pendente (para compatibilidade com sanity-check e consumers)
    const recebidoAggStartedAt = Date.now();
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
    const recebidoAggMs = Date.now() - recebidoAggStartedAt;
    const recebido = recebidoAgg[0]?.total || 0;
    const pendente = total - recebido;

    // 4. Particular Pendente vs Pacote Pendente — fonte: Session (nao Payment)
    let particularPendenteAggMs = 0;
    let particularPendente = 0;
    if (!skipPendente) {
        const particularPendenteAggStartedAt = Date.now();
        // CORRECAO: Payment.pending pega pagamentos de meses anteriores ainda em aberto.
        // O correto e calcular a partir de sessoes COMPLETED no periodo que ainda nao foram pagas.
        const particularPendenteAgg = await Session.aggregate([
            { $match: { date: { $gte: start, $lte: end }, status: 'completed' } },
            { $lookup: { from: 'appointments', localField: 'appointmentId', foreignField: '_id', as: 'appt' } },
            { $unwind: '$appt' },
            { $match: {
                'appt.billingType': { $nin: ['convenio', 'liminar'] },
                'appt.operationalStatus': 'completed'
            }},
            // appointment.billingType pode ser stale; session.paymentMethod é o SSOT — evita dupla contagem com convenioAReceber
            { $match: {
                paymentMethod: { $nin: ['convenio', 'liminar_credit'] },
                paymentOrigin: { $nin: ['convenio', 'liminar', 'liminar_credit'] }
            }},
            { $lookup: { from: 'packages', localField: 'appt.package', foreignField: '_id', as: 'pkg' } },
            { $match: { $or: [
                { 'appt.package': { $exists: false } },
                { 'appt.package': null },
                { 'pkg.paymentType': { $in: ['per_session', 'session'] } },
                { 'pkg.model': 'per_session' },
                { pkg: { $size: 0 } }
            ]}},
            { $lookup: { from: 'payments', localField: 'appt.payment', foreignField: '_id', as: 'payment' } },
            { $match: { $or: [
                { payment: { $size: 0 } },
                { 'payment.status': { $ne: 'paid' } }
            ]}},
            { $group: { _id: null, total: { $sum: '$sessionValue' }, count: { $sum: 1 } } }
        ]);
        particularPendenteAggMs = Date.now() - particularPendenteAggStartedAt;
        particularPendente = particularPendenteAgg[0]?.total || 0;
    }

    // Pacote Pendente: para pacotes prepaid/full, o dinheiro entrou na venda.
    // NAO deve haver pendente — sessoes sem payment vinculado sao normais (payment e do pacote).
    // CORRECAO: forca 0 para evitar inflacao do aReceberProducao com dados inconsistentes.
    const pacotePendente = 0;

    // 5. Buscar sessions completas para compatibilidade com endpoints legados
    let sessions = [];
    let sessionsMs = 0;
    if (includeDetails) {
        const sessionsStartedAt = Date.now();
        sessions = await Session.find({
            date: { $gte: start, $lte: end },
            status: 'completed'
        }).populate('package', 'sessionValue totalValue totalSessions').lean();
        sessionsMs = Date.now() - sessionsStartedAt;
    }

    const executionTimeMs = Date.now() - startedAt;
    logMetric('UnifiedFinancialService', 'calculateProduction', {
      executionTimeMs,
      sessionCount: count,
      total,
      stages: {
        totalAggMs,
        samplesMs,
        recebidoAggMs,
        particularPendenteAggMs,
        sessionsMs
      }
    });

    const result = {
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

    _setUfsCached(cacheKey, result);
    return result;
}

/**
 * Versão do calculateProduction otimizada para o dashboard V3.
 * Elimina Session.find().populate('package') desnecessário — o dashboard não usa a lista de sessions.
 */
export async function calculateProductionForDashboard(start, end) {
    const startedAt = Date.now();
    const cacheKey = _ufsCacheKey('calculateProductionForDashboard', start, end);
    const cached = _getUfsCached(cacheKey);
    if (cached) return cached;

    const match = {
        date: { $gte: start, $lte: end },
        status: 'completed'
    };

    // 🚀 OTIMIZAÇÃO: total e type compartilham o mesmo match + pkgLookupStages.
    // Usar $facet reduz round-trips de 2 para 1 nesse par. Recebido e particularPendente
    // mantêm seus próprios pipelines porque têm matches diferentes.
    const [totalAndTypeFacetRaw, recebidoAgg, particularPendenteAgg] = await Promise.all([
        Session.aggregate([
            { $match: match },
            ...pkgLookupStages,
            { $facet: {
                total: [
                    { $group: { _id: null, total: { $sum: '$effectiveValue' }, count: { $sum: 1 } } }
                ],
                byType: [
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
                ]
            }}
        ]),
        Session.aggregate([
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
        ]),
        Session.aggregate([
            { $match: { date: { $gte: start, $lte: end }, status: 'completed' } },
            { $lookup: { from: 'appointments', localField: 'appointmentId', foreignField: '_id', as: 'appt' } },
            { $unwind: '$appt' },
            { $match: {
                'appt.billingType': { $nin: ['convenio', 'liminar'] },
                'appt.operationalStatus': 'completed'
            }},
            { $match: {
                paymentMethod: { $nin: ['convenio', 'liminar_credit'] },
                paymentOrigin: { $nin: ['convenio', 'liminar', 'liminar_credit'] }
            }},
            { $lookup: { from: 'packages', localField: 'appt.package', foreignField: '_id', as: 'pkg' } },
            { $match: { $or: [
                { 'appt.package': { $exists: false } },
                { 'appt.package': null },
                { 'pkg.paymentType': { $in: ['per_session', 'session'] } },
                { 'pkg.model': 'per_session' },
                { pkg: { $size: 0 } }
            ]}},
            { $lookup: { from: 'payments', localField: 'appt.payment', foreignField: '_id', as: 'payment' } },
            { $match: { $or: [
                { payment: { $size: 0 } },
                { 'payment.status': { $ne: 'paid' } }
            ]}},
            { $group: { _id: null, total: { $sum: '$sessionValue' }, count: { $sum: 1 } } }
        ])
    ]);
    const totalAndTypeFacet = totalAndTypeFacetRaw[0];

    const totalAgg = totalAndTypeFacet.total;
    const typeAgg = totalAndTypeFacet.byType;

    const total = totalAgg[0]?.total || 0;
    const count = totalAgg[0]?.count || 0;

    const particular = typeAgg.find(r => r._id === 'particular')?.total || 0;
    const pacote = typeAgg.find(r => r._id === 'pacote')?.total || 0;
    const convenio = typeAgg.find(r => r._id === 'convenio')?.total || 0;
    const liminar = typeAgg.find(r => r._id === 'liminar')?.total || 0;

    const recebido = recebidoAgg[0]?.total || 0;
    const pendente = total - recebido;
    const particularPendente = particularPendenteAgg[0]?.total || 0;
    const pacotePendente = 0;

    const result = {
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
        sessions: []
    };

    _setUfsCached(cacheKey, result);
    console.log(`[calculateProductionForDashboard] ${Date.now() - startedAt}ms (sessions=${count})`);
    return result;
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
    const startedAt = Date.now();
    const cacheKey = _ufsCacheKey('calculateCashByCompetencia', start, end);
    const cached = _getUfsCached(cacheKey);
    if (cached) return cached;

    const match = {
        status: 'paid',
        amount: { $gt: 0 },
        isFromPackage: { $ne: true },
        kind: { $nin: ['package_consumed', 'package_receipt', 'monthly_settlement'] },
        serviceDate: { $gte: start, $lte: end }
    };

    // 🚀 OTIMIZAÇÃO: colapsar total + type em uma única aggregation com $facet
    const facetResult = (await Payment.aggregate([
        { $match: match },
        { $facet: {
            total: [
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ],
            byType: [
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
            ]
        }}
    ]))[0];

    const totalAgg = facetResult.total;
    const typeAgg = facetResult.byType;

    const total   = totalAgg[0]?.total || 0;
    const count   = totalAgg[0]?.count || 0;
    const particular = typeAgg.find(r => r._id === 'particular')?.total || 0;
    const pacote     = typeAgg.find(r => r._id === 'pacote')?.total || 0;
    const convenio   = typeAgg.find(r => r._id === 'convenio')?.total || 0;
    const liminar    = typeAgg.find(r => r._id === 'liminar')?.total || 0;

    const result = { total, count, particular, pacote, convenio, liminar };
    _setUfsCached(cacheKey, result);
    console.log(`[calculateCashByCompetencia] ${Date.now() - startedAt}ms (payments=${count})`);
    return result;
}

/**
 * Versão leve de calculateCash: retorna apenas o total.
 * Usar quando o caller só precisa do somatório (ex: buildStats do dashboard).
 * Elimina 3 aggregations extras + Payment.find().populate() desnecessários.
 */
export async function calculateCashTotal(start, end) {
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
                    { financialDate: null, paymentDate: { $gte: start, $lte: end } },
                    { financialDate: { $exists: false }, paymentDate: { $exists: false }, createdAt: { $gte: start, $lte: end } },
                    { financialDate: null, paymentDate: null, createdAt: { $gte: start, $lte: end } }
                ]
            }
        ]
    };

    const agg = await Payment.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    return { total: agg[0]?.total || 0 };
}

export default {
    calculateCash,
    calculateCashForDashboard,
    calculateCashByDay,
    calculateProduction,
    calculateProductionForDashboard,
    calculateProductionByDay,
    calculateCashByCompetencia,
    calculateCashTotal,
    invalidateUFSCache
};
