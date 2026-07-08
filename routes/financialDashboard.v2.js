// routes/financialDashboard.v2.js
/**
 * 💰 DASHBOARD FINANCEIRO V3 — META ENGINE PROFISSIONAL
 *
 * Real-time + Metas configuráveis + Performance por profissional
 * + Ranking + Alertas inteligentes + Insights operacionais
 */

import express from 'express';
import moment from 'moment-timezone';
import { auth, authorize } from '../middleware/auth.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import Expense from '../models/Expense.js';
import Doctor from '../models/Doctor.js';
import FinancialGoal from '../models/FinancialGoal.js';
import Planning from '../models/Planning.js';
import FinancialLedger from '../models/FinancialLedger.js';
import mongoose from 'mongoose';
import { calculateDoctorCommission } from '../services/commissionService.js';
import { calculateCommissionBatch } from '../services/commissionRule.service.js';
import financialMetricsService from '../services/financialMetrics.service.js';
import financialSnapshotService from '../services/financialSnapshot.service.js';
import financialExpenseSnapshotService from '../services/financialExpenseSnapshot.service.js';
import { calculatePendentesEngine, getPatientPendingPayments } from '../services/financialEngine.js';
import { isConvenioSession } from '../utils/billingHelpers.js';
import FinancialDailySnapshot from '../models/FinancialDailySnapshot.js';
import Package from '../models/Package.js';
import unifiedFinancialService, { invalidateUFSCache } from '../services/unifiedFinancialService.v2.js';
import { buildCaixaBlock, buildProducaoBlock } from '../contracts/FinancialReport.js';
import { logMetric } from '../utils/logMetric.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

// Cache server-side com TTL diferenciado por tipo de mês
// Invalidação explícita via invalidateDashboardCache() em mutações financeiras
const _dashCache = new Map();
const _dashPending = new Map();
const DASH_CURRENT_MONTH_TTL = 30_000;  // 30s — mês atual (near real-time)
const DASH_PAST_MONTH_TTL    = 300_000; // 5min — meses passados (imutáveis)

function getDashCached(key, ttl = DASH_PAST_MONTH_TTL) {
    const entry = _dashCache.get(key);
    if (entry && Date.now() - entry.ts < ttl) {
        console.log(`[DashboardV3] CACHE HIT: ${key} age=${Date.now() - entry.ts}ms ttl=${ttl}ms`);
        return entry.data;
    }
    return null;
}
function setDashCached(key, data) {
    if (_dashCache.size > 50) _dashCache.clear();
    _dashCache.set(key, { data, ts: Date.now() });
    console.log(`[DashboardV3] CACHE SET: ${key}`);
}

/**
 * Invalida todo o cache do dashboard financeiro.
 * Deve ser chamado após qualquer mutação que altere caixa ou produção
 * (completeSession, createPayment, refund, etc).
 */
export function invalidateDashboardCache() {
    const size = _dashCache.size;
    _dashCache.clear();
    _dashPending.clear();
    invalidateUFSCache();
    console.log(`[DashboardV3] Cache invalidado (${size} entradas limpas)`);
}

const paymentBaseFilter = {
    status: { $in: ['paid', 'completed', 'confirmed'] },
    amount: { $gte: 1 }
};

// Cache server-side para calculateProfissionais — evita recalcular produção/comissões a cada request
const _profCache = new Map();
const PROF_CURRENT_MONTH_TTL = 30_000;   // 30s — mês atual
const PROF_PAST_MONTH_TTL    = 300_000;  // 5min — meses passados

function getProfCached(key, ttl) {
    const entry = _profCache.get(key);
    if (entry && Date.now() - entry.ts < ttl) {
        console.log(`[profissionais] CACHE HIT ${key} age=${Date.now() - entry.ts}ms ttl=${ttl}ms`);
        return entry.data;
    }
    return null;
}
function setProfCached(key, data) {
    if (_profCache.size > 50) _profCache.clear();
    _profCache.set(key, { data, ts: Date.now() });
    console.log(`[profissionais] CACHE SET ${key}`);
}

const _pendentesCache = new Map();
const PENDENTES_CURRENT_TTL = 60_000;
const PENDENTES_PAST_TTL    = 300_000;
function getPendentesCached(key, ttl) {
    const entry = _pendentesCache.get(key);
    if (entry && Date.now() - entry.ts < ttl) {
        console.log(`[pendentes] CACHE HIT ${key} age=${Date.now() - entry.ts}ms`);
        return entry.data;
    }
    return null;
}
function setPendentesCached(key, data) {
    if (_pendentesCache.size > 50) _pendentesCache.clear();
    _pendentesCache.set(key, { data, ts: Date.now() });
    console.log(`[pendentes] CACHE SET ${key}`);
}

const META_CONFIG = {
    diasUteis: 26
};

async function loadGoal(year, month, clinicId = 'default') {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    // 1. Busca no Planning primeiro (onde o front gerencia metas via /api/v2/goals)
    const planning = await Planning.findOne({
        type: 'monthly',
        'period.start': start,
        'period.end': end,
    }).lean();

    if (planning) {
        return {
            metaMensal: planning.targets?.expectedRevenue || 0,
            diasUteis: planning.targets?.workHours > 0
                ? Math.round(planning.targets.workHours / 8)
                : META_CONFIG.diasUteis,
            breakdown: {
                particular: 0,
                convenio: 0,
                pacote: 0,
                liminar: 0
            }
        };
    }

    // 2. Fallback: busca no modelo FinancialGoal
    const goal = await FinancialGoal.findOne({
        clinicId,
        year,
        month,
        active: true
    }).lean();

    if (goal) {
        return {
            metaMensal: goal.metaMensal,
            diasUteis: goal.diasUteis ?? META_CONFIG.diasUteis,
            breakdown: {
                particular: goal.breakdown?.particular ?? 0,
                convenio: goal.breakdown?.convenio ?? 0,
                pacote: goal.breakdown?.pacote ?? 0,
                liminar: goal.breakdown?.liminar ?? 0
            }
        };
    }

    // 3. Sem meta configurada — não inventar valor fixo
    return {
        metaMensal: 0,
        diasUteis: META_CONFIG.diasUteis,
        breakdown: { particular: 0, convenio: 0, pacote: 0, liminar: 0 }
    };
}

// GET /v2/financial/dashboard
router.get('/', auth, async (req, res) => {
    try {
        const { month, year } = req.query;
        const targetMonth = month ? parseInt(month) : moment().month() + 1;
        const targetYear = year ? parseInt(year) : moment().year();
        const monthKey = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;

        // Cache server-side: SÓ para meses passados. Mês atual = sempre real-time.
        const now = moment.tz(TIMEZONE);
        const isCurrentMonth = targetMonth === (now.month() + 1) && targetYear === now.year();
        const cacheKey = monthKey;
        
        const cacheTTL = isCurrentMonth ? DASH_CURRENT_MONTH_TTL : DASH_PAST_MONTH_TTL;

        {
            const cachedRes = getDashCached(cacheKey, cacheTTL);
            if (cachedRes) {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                res.setHeader('X-Cache-Status', 'HIT');
                return res.json(cachedRes);
            }
            if (_dashPending.has(cacheKey)) {
                try {
                    const result = await _dashPending.get(cacheKey);
                    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                    res.setHeader('Pragma', 'no-cache');
                    res.setHeader('Expires', '0');
                    res.setHeader('X-Cache-Status', 'PENDING');
                    return res.json(result);
                } catch {
                    // request em voo falhou — processa normalmente
                }
            }
            let _pendingResolve, _pendingReject;
            _dashPending.set(cacheKey, new Promise((rs, rj) => { _pendingResolve = rs; _pendingReject = rj; }));
            const _origJson = res.json.bind(res);
            res.json = (body) => {
                setDashCached(cacheKey, body);
                _pendingResolve?.(body);
                _dashPending.delete(cacheKey);
                res.json = _origJson;
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                res.setHeader('X-Cache-Status', 'MISS');
                return _origJson(body);
            };
        }

        // 🆕 PROJEÇÃO V2: tenta usar snapshot primeiro
        const snapshotReady = await financialSnapshotService.isMonthlySnapshotReady(targetYear, targetMonth);
        let data, profissionais, source = 'real-time';

        if (snapshotReady && !isCurrentMonth) {
            console.log(`[DashboardV3] Usando snapshot: ${monthKey}`);
            source = 'snapshot';
            const snap = await financialSnapshotService.getMonthlyAggregate(targetYear, targetMonth);
            data = {
                caixa: snap.caixa,
                caixaHoje: snap.caixaHoje,
                caixaDetalhe: snap.caixaDetalhe,
                caixaByMethod: snap.caixaByMethod,
                producao: snap.producao,
                producaoDetalhe: snap.producaoDetalhe,
                saldo: snap.saldo
            };

            // 🆕 PROJEÇÃO V2 de DESPESAS (separada da receita)
            const expenseSnapshotReady = await financialExpenseSnapshotService.isMonthlySnapshotReady(targetYear, targetMonth);
            let despesasSnap;
            if (expenseSnapshotReady) {
                const expSnap = await financialExpenseSnapshotService.getMonthlyAggregate(targetYear, targetMonth);
                // Monta detalhe de comissões com nomes dos profissionais
                const doctorIds = Array.from(expSnap.profissionais.keys());
                const doctorsForExp = await Doctor.find({ _id: { $in: doctorIds } }).select('_id fullName').lean();
                const doctorNameMap = new Map(doctorsForExp.map(d => [d._id.toString(), d.fullName]));
                const detalheComissoes = Array.from(expSnap.profissionais.values())
                    .filter(p => p.commission > 0 || p.commissionProvisao > 0)
                    .map(p => ({
                        doctorId: p.doctorId,
                        doctorName: doctorNameMap.get(p.doctorId) || 'Profissional',
                        total: parseFloat(((p.commission || 0) + (p.commissionProvisao || 0)).toFixed(2)),
                        sessions: p.countSessions
                    }));

                despesasSnap = {
                    total: parseFloat(expSnap.total.toFixed(2)),
                    count: expSnap.count,
                    breakdown: {
                        expenses: parseFloat(((expSnap.breakdown.fixed || 0) + (expSnap.breakdown.variable || 0) + (expSnap.breakdown.other || 0)).toFixed(2)),
                        comissoes: parseFloat((expSnap.breakdown.commission || 0).toFixed(2)),
                        detalheComissoes
                    }
                };
            } else {
                despesasSnap = await calculateDespesas(targetYear, targetMonth);
            }

            const [aReceberSnap, comparativosSnap, pendentesSnap, appointmentCountsSnap] = await Promise.all([
                calculateAReceber(targetYear, targetMonth),
                calculateComparativos(targetYear, targetMonth),
                calculatePendentes(targetYear, targetMonth),
                calculateAppointmentCounts(targetYear, targetMonth),
            ]);

            const metasSnap = await calculateMetas(data, targetYear, targetMonth);
            const profissionaisSnap = await calculateProfissionaisFromSnapshot(snap.profissionais, targetYear, targetMonth);

            const insightsSnap = generateInsights(data, metasSnap, profissionaisSnap);
            const riscoOperacionalSnap = calculateRiscoOperacional(data, metasSnap, profissionaisSnap);
            const acoesExecutivasSnap = calculateAcoesExecutivas(data, metasSnap, profissionaisSnap, riscoOperacionalSnap);
            const drillDownSnap = buildDrillDown(data, profissionaisSnap);
            const indicadoresSnap = calculateIndicadores(data.caixa, data.producao, despesasSnap.total, metasSnap);

            // Campos de competência derivados do snapshot (mesma fórmula do real-time)
            const _snapConvenioAReceber  = Math.max(0, (data.producaoDetalhe?.convenio  || 0) - (data.caixaDetalhe?.convenio  || 0));
            const _snapLiminarAReceber   = Math.max(0, (data.producaoDetalhe?.liminar   || 0) - (data.caixaDetalhe?.liminar   || 0));
            const _snapParticularPend    = data.producaoDetalhe?.particularPendente || 0;
            const _snapPacotePend        = data.producaoDetalhe?.pacotePendente     || 0;
            const _snapAReceberProducao  = _snapConvenioAReceber + _snapLiminarAReceber + _snapParticularPend + _snapPacotePend;
            const _snapRecebidoProducao  = Math.max(0, (data.producao || 0) - _snapAReceberProducao);
            const _snapRecebimentosAntecipados       = Math.max(0, (data.caixa   || 0) - _snapRecebidoProducao);
            const _snapResultadoCaixa    = data.caixa    || 0;
            const _snapResultadoEcon     = data.producao || 0;
            const _snapRecebimentoProd   = {
                total:     _snapRecebidoProducao,
                particular: Math.max(0, (data.producaoDetalhe?.particular || 0) - _snapParticularPend),
                pacote:     Math.max(0, (data.producaoDetalhe?.pacote     || 0) - _snapPacotePend),
                convenio:   Math.max(0, (data.producaoDetalhe?.convenio   || 0) - _snapConvenioAReceber),
                liminar:    Math.max(0, (data.producaoDetalhe?.liminar    || 0) - _snapLiminarAReceber),
            };

            return res.json({
                success: true,
                source,
                resumo: {
                    caixa: data.caixa,
                    caixaHoje: data.caixaHoje,
                    caixaDetalhe: data.caixaDetalhe,
                    producao: data.producao,
                    producaoHoje: data.producaoHoje,
                    producaoDetalhe: data.producaoDetalhe,
                    resultadoEconomico: _snapResultadoEcon,
                    receitaReconhecida: data.receitaReconhecida,
                    novaReceitaMes: data.novaReceitaMes,
                    resultadoCaixa: _snapResultadoCaixa,
                    convenioAReceber: _snapConvenioAReceber,
                    particularPendente: _snapParticularPend,
                    pacotePendente: _snapPacotePend,
                    recebimentoProducao: _snapRecebimentoProd,
                    retroativos: _snapRecebimentosAntecipados,
                    aReceberProducao: _snapAReceberProducao,
                    aReceber: aReceberSnap,
                    pendentes: pendentesSnap,
                    saldo: data.saldo,
                    despesas: despesasSnap,
                    metas: metasSnap,
                    profissionais: profissionaisSnap.ranking,
                    indicadores: indicadoresSnap
                },
                data: {
                    period: { month: targetMonth, year: targetYear },
                    cash: {
                        total: data.caixa,
                        today: data.caixaHoje,
                        breakdown: data.caixaDetalhe,
                        byMethod: data.caixaByMethod
                    },
                    revenue: {
                        total: data.producao,
                        today: data.producaoHoje,
                        byMethod: data.producaoDetalhe
                    },
                    pendentes: pendentesSnap,
                    expenses: {
                        total: despesasSnap.total,
                        count: despesasSnap.count,
                        breakdown: despesasSnap.breakdown
                    },
                    balance: data.saldo,
                    resultadoCaixa: _snapResultadoCaixa,
                    resultadoEconomico: _snapResultadoEcon,
                    receitaReconhecida: data.receitaReconhecida,
                    novaReceitaMes: data.novaReceitaMes,
                    convenioAReceber: _snapConvenioAReceber,
                    particularPendente: _snapParticularPend,
                    pacotePendente: _snapPacotePend,
                    recebimentoProducao: _snapRecebimentoProd,
                    retroativos: _snapRecebimentosAntecipados,
                    aReceberProducao: _snapAReceberProducao,
                    metas: metasSnap,
                    profissionais: profissionaisSnap,
                    insights: insightsSnap,
                    comparativos: comparativosSnap,
                    riscoOperacional: riscoOperacionalSnap,
                    acoesExecutivas: acoesExecutivasSnap,
                    drillDown: drillDownSnap,
                    indicadores: indicadoresSnap,
                    appointmentCounts: appointmentCountsSnap
                },
                metadata: { projection: true }
            });
        }

        const _t0 = Date.now();
        const _timeit = (label, promise) => {
            const s = Date.now();
            return promise.then(r => { console.log(`[FinancialDashboard] ${label} = ${Date.now() - s}ms`); return r; });
        };

        // Fase 1: queries independentes em paralelo
        const [dataRt, aReceber, despesas, pendentes, appointmentCounts] = await Promise.all([
            _timeit('realTime',    calculateRealTime(targetYear, targetMonth)),
            _timeit('aReceber',    calculateAReceber(targetYear, targetMonth)),
            _timeit('despesas',    calculateDespesas(targetYear, targetMonth)),
            _timeit('pendentes',   calculatePendentes(targetYear, targetMonth)),
            _timeit('appointments', calculateAppointmentCounts(targetYear, targetMonth)),
        ]);
        data = dataRt;

        // Fase 2: dependem de `data`; comparativos recebe preComputed para evitar recompute do mês atual
        const [metas, profissionaisRt, comparativos] = await Promise.all([
            _timeit('metas',         calculateMetas(data, targetYear, targetMonth)),
            _timeit('profissionais', calculateProfissionais(data, targetYear, targetMonth)),
            _timeit('comparativos',  calculateComparativos(targetYear, targetMonth, { currentRealTime: dataRt, currentDespesas: despesas })),
        ]);
        profissionais = profissionaisRt;
        console.log(`[FinancialDashboard] TOTAL real-time = ${Date.now() - _t0}ms`);

        const insights = generateInsights(data, metas, profissionais);
        const riscoOperacional = calculateRiscoOperacional(data, metas, profissionais);
        const acoesExecutivas = calculateAcoesExecutivas(data, metas, profissionais, riscoOperacional);
        const drillDown = buildDrillDown(data, profissionais);
        const indicadores = calculateIndicadores(data.caixa, data.producao, despesas.total, metas);

        res.json({
            success: true,
            source: 'real-time',
            resumo: {
                caixa: data.caixa,
                caixaHoje: data.caixaHoje,
                caixaDetalhe: data.caixaDetalhe,
                producao: data.producao,
                producaoHoje: data.producaoHoje,
                producaoDetalhe: data.producaoDetalhe,
                resultadoEconomico: data.resultadoEconomico,
                receitaReconhecida: data.receitaReconhecida,
                novaReceitaMes: data.novaReceitaMes,
                resultadoCaixa: data.resultadoCaixa,
                convenioAReceber: data.convenioAReceber,
                particularPendente: data.particularPendente,
                pacotePendente: data.pacotePendente,
                recebimentoProducao: data.recebimentoProducao,
                recebimentosAntecipados: data.recebimentosAntecipados,
                aReceberProducao: data.aReceberProducao,
                aReceber,
                pendentes,
                saldo: data.saldo,
                despesas,
                metas,
                profissionais: profissionais.ranking,
                indicadores,
                appointmentCounts,
                // 🆕 NOVA ARQUITETURA SEMÂNTICA V3
                visaoSemantica: data.visaoSemantica,
            },
            data: {
                period: { month: targetMonth, year: targetYear },
                cash: {
                    total: data.caixa,
                    today: data.caixaHoje,
                    breakdown: data.caixaDetalhe,
                    byMethod: data.caixaByMethod
                },
                revenue: {
                    total: data.producao,
                    today: data.producaoHoje,
                    byMethod: data.producaoDetalhe
                },
                pendentes,
                expenses: {
                    total: despesas.total,
                    count: despesas.count
                },
                balance: data.saldo,
                resultadoEconomico: data.resultadoEconomico,
                receitaReconhecida: data.receitaReconhecida,
                novaReceitaMes: data.novaReceitaMes,
                resultadoCaixa: data.resultadoCaixa,
                convenioAReceber: data.convenioAReceber,
                particularPendente: data.particularPendente,
                pacotePendente: data.pacotePendente,
                recebimentoProducao: data.recebimentoProducao,
                recebimentosAntecipados: data.recebimentosAntecipados,
                aReceberProducao: data.aReceberProducao,
                // 🆕 Metas separadas por camada
                metas: {
                    ...metas,
                    // Sobrescreve com valores calculados pelas camadas semânticas
                    tipoPrincipal: metas.configuracao?.tipoMeta || 'producao',
                    producao: {
                        meta: metas.configuracao?.metaMensal || 0,
                        atingido: metas.camadas?.producao?.atingido || data.producao || 0,
                        percentual: metas.camadas?.producao?.percentual || 0,
                    },
                    caixa: {
                        meta: metas.configuracao?.metaMensal || 0,
                        atingido: metas.camadas?.caixa?.atingido || data.caixa || 0,
                        percentual: metas.camadas?.caixa?.percentual || 0,
                    },
                    receitaProjetada: {
                        meta: metas.configuracao?.metaMensal || 0,
                        atingido: metas.camadas?.receitaProjetada?.atingido || data.receitaReconhecida || 0,
                        percentual: metas.camadas?.receitaProjetada?.percentual || 0,
                    }
                },
                profissionais,
                insights,
                // 🆕 Nova visão semântica
                visaoSemantica: data.visaoSemantica,
                comparativos,
                riscoOperacional,
                acoesExecutivas,
                drillDown,
                indicadores,
                appointmentCounts
            },
            metadata: {
                projection: false
            }
        });

    } catch (error) {
        console.error('[DashboardV3] Erro:', error);
        _pendingReject?.(error);
        _dashPending.delete(monthKey);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 🔄 POST /v2/financial/dashboard/rebuild-snapshot
 * Reprocessa Payments e Sessions para reconstruir snapshots de um período.
 * Útil para correções pontuais ou backfill manual.
 */
router.post('/rebuild-snapshot', auth, async (req, res) => {
    try {
        const { startDate, endDate, clearFirst = true, clinicId } = req.body;
        if (!startDate || !endDate) {
            return res.status(400).json({ success: false, error: 'startDate e endDate são obrigatórios' });
        }

        console.log(`[DashboardV3] Rebuild snapshot: ${startDate} → ${endDate} (clearFirst=${clearFirst})`);

        // Limpa snapshots do período antes de reconstruir (evita double-count)
        if (clearFirst) {
            const startStr = moment.tz(startDate, TIMEZONE).startOf('day').format('YYYY-MM-DD');
            const endStr = moment.tz(endDate, TIMEZONE).endOf('day').format('YYYY-MM-DD');
            const cid = clinicId || req.user?.clinicId || 'default';
            const deleted = await FinancialDailySnapshot.deleteMany({
                clinicId: cid,
                date: { $gte: startStr, $lte: endStr }
            });
            console.log(`[DashboardV3] Snapshots deletados: ${deleted.deletedCount} (${startStr} → ${endStr})`);
        }

        const { processFinancialEvent } = await import('../workers/financialSnapshotWorker.v2.js');

        // 1. Reprocessar Sessions completed
        const startDateObj = moment.tz(startDate, TIMEZONE).startOf('day').toDate();
        const endDateObj = moment.tz(endDate, TIMEZONE).endOf('day').toDate();
        const sessions = await Session.find({
            date: { $gte: startDateObj, $lte: endDateObj },
            status: 'completed'
        }).select('date sessionValue paymentMethod package status doctor paymentOrigin').lean();

        for (const s of sessions) {
            await processFinancialEvent('SESSION_COMPLETED', {
                eventId: `rebuild-session-${s._id}`,
                _id: s._id,
                sessionId: s._id,
                clinicId: req.user?.clinicId || 'default',
                sessionValue: s.sessionValue,
                paymentMethod: s.paymentMethod,
                date: s.date,
                doctor: s.doctor,
                paymentOrigin: s.paymentOrigin,
            });
        }

        // 2. Reprocessar Payments (paid / partial)
        const payments = await Payment.find({
            kind: { $ne: 'package_consumed' }, // 🛡️ package_consumed NÃO é caixa
            $or: [
                { status: 'paid', paymentDate: { $gte: startDate, $lte: endDate } },
                { billingType: 'convenio', 'insurance.status': { $in: ['received', 'partial'] }, 'insurance.receivedAt': { $gte: new Date(startDate), $lte: new Date(endDate) } }
            ]
        }).select('paymentDate billingType insurance.receivedAmount amount paymentMethod status notes description type serviceType doctor').lean();

        for (const p of payments) {
            const payload = {
                eventId: `rebuild-payment-${p._id}`,
                paymentId: p._id,
                _id: p._id,
                clinicId: req.user?.clinicId || 'default',
                amount: p.amount,
                paymentMethod: p.paymentMethod,
                status: p.status,
                billingType: p.billingType,
                notes: p.notes,
                description: p.description,
                type: p.type,
                serviceType: p.serviceType,
                doctor: p.doctor,
            };
            if (p.status === 'paid') {
                await processFinancialEvent('PAYMENT_COMPLETED', payload);
            }
            // status 'partial' não gera snapshot parcial; aguarda quitação total.
        }

        res.json({
            success: true,
            message: 'Snapshot reconstruído',
            processed: { sessions: sessions.length, payments: payments.length }
        });
    } catch (error) {
        console.error('[DashboardV3] Erro no rebuild:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 🔍 GET /v2/financial/dashboard/audit
 * Auditoria detalhada do caixa: lista cada pagamento e sessão paga, dia a dia.
 * Responde à pergunta: "de onde vem o valor do caixa deste mês?"
 */
router.get('/audit', auth, async (req, res) => {
    try {
        const { month, year } = req.query;
        const m = parseInt(month || new Date().getMonth() + 1);
        const y = parseInt(year || new Date().getFullYear());
        const clinicId = req.user?.clinicId || 'default';

        const startDate = moment.tz([y, m - 1, 1], TIMEZONE).startOf('day').toDate();
        const endDate   = moment.tz([y, m - 1], TIMEZONE).endOf('month').toDate();

        // 1. Payments pagos (particular + convênio avulso)
        const payments = await Payment.find({
            clinicId,
            status: { $in: ['paid', 'completed', 'confirmed'] },
            paymentDate: { $gte: startDate, $lte: endDate },
            amount: { $gte: 1 }
        })
        .select('paymentDate paidAt amount billingType paymentMethod description notes patientId doctor')
        .sort({ paymentDate: 1 })
        .lean();

        // 2. Sessions de pacote pagas (sem paymentId vinculado — FASE 1 híbrido)
        const packageSessions = await Session.find({
            clinicId,
            isPaid: true,
            paymentMethod: { $in: ['package', 'convenio', 'plano'] },
            paymentId: { $exists: false },
            paidAt: { $gte: startDate, $lte: endDate }
        })
        .select('paidAt date sessionValue paymentMethod doctor patientId')
        .sort({ paidAt: 1 })
        .lean();

        // 3. Agrupa por dia
        const byDay = {};

        for (const p of payments) {
            const day = moment.tz(p.paymentDate, TIMEZONE).format('YYYY-MM-DD');
            if (!byDay[day]) byDay[day] = { payments: [], sessions: [], totalPayments: 0, totalSessions: 0 };
            byDay[day].payments.push({
                tipo: p.billingType || 'particular',
                metodo: p.paymentMethod,
                valor: p.amount,
                descricao: p.description || p.notes || '—',
                paidAt: p.paidAt,
                paymentDate: p.paymentDate
            });
            byDay[day].totalPayments += p.amount;
        }

        for (const s of packageSessions) {
            const day = moment.tz(s.paidAt || s.date, TIMEZONE).format('YYYY-MM-DD');
            if (!byDay[day]) byDay[day] = { payments: [], sessions: [], totalPayments: 0, totalSessions: 0 };
            byDay[day].sessions.push({
                tipo: 'pacote/convênio',
                metodo: s.paymentMethod,
                valor: s.sessionValue,
                paidAt: s.paidAt,
                sessionDate: s.date
            });
            byDay[day].totalSessions += s.sessionValue || 0;
        }

        // 4. Totais gerais
        const totalPayments = payments.reduce((a, p) => a + p.amount, 0);
        const totalSessions = packageSessions.reduce((a, s) => a + (s.sessionValue || 0), 0);

        const breakdown = {
            particular: payments.filter(p => (p.billingType || 'particular') === 'particular').reduce((a, p) => a + p.amount, 0),
            convenioAvulso: payments.filter(p => p.billingType === 'convenio').reduce((a, p) => a + p.amount, 0),
            pacote: totalSessions
        };

        res.json({
            success: true,
            periodo: { mes: m, ano: y, inicio: startDate, fim: endDate },
            resumo: {
                totalCaixa: totalPayments + totalSessions,
                totalPayments,
                totalSessions,
                qtdPayments: payments.length,
                qtdSessions: packageSessions.length,
                breakdown
            },
            porDia: Object.entries(byDay)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([dia, d]) => ({
                    dia,
                    totalDia: d.totalPayments + d.totalSessions,
                    pagamentos: d.payments,
                    sessoesPacote: d.sessions,
                    subtotais: { pagamentos: d.totalPayments, sessoesPacote: d.totalSessions }
                }))
        });
    } catch (error) {
        console.error('[DashboardV3] Erro na auditoria:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 🎯 Calcula metas inteligentes de gestão
 */
async function calculateMetas(data, year, month, clinicId = 'default') {
    const now = moment.tz(TIMEZONE);
    const endOfMonth = moment.tz([year, month - 1], TIMEZONE).endOf('month');
    const daysInMonth = endOfMonth.date();
    const isMonthClosed = now.isAfter(endOfMonth);
    const daysPassed = isMonthClosed ? daysInMonth : Math.min(now.date(), daysInMonth);
    const daysRemaining = isMonthClosed ? 0 : Math.max(daysInMonth - daysPassed, 1);

    const goal = await loadGoal(year, month, clinicId);
    const metaMensal = goal.metaMensal;
    const diasUteis = goal.diasUteis;
    // ─── BASE DE CÁLCULO: caixa + a receber da produção do mês (regra de negócio da clínica) ───
    const realizadoMes = (data.caixa || 0) + (data.aReceberProducao || 0);
    const realizadoDia = (data.caixaHoje || 0) + (data.convenioHoje || 0) + (data.particularPendenteHoje || 0);
    const producaoDia  = data.producaoHoje || 0;

    const _gapRestante = isMonthClosed ? 0 : Math.max(metaMensal - realizadoMes, 0);
    const metaDiariaNecessaria = daysRemaining > 0 ? _gapRestante / daysRemaining : 0;

    // ─── Camadas semânticas (mantidas para referência/análise) ───
    const caixaRealizadoMes    = data.caixa || 0;
    const producaoRealizadaMes = data.producao || 0;
    const receitaProjetadaMes  = data.visaoSemantica?.projecao?.total || realizadoMes;

    // ─── RITMO baseado em caixa + a receber ───
    const mediaDiariaAtual = daysPassed > 0 ? realizadoMes / daysPassed : 0;
    const projecaoFinal = isMonthClosed ? realizadoMes : mediaDiariaAtual * daysInMonth;

    // Projeção ESPERADA (conservadora): realizadoMes já inclui pipeline; projeta 60% da média nos dias restantes
    const projecaoEsperada = isMonthClosed
      ? realizadoMes
      : Math.min(
          projecaoFinal,
          realizadoMes + ((mediaDiariaAtual * daysRemaining) * 0.6)
        );

    const gapValor = isMonthClosed ? 0 : Math.max(metaMensal - realizadoMes, 0);
    const gapPorDia = daysRemaining > 0 ? gapValor / daysRemaining : 0;

    const ritmoEsperado = (daysPassed / daysInMonth) * metaMensal;
    const diferencaRitmo = realizadoMes - ritmoEsperado;

    const percentualEsperado = (daysPassed / daysInMonth) * 100;
    const percentualRealizado = metaMensal > 0 ? (realizadoMes / metaMensal) * 100 : 0;

    // Percentuais por camada semântica (para análise separada)
    const percentualProducao  = metaMensal > 0 ? (producaoRealizadaMes / metaMensal) * 100 : 0;
    const percentualCaixa     = metaMensal > 0 ? (caixaRealizadoMes / metaMensal) * 100 : 0;
    const percentualProjetada = metaMensal > 0 ? (receitaProjetadaMes / metaMensal) * 100 : 0;

    let statusMeta = 'vermelho';
    if (percentualRealizado >= 100) statusMeta = 'verde';
    else if (percentualRealizado >= 80) statusMeta = 'amarelo-verde';
    else if (percentualRealizado >= 60) statusMeta = 'amarelo';

    const alertas = {
        atrasado: metaMensal > 0 && realizadoMes < ritmoEsperado,
        critico: metaMensal > 0 && realizadoDia < (metaDiariaNecessaria * 0.7),
        ok: metaMensal > 0 && realizadoMes >= metaMensal,
        mensagem: []
    };

    if (metaMensal === 0) {
        alertas.mensagem.push('📌 Nenhuma meta mensal configurada para este período.');
    } else if (alertas.ok) {
        alertas.mensagem.push('🎉 Meta mensal batida!');
    } else if (alertas.critico) {
        alertas.mensagem.push('⚠️ Dia crítico: recebimento abaixo de 70% da meta diária.');
    } else if (alertas.atrasado) {
        alertas.mensagem.push('🐢 Ritmo abaixo do necessário para bater a meta.');
    } else {
        alertas.mensagem.push('✅ Ritmo adequado para meta mensal.');
    }

    if (metaMensal > 0) {
        if (projecaoFinal < metaMensal) {
            alertas.mensagem.push(`🔮 Projeção de fechamento: R$ ${projecaoFinal.toFixed(2).replace('.', ',')} (abaixo da meta).`);
        } else {
            alertas.mensagem.push(`🔮 Projeção de fechamento: R$ ${projecaoFinal.toFixed(2).replace('.', ',')} (acima da meta).`);
        }
    }

    return {
        configuracao: {
            metaMensal,
            diasUteis,
            metaDiariaNecessaria: parseFloat(metaDiariaNecessaria.toFixed(2)),
            tipoMeta: 'receitaProjetada',
        },
        realizado: {
            mes: parseFloat(realizadoMes.toFixed(2)),
            hoje: parseFloat(realizadoDia.toFixed(2))
        },
        realizadoLegado: {
            mes: parseFloat(producaoRealizadaMes.toFixed(2)),
            hoje: parseFloat(producaoDia.toFixed(2))
        },
        ritmo: {
            esperadoAteAgora: parseFloat(ritmoEsperado.toFixed(2)),
            realizadoAteAgora: parseFloat(realizadoMes.toFixed(2)),
            diferenca: parseFloat(diferencaRitmo.toFixed(2)),
            mediaDiariaAtual: parseFloat(mediaDiariaAtual.toFixed(2)),
            percentualEsperado: parseFloat(percentualEsperado.toFixed(1)),
            // 🎯 percentualRealizado = % de PRODUÇÃO contra meta
            percentualRealizado: parseFloat(percentualRealizado.toFixed(1))
        },
        projecao: {
            final: parseFloat(projecaoFinal.toFixed(2)),
            esperada: parseFloat(projecaoEsperada.toFixed(2)),
            bateMeta: projecaoEsperada >= metaMensal,
            bateMetaOtimista: projecaoFinal >= metaMensal
        },
        gap: {
            valor: parseFloat(gapValor.toFixed(2)),
            porDia: parseFloat(gapPorDia.toFixed(2)),
            diasRestantes: daysRemaining
        },
        statusMeta,
        alertas,
        porTipo: {
            particular: {
                meta: parseFloat((goal.breakdown.particular || 0).toFixed(2)),
                realizado: parseFloat((data.producaoDetalhe.particular || 0).toFixed(2)),
                percentualDoTotal: data.producao > 0 ? parseFloat(((data.producaoDetalhe.particular || 0) / data.producao * 100).toFixed(1)) : 0
            },
            pacote: {
                meta: parseFloat((goal.breakdown.pacote || 0).toFixed(2)),
                realizado: parseFloat((data.producaoDetalhe.pacote || 0).toFixed(2)),
                percentualDoTotal: data.producao > 0 ? parseFloat(((data.producaoDetalhe.pacote || 0) / data.producao * 100).toFixed(1)) : 0
            },
            convenio: {
                meta: parseFloat((goal.breakdown.convenio || 0).toFixed(2)),
                realizado: parseFloat((data.producaoDetalhe.convenio || 0).toFixed(2)),
                percentualDoTotal: data.producao > 0 ? parseFloat(((data.producaoDetalhe.convenio || 0) / data.producao * 100).toFixed(1)) : 0
            },
            liminar: {
                meta: parseFloat((goal.breakdown.liminar || 0).toFixed(2)),
                realizado: parseFloat((data.producaoDetalhe.liminar || 0).toFixed(2)),
                percentualDoTotal: data.producao > 0 ? parseFloat(((data.producaoDetalhe.liminar || 0) / data.producao * 100).toFixed(1)) : 0
            }
        },
        // 🆕 CAMADAS SEMÂNTICAS para preenchimento do data.metas
        camadas: {
            producao: {
                atingido: parseFloat(producaoRealizadaMes.toFixed(2)),
                percentual: parseFloat(percentualProducao.toFixed(1)),
            },
            caixa: {
                atingido: parseFloat(caixaRealizadoMes.toFixed(2)),
                percentual: parseFloat(percentualCaixa.toFixed(1)),
            },
            receitaProjetada: {
                atingido: parseFloat(receitaProjetadaMes.toFixed(2)),
                percentual: parseFloat(percentualProjetada.toFixed(1)),
            }
        }
    };
}

/**
 * 👩‍⚕️ Calcula performance por profissional — ALINHADO COM ARQUITETURA V2 (Session)
 */
async function calculateProfissionais(data, year, month) {
    const _t0 = Date.now();
    const now = moment.tz(TIMEZONE);
    const isCurrentMonth = year === now.year() && month === now.month() + 1;
    const profCacheKey = `profissionais_${year}_${month}`;
    const profCached = getProfCached(profCacheKey, isCurrentMonth ? PROF_CURRENT_MONTH_TTL : PROF_PAST_MONTH_TTL);
    if (profCached) return profCached;

    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').utc().toDate();
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month').utc().toDate();

    const _tDoctors = Date.now();
    const doctors = await Doctor.find({ active: { $ne: false } }).select('_id fullName specialty commissionRules').lean();
    console.log(`[profissionais] doctors.find = ${Date.now() - _tDoctors}ms (${doctors.length} docs)`);

    // Produção = Sessions completadas no mês (V2)
    const _tSessions = Date.now();
    const sessions = await Session.find({
        date: { $gte: start, $lte: end },
        status: 'completed'
    }).select('doctor sessionValue paymentMethod package paymentOrigin sessionType date insuranceGuide')
      .populate('package', 'sessionValue totalValue totalSessions')
      .lean();
    console.log(`[profissionais] sessions.find+populate = ${Date.now() - _tSessions}ms (${sessions.length} docs)`);

    // Caixa real = Payments do mês vinculados a sessões
    const _tPayments = Date.now();
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];
    const [particularPayments, convenioPayments] = await Promise.all([
        Payment.find({
            billingType: 'particular',
            status: 'paid',
            paymentDate: { $gte: startStr, $lte: endStr },
            session: { $exists: true, $ne: null }
        }).select('session amount').lean(),
        Payment.find({
            billingType: 'convenio',
            'insurance.status': { $in: ['received', 'partial'] },
            'insurance.receivedAt': { $gte: start, $lte: end },
            session: { $exists: true, $ne: null }
        }).select('session amount insurance.receivedAmount').lean()
    ]);
    console.log(`[profissionais] payments.find = ${Date.now() - _tPayments}ms (${particularPayments.length + convenioPayments.length} docs)`);

    const paymentMap = new Map();
    [...particularPayments, ...convenioPayments].forEach(p => {
        const sessionId = p.session?.toString();
        if (!sessionId) return;
        const val = p.billingType === 'convenio' ? (p.insurance?.receivedAmount || p.amount || 0) : (p.amount || 0);
        paymentMap.set(sessionId, (paymentMap.get(sessionId) || 0) + val);
    });

    // Sessões de pacote convênio pagas (sem Payment vinculado)
    const _tSessionCash = Date.now();
    const sessionCashResult = await Session.aggregate([
        {
            $match: {
                isPaid: true,
                paidAt: { $gte: start, $lte: end },
                paymentMethod: 'convenio',
                $or: [{ paymentId: { $exists: false } }, { paymentId: null }]
            }
        },
        {
            $lookup: {
                from: 'payments',
                let: { sessionId: '$_id' },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $or: [
                                    { $eq: ['$session', '$$sessionId'] },
                                    { $in: ['$$sessionId', { $ifNull: ['$sessions', []] }] }
                                ]
                            }
                        }
                    },
                    { $limit: 1 }
                ],
                as: 'linkedPayment'
            }
        },
        { $match: { linkedPayment: { $size: 0 } } },
        {
            $lookup: {
                from: 'packages',
                localField: 'package',
                foreignField: '_id',
                as: 'pkg'
            }
        },
        { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
        {
            $project: {
                _id: 1,
                doctor: 1,
                amount: { $ifNull: ['$sessionValue', '$pkg.insuranceGrossAmount'] }
            }
        }
    ]);
    sessionCashResult.forEach(s => {
        paymentMap.set(s._id.toString(), (paymentMap.get(s._id.toString()) || 0) + (s.amount || 0));
    });
    console.log(`[profissionais] sessionCash.aggregate = ${Date.now() - _tSessionCash}ms (${sessionCashResult.length} docs)`);

    const profMap = new Map();
    doctors.forEach(d => {
        profMap.set(d._id.toString(), {
            id: d._id.toString(),
            nome: d.fullName,
            especialidade: d.specialty || 'Outra',
            producao: 0,
            realizado: 0,
            quantidade: 0,
            particular: 0,
            convenio: 0,
            pacote: 0,
            liminar: 0
        });
    });

    sessions.forEach(s => {
        const docId = s.doctor?.toString();
        if (!docId || !profMap.has(docId)) return;

        const prof = profMap.get(docId);
        // Para sessões de pacote, package.sessionValue é o valor definitivo por sessão.
        const valor = s.package?.sessionValue > 0
            ? s.package.sessionValue
            : s.sessionValue > 0
                ? s.sessionValue
                : (s.package?.totalValue && s.package?.totalSessions)
                    ? Math.round(s.package.totalValue / s.package.totalSessions)
                    : 0;
        const paymentMethod = s.paymentMethod || 'particular';
        const isConvenio = isConvenioSession(s);
        const isPacote = !!s.package;
        const isLiminar = paymentMethod === 'liminar_credit' || s.paymentOrigin === 'liminar';

        prof.producao += valor;
        prof.quantidade += 1;

        if (isConvenio) prof.convenio += valor;
        else if (isLiminar) prof.liminar += valor;
        else if (isPacote) prof.pacote += valor;
        else prof.particular += valor;

        const pago = paymentMap.get(s._id.toString()) || 0;
        prof.realizado += pago;
    });

    let lista = Array.from(profMap.values()).filter(p => p.quantidade > 0 || p.realizado > 0);

    // 💰 Calcular comissões dos profissionais que tiveram atendimento
    // Otimização: evita N+1 de calculateDoctorCommission — usa sessions/doctors já carregados
    const _tCommissions = Date.now();
    const sessionsByDoctor = new Map();
    sessions.forEach(s => {
        const docId = s.doctor?.toString?.();
        if (!docId) return;
        if (!sessionsByDoctor.has(docId)) sessionsByDoctor.set(docId, []);
        sessionsByDoctor.get(docId).push(s);
    });

    const commissionResults = lista.map(p => {
        try {
            const doctor = doctors.find(d => d._id.toString() === p.id);
            if (!doctor) {
                return { id: p.id, comissao: { total: 0, sessoes: 0, breakdown: null } };
            }
            const doctorSessions = sessionsByDoctor.get(p.id) || [];
            const comm = calculateCommissionBatch(doctor, doctorSessions);
            return {
                id: p.id,
                comissao: {
                    total: parseFloat(comm.totalCommission.toFixed(2)),
                    sessoes: doctorSessions.length,
                    breakdown: comm.breakdown
                }
            };
        } catch (err) {
            console.error(`[profissionais] Erro ao calcular comissão do Dr. ${p.id}:`, err);
            return { id: p.id, comissao: { total: 0, sessoes: 0, breakdown: null } };
        }
    });
    const commissionMap = new Map(commissionResults.map(c => [c.id, c.comissao]));
    console.log(`[profissionais] commissions.calculateCommissionBatch = ${Date.now() - _tCommissions}ms (${lista.length} profissionais)`);

    const mediaProducao = lista.length > 0 ? lista.reduce((s, p) => s + p.producao, 0) / lista.length : 0;

    lista = lista.map(p => {
        const comissaoTotal = commissionMap.get(p.id)?.total || 0;
        const lucro = parseFloat((p.producao - comissaoTotal).toFixed(2));
        const margem = p.producao > 0 ? parseFloat(((lucro / p.producao) * 100).toFixed(1)) : 0;
        return {
            ...p,
            comissao: commissionMap.get(p.id) || { total: 0, sessoes: 0, breakdown: null },
            lucro,
            margem,
            ticketMedio: p.quantidade > 0 ? parseFloat((p.producao / p.quantidade).toFixed(2)) : 0,
            eficiencia: p.producao > 0 ? parseFloat(((p.realizado / p.producao) * 100).toFixed(1)) : 0,
            produtividade: mediaProducao > 0 ? parseFloat(((p.producao / mediaProducao) * 100).toFixed(1)) : 100
        };
    });

    const rankingPorRealizado = [...lista].sort((a, b) => b.realizado - a.realizado);
    const rankingPorProducao = [...lista].sort((a, b) => b.producao - a.producao);
    const rankingPorLucro = [...lista].sort((a, b) => b.lucro - a.lucro);

    console.log(`[profissionais] TOTAL = ${Date.now() - _t0}ms (${lista.length} profissionais)`);

    const profResult = {
        lista,
        ranking: rankingPorRealizado.slice(0, 10),
        rankingPorProducao: rankingPorProducao.slice(0, 10),
        rankingPorLucro: rankingPorLucro.slice(0, 10),
        mediaProducao: parseFloat(mediaProducao.toFixed(2)),
        totalProfissionais: lista.length
    };

    setProfCached(profCacheKey, profResult);
    return profResult;
}

/**
 * 👩‍⚕️ Calcula performance por profissional a partir do snapshot diário
 */
async function calculateProfissionaisFromSnapshot(snapshotProfMap, year, month) {
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').utc().toDate();
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month').utc().toDate();

    const doctors = await Doctor.find({ active: { $ne: false } }).select('_id fullName specialty commissionRules').lean();
    const doctorMap = new Map(doctors.map(d => [d._id.toString(), d]));

    let lista = [];
    for (const [profId, snapProf] of snapshotProfMap.entries()) {
        const doc = doctorMap.get(profId);
        if (!doc) continue;

        lista.push({
            id: profId,
            nome: doc.fullName,
            especialidade: doc.specialty || 'Outra',
            producao: snapProf.producao,
            realizado: snapProf.realizado,
            quantidade: snapProf.quantidade,
            particular: snapProf.particular,
            convenio: snapProf.convenio,
            pacote: snapProf.pacote,
            liminar: snapProf.liminar
        });
    }

    // 💰 Calcular comissões
    const commissionResults = await Promise.all(
        lista.map(async (p) => {
            try {
                const comm = await calculateDoctorCommission(p.id, start, end);
                return {
                    id: p.id,
                    comissao: {
                        total: parseFloat(comm.totalCommission.toFixed(2)),
                        sessoes: comm.totalSessions,
                        breakdown: comm.breakdown
                    }
                };
            } catch (err) {
                return {
                    id: p.id,
                    comissao: { total: 0, sessoes: 0, breakdown: null }
                };
            }
        })
    );
    const commissionMap = new Map(commissionResults.map(c => [c.id, c.comissao]));

    const mediaProducao = lista.length > 0 ? lista.reduce((s, p) => s + p.producao, 0) / lista.length : 0;

    lista = lista.map(p => {
        const comissaoTotal = commissionMap.get(p.id)?.total || 0;
        const lucro = parseFloat((p.producao - comissaoTotal).toFixed(2));
        const margem = p.producao > 0 ? parseFloat(((lucro / p.producao) * 100).toFixed(1)) : 0;
        return {
            ...p,
            comissao: commissionMap.get(p.id) || { total: 0, sessoes: 0, breakdown: null },
            lucro,
            margem,
            ticketMedio: p.quantidade > 0 ? parseFloat((p.producao / p.quantidade).toFixed(2)) : 0,
            eficiencia: p.producao > 0 ? parseFloat(((p.realizado / p.producao) * 100).toFixed(1)) : 0,
            produtividade: mediaProducao > 0 ? parseFloat(((p.producao / mediaProducao) * 100).toFixed(1)) : 100
        };
    });

    const rankingPorRealizado = [...lista].sort((a, b) => b.realizado - a.realizado);
    const rankingPorProducao = [...lista].sort((a, b) => b.producao - a.producao);
    const rankingPorLucro = [...lista].sort((a, b) => b.lucro - a.lucro);

    return {
        lista,
        ranking: rankingPorRealizado.slice(0, 10),
        rankingPorProducao: rankingPorProducao.slice(0, 10),
        rankingPorLucro: rankingPorLucro.slice(0, 10),
        mediaProducao: parseFloat(mediaProducao.toFixed(2)),
        totalProfissionais: lista.length
    };
}

/**
 * 🧠 Gera insights e recomendações operacionais
 */
function generateInsights(data, metas, profissionais) {
    const insights = [];
    const recomendacoes = [];
    const alertasV3 = [];

    const { caixaDetalhe, producaoDetalhe, producao } = data;
    const totalProducao = producao || 1;

    // 1. Dependência de convênio
    const pctConvenio = (producaoDetalhe.convenio / totalProducao) * 100;
    if (pctConvenio > 60) {
        insights.push(`A clínica depende ${pctConvenio.toFixed(0)}% de convênios — risco financeiro elevado.`);
        alertasV3.push({ tipo: 'dependencia_convenio', nivel: 'alto', mensagem: 'Convênio representa mais de 60% da produção', acao: 'Balancear agenda com particular' });
        recomendacoes.push('Reduzir slots ociosos de convênio e abrir mais vagas para particular.');
    }

    // 2. Particular abaixo da meta
    if (metas.porTipo.particular.realizado < metas.porTipo.particular.meta * 0.5) {
        insights.push('Particular está muito abaixo da meta mensal.');
        alertasV3.push({ tipo: 'risco_meta', nivel: 'alto', mensagem: 'Particular abaixo do esperado', acao: 'Aumentar foco em pacientes particulares' });
        recomendacoes.push('Intensificar campanha de captação de pacientes particulares.');
    }

    // 3. Projeção de meta
    if (!metas.projecao.bateMeta) {
        insights.push(`Sem aumento de agenda, a meta não será atingida (projeção: R$ ${metas.projecao.final.toLocaleString('pt-BR')}).`);
        recomendacoes.push(`Aumentar ${Math.ceil(metas.gap.porDia / 150)} atendimentos/dia para fechar o gap.`);
    }

    // 4. Produtividade por profissional
    const baixoDesempenho = profissionais.lista.filter(p => p.produtividade < 70);
    baixoDesempenho.forEach(p => {
        insights.push(`Profissional ${p.nome} está ${(100 - p.produtividade).toFixed(0)}% abaixo da média de produção.`);
        alertasV3.push({ tipo: 'produtividade_baixa', nivel: 'medio', profissional: p.nome, mensagem: 'Produtividade abaixo da média da equipe', acao: 'Revisar agenda e tempo de sessão' });
    });

    // 5. Top performer
    if (profissionais.ranking.length > 0) {
        const top = profissionais.ranking[0];
        insights.push(`${top.nome} está puxando ${(top.realizado / (data.caixa || 1) * 100).toFixed(0)}% do caixa total.`);
    }

    if (insights.length === 0) {
        insights.push('✅ Clínica em ritmo saudável. Continue monitorando.');
    }

    return { insights, recomendacoes, alertas: alertasV3 };
}

/**
 * 💼 Calcula RECEITA COMERCIAL NOVA do mês (meta comercial).
 *
 * Usa classificação EXISTENTE (Payment.kind, Session.paymentOrigin, billingType).
 * NÃO cria novos campos — apenas interpreta o que já existe.
 *
 * Composição:
 *   • package_receipt           → venda de pacote (nova captacao)
 *   • session_payment/appointment_payment + particular + origin ≠ auto_per_session/package_prepaid → avulso novo
 *   • convenio produzido        → autorizacao nova (producao, nao caixa)
 *
 * Exclui:
 *   • debt_settlement, monthly_settlement (divida antiga/acerto)
 *   • auto_per_session, package_prepaid (recorrente/pacote ja captado)
 *   • package_consumed, isFromPackage (nao e caixa)
 */
/**
 * NOVA RECEITA DO MÊS — 3 fontes independentes:
 *
 * 1. packageSales     → Payments kind='package_receipt' (venda de pacote no período)
 * 2. individual       → Payments particular pagos na sessão (não-pacote, não-liminar)
 * 3. convenioProduction → Sessions status='completed' com paymentMethod/Origin='convenio'
 *                         Usa session.date (não financialDate) — data de realização do serviço.
 *                         Valor: package.sessionValue → session.sessionValue (fallback).
 *
 * ⚠️  Esta função NÃO é usada diretamente para a meta mensal (calculateMetas usa caixa+aReceberProducao).
 *     É exibida no dashboard como breakdown informativo de "receita nova gerada no mês".
 */
async function calculateNovaReceita(start, end) {
    const [packageSalesAgg, individualAgg, convenioProductionAgg] = await Promise.all([
        Payment.aggregate([
            { $match: {
                status: 'paid',
                kind: 'package_receipt',
                $or: [
                    { financialDate: { $gte: start, $lte: end } },
                    { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
                    { financialDate: null, paymentDate: { $gte: start, $lte: end } }
                ]
            }},
            { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        Payment.aggregate([
            { $match: {
                status: 'paid',
                amount: { $gt: 0 },
                kind: { $in: ['session_payment', 'appointment_payment'] },
                billingType: 'particular',
                isFromPackage: { $ne: true },
                $or: [
                    { financialDate: { $gte: start, $lte: end } },
                    { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
                    { financialDate: null, paymentDate: { $gte: start, $lte: end } }
                ]
            }},
            { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        Session.aggregate([
            { $match: {
                date: { $gte: start, $lte: end },
                status: 'completed',
                $or: [
                    { paymentMethod: 'convenio' },
                    { paymentOrigin: 'convenio' },
                    { insuranceGuide: { $exists: true, $ne: null } }
                ]
            }},
            { $lookup: {
                from: 'packages',
                localField: 'package',
                foreignField: '_id',
                pipeline: [{ $project: { sessionValue: 1, totalValue: 1, totalSessions: 1 } }],
                as: '_pkg'
            }},
            { $addFields: {
                effectiveValue: {
                    $cond: {
                        if: { $and: [{ $gt: [{ $size: '$_pkg' }, 0] }, { $gt: [{ $arrayElemAt: ['$_pkg.sessionValue', 0] }, 0] }] },
                        then: { $arrayElemAt: ['$_pkg.sessionValue', 0] },
                        else: { $ifNull: ['$sessionValue', 0] }
                    }
                }
            }},
            { $group: { _id: null, total: { $sum: '$effectiveValue' }, count: { $sum: 1 } } }
        ])
    ]);

    const packageSales = packageSalesAgg[0]?.total || 0;
    const individual   = individualAgg[0]?.total   || 0;
    const convenioProd = convenioProductionAgg[0]?.total || 0;

    return {
        total: packageSales + individual + convenioProd,
        packageSales,
        individual,
        convenioProduction: convenioProd,
        count: (packageSalesAgg[0]?.count || 0) + (individualAgg[0]?.count || 0) + (convenioProductionAgg[0]?.count || 0)
    };
}

/**
 * 🔄 Calcula dados em tempo real — ALINHADO COM ARQUITETURA V2
 *
 * Caixa e Produção totais usam FinancialMetricsService (fonte única de verdade).
 * Breakdowns manuais são calculados sobre a MESMA base de dados do V2.
 */
/**
 * Contagem de appointments do mês para enriquecer os cards do dashboard.
 * Realizados = completed. Ativos = pre_agendado + scheduled + confirmed + completed.
 */
async function calculateAppointmentCounts(year, month) {
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').toDate();
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month').toDate();

    const [ativos, realizados] = await Promise.all([
        Appointment.countDocuments({
            date: { $gte: start, $lte: end },
            operationalStatus: { $in: ['pre_agendado', 'scheduled', 'confirmed', 'completed'] }
        }),
        Appointment.countDocuments({
            date: { $gte: start, $lte: end },
            operationalStatus: 'completed'
        })
    ]);

    return { ativos, realizados };
}

async function calculateRealTime(year, month) {
    const _t0 = Date.now();
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').utc().toDate();
    const now = moment.tz(TIMEZONE);
    const isCurrentMonth = year === now.year() && month === now.month() + 1;
    // Mês atual: cap em hoje para não incluir sessões futuras já completadas
    const end = isCurrentMonth
        ? now.endOf('day').utc().toDate()
        : moment.tz([year, month - 1], TIMEZONE).endOf('month').utc().toDate();
    const todayStart = moment.tz(TIMEZONE).startOf('day').utc().toDate();
    const todayEnd = moment.tz(TIMEZONE).endOf('day').utc().toDate();

    // ───────────────────────────────────────────────
    // 🎯 Fonte única de verdade V2 (unificada)
    // ───────────────────────────────────────────────
    const _tUnified = Date.now();

    const _tCash = Date.now();
    const cashPromise = unifiedFinancialService.calculateCashForDashboard(start, end).then(r => {
        console.log(`[realTime] calculateCashForDashboard(month) = ${Date.now() - _tCash}ms`);
        return r;
    });

    const _tProduction = Date.now();
    const productionPromise = unifiedFinancialService.calculateProductionForDashboard(start, end).then(r => {
        console.log(`[realTime] calculateProductionForDashboard(month) = ${Date.now() - _tProduction}ms`);
        return r;
    });

    const _tTodayCash = Date.now();
    const todayCashPromise = unifiedFinancialService.calculateCashForDashboard(todayStart, todayEnd).then(r => {
        console.log(`[realTime] calculateCashForDashboard(today) = ${Date.now() - _tTodayCash}ms`);
        return r;
    });

    const _tTodayProduction = Date.now();
    const todayProductionPromise = unifiedFinancialService.calculateProductionForDashboard(todayStart, todayEnd).then(r => {
        console.log(`[realTime] calculateProductionForDashboard(today) = ${Date.now() - _tTodayProduction}ms`);
        return r;
    });

    const _tCompetencia = Date.now();
    const competenciaPromise = unifiedFinancialService.calculateCashByCompetencia(start, end).then(r => {
        console.log(`[realTime] calculateCashByCompetencia = ${Date.now() - _tCompetencia}ms`);
        return r;
    });

    const _tPackageSales = Date.now();
    const packageSalesPromise = Payment.aggregate([
        { $match: {
            status: 'paid',
            kind: 'package_receipt',
            $or: [
                { financialDate: { $gte: start, $lte: end } },
                { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
                { financialDate: null, paymentDate: { $gte: start, $lte: end } }
            ]
        }},
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]).then(r => {
        console.log(`[realTime] packageSales.aggregate = ${Date.now() - _tPackageSales}ms`);
        return r;
    });

    const _tNovaReceita = Date.now();
    const novaReceitaPromise = calculateNovaReceita(start, end).then(r => {
        console.log(`[realTime] calculateNovaReceita = ${Date.now() - _tNovaReceita}ms`);
        return r;
    });

    const [cash, production, todayCash, todayProduction, competencia, packageSalesAgg, novaReceitaMes, backlogAgg] = await Promise.all([
        cashPromise,
        productionPromise,
        todayCashPromise,
        todayProductionPromise,
        competenciaPromise,
        packageSalesPromise,
        novaReceitaPromise,
        Package.aggregate([
            { $match: { status: { $in: ['active', 'confirmed'] } } },
            { $addFields: { sessionsRemaining: { $subtract: ['$totalSessions', { $ifNull: ['$sessionsDone', 0] }] } } },
            { $group: {
                _id: null,
                sessoes: { $sum: '$sessionsRemaining' },
                pacotes: { $sum: 1 },
                valorEstimado: { $sum: { $multiply: ['$sessionsRemaining', { $ifNull: ['$sessionValue', 0] }] } }
            }}
        ])
    ]);
    console.log(`[realTime] unifiedFinancialService parallel = ${Date.now() - _tUnified}ms (cash+production+today+competencia+packages+novaReceita+backlog)`);

    // 🛡️ Particular pendente do dia — fonte: sessions completed sem payment paid (exclui pré-pago)
    const _tParticularPendente = Date.now();
    const particularPendenteHojeAgg = await Session.aggregate([
        { $match: { date: { $gte: todayStart, $lte: todayEnd }, status: 'completed' } },
        { $lookup: { from: 'appointments', localField: 'appointmentId', foreignField: '_id', as: 'appt' } },
        { $unwind: '$appt' },
        { $match: {
            'appt.billingType': { $nin: ['convenio', 'liminar'] },
            'appt.operationalStatus': 'completed'
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
        { $group: { _id: null, total: { $sum: '$sessionValue' } } }
    ]);
    const particularPendenteHoje = particularPendenteHojeAgg[0]?.total || 0;
    console.log(`[realTime] particularPendenteHoje.aggregate = ${Date.now() - _tParticularPendente}ms`);

    const _tBuildBlocks = Date.now();
    const packageSalesTotal = packageSalesAgg[0]?.total || 0;
    const packageSalesCount = packageSalesAgg[0]?.count || 0;

    const convenioAReceber  = Math.max(0, (production.convenio || 0) - (cash.convenio || 0));
    const liminarAReceber   = Math.max(0, (production.liminar  || 0) - (cash.liminar  || 0));
    const particularPendente = production.particularPendente || 0;
    const pacotePendente     = production.pacotePendente     || 0;

    // ──────────────────────────────────────────────────────────────
    // 🏗️ ARQUITETURA SEMÂNTICA V3 — 3 camadas explícitas
    //
    // 1. FINANCEIRO (dinheiro que entrou): payments.status === 'paid'
    // 2. OPERAÇÃO   (trabalho realizado):  sessions.status === 'completed'
    // 3. PIPELINE   (dinheiro a entrar):   payments.status === 'pending'/'billed'
    //
    // Esses conceitos acontecem em momentos diferentes e NÃO devem ser confundidos.
    // Ex: pacote prepaid entra no caixa na VENDA, mas na produção no CONSUMO.
    // ──────────────────────────────────────────────────────────────

    const aReceberProducao   = convenioAReceber + particularPendente + pacotePendente + liminarAReceber;
    const recebidoProducao   = Math.max(0, (production.total || 0) - aReceberProducao);
    // dinheiro recebido em caixa que NÃO corresponde à produção do mês
    // (em junho/2026 auditado: 100% vendas de pacotes antecipadas — zero sessões de meses anteriores)
    const recebimentosAntecipados = Math.max(0, cash.total - recebidoProducao);

    // 🆕 RECEITA PROJETADA = caixa realizado + a receber
    // Representa "quanto a clínica vai ter se todo mundo pagar"
    const receitaProjetada = cash.total + aReceberProducao;

    const caixaBlock = buildCaixaBlock({
        total: cash.total,
        particular: cash.particular,
        pacote: cash.pacote,
        convenio: cash.convenio,
        liminar: cash.liminar,
        byMethod: cash.byMethod,
    });

    const producaoBlock = buildProducaoBlock({
        totalProduzido: production.total,
        producaoLiquidada: production.recebido,
        pendente: production.pendente,
        convenio: production.convenio,
        particular: production.particular,
        pacote: production.pacote,
        liminar: production.liminar,
    });
    console.log(`[realTime] buildBlocks = ${Date.now() - _tBuildBlocks}ms`);

    // 🆕 Cálculo de dias decorridos para contexto da meta
    const diasDecorridos = Math.max(1, now.date());
    const diasUteis = META_CONFIG.diasUteis;

    console.log(`[realTime] TOTAL = ${Date.now() - _t0}ms`);

    return {
        // ─── LEGADO (mantido para compatibilidade com frontend antigo) ───
        caixa: caixaBlock.total,
        receitaReal: cash.receitaReal,
        receitaDiferida: cash.receitaDiferida,
        caixaHoje: todayCash.total,
        producaoHoje: todayProduction.total || 0,
        convenioHoje: todayProduction.convenio || 0,
        particularPendenteHoje: particularPendenteHoje,
        caixaDetalhe: {
            ...caixaBlock,
            packageSales: packageSalesTotal,
            packageSalesCount: packageSalesCount,
            particularNet: Math.max(0, cash.particular - packageSalesTotal)
        },
        caixaByMethod: cash.byMethod,
        producao: producaoBlock.totalProduzido,
        producaoDetalhe: {
            ...producaoBlock,
            particularPendente,
            pacotePendente
        },
        resultadoEconomico: production.total,
        resultadoCaixa: cash.total,
        convenioAReceber,
        particularPendente,
        pacotePendente,
        saldo: cash.total,
        recebimentoProducao: {
            total: recebidoProducao,
            particular: Math.max(0, (production.particular || 0) - particularPendente),
            pacote:     Math.max(0, (production.pacote     || 0) - pacotePendente),
            convenio:   Math.max(0, (production.convenio   || 0) - convenioAReceber),
            liminar:    Math.max(0, (production.liminar    || 0) - liminarAReceber),
        },
        recebimentosAntecipados,
        aReceberProducao,
        receitaReconhecida: production.total,  // INV-3: regime de competência = Session.completed
        novaReceitaMes,
        backlogContratado: {
            sessoes: backlogAgg[0]?.sessoes || 0,
            pacotes: backlogAgg[0]?.pacotes || 0,
            valorEstimado: backlogAgg[0]?.valorEstimado || 0
        },

        // ─── 🆕 NOVA ARQUITETURA SEMÂNTICA V3 ───
        visaoSemantica: {
            financeiro: {
                label: 'Caixa Realizado',
                descricao: 'Dinheiro que REALMENTE entrou no caixa/banco',
                total: cash.total,
                hoje: todayCash.total,
                particular: cash.particular,
                pacote: cash.pacote,
                convenio: cash.convenio,
                liminar: cash.liminar,
                porMetodo: cash.byMethod,
            },
            operacao: {
                label: 'Produção Realizada',
                descricao: 'Trabalho que a clínica REALMENTE executou',
                total: production.total,
                hoje: todayProduction.total || 0,
                particular: production.particular,
                pacote: production.pacote,
                convenio: production.convenio,
                liminar: production.liminar,
                quantidadeAtendimentos: production.count,
                ticketMedio: production.count > 0 ? production.total / production.count : 0,
            },
            pipeline: {
                label: 'A Receber',
                descricao: 'Dinheiro já "ganho" mas ainda não recebido',
                total: aReceberProducao,
                convenio: convenioAReceber,
                particular: particularPendente,
                pacote: pacotePendente,
                liminar: liminarAReceber,
            },
            projecao: {
                label: 'Receita Projetada',
                descricao: 'Quanto a clínica vai ter se todo mundo pagar (caixa + a receber)',
                total: receitaProjetada,
            },
            contextoTemporal: {
                diasDecorridos,
                diasUteis,
                percentualMes: Math.round((diasDecorridos / diasUteis) * 100),
            }
        },

        // ─── METAS SEPARADAS ───
        metas: {
            tipoPrincipal: 'producao',  // 🆕 Meta principal = PRODUÇÃO (não caixa)
            producao: {
                meta: null,  // preenchido pelo calculateMetas
                atingido: production.total,
                percentual: 0,
            },
            caixa: {
                meta: null,  // preenchido pelo calculateMetas
                atingido: cash.total,
                percentual: 0,
            },
            receitaProjetada: {
                meta: null,
                atingido: receitaProjetada,
                percentual: 0,
            }
        },
    };
}

async function calculateAReceber(year, month) {
    const startStr = moment.tz([year, month - 1], TIMEZONE).startOf('month').format('YYYY-MM-DD');
    const endStr = moment.tz([year, month - 1], TIMEZONE).endOf('month').format('YYYY-MM-DD');

    // INV-4: A Receber = Session.completed → Payment.pending (evento de domínio)
    // Ancora em serviceDate/paymentDate; createdAt removido — inflava R$14.480 de phantoms
    const payments = await Payment.find({
        status: 'pending',
        $and: [
            {
                $or: [
                    { billingType: 'convenio' },
                    { paymentMethod: 'convenio' },
                    { 'insurance.status': { $in: ['pending_billing', 'billed', 'partial'] } }
                ]
            },
            {
                $or: [
                    { paymentDate: { $gte: startStr, $lte: endStr } },
                    { serviceDate: { $gte: startStr, $lte: endStr } }
                ]
            }
        ]
    }).populate('appointment', 'operationalStatus').lean();

    // INV-4: inclui apenas pagamentos de sessões já realizadas
    const realizados = payments.filter(p =>
        !p.appointment || p.appointment?.operationalStatus === 'completed'
    );

    const total = realizados.reduce((sum, p) => sum + (p.amount || 0), 0);
    return { total: parseFloat(total.toFixed(2)), mesAtual: parseFloat(total.toFixed(2)), historico: 0 };
}

async function calculateDespesas(year, month) {
    const startStr = moment.tz([year, month - 1], TIMEZONE).startOf('month').format('YYYY-MM-DD');
    const endStr = moment.tz([year, month - 1], TIMEZONE).endOf('month').format('YYYY-MM-DD');
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').toDate();
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month').toDate();

    const expenses = await Expense.find({
        date: { $gte: startStr, $lte: endStr },
        status: { $nin: ['canceled', 'cancelado'] }
    }).lean();

    const expenseTotal = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);

    // 💰 Calcular comissões de todos os profissionais ativos no mês
    const doctors = await Doctor.find({ active: { $ne: false } }).select('_id fullName commissionRules.rules').lean();
    const commissionResults = await Promise.all(
        doctors.map(async (d) => {
            const hasRules = (d.commissionRules?.rules?.length ?? 0) > 0;
            if (!hasRules) {
                return { doctorId: d._id.toString(), doctorName: d.fullName, total: 0, sessions: 0, productionBase: 0, commissionRate: 0, lastUpdated: new Date().toISOString(), noRule: true };
            }
            try {
                const comm = await calculateDoctorCommission(d._id, start, end);
                return {
                    doctorId: d._id.toString(),
                    doctorName: d.fullName,
                    total: comm.totalCommission,
                    sessions: comm.totalSessions,
                    productionBase: comm.productionBase ?? 0,
                    commissionRate: comm.commissionRate ?? 0,
                    lastUpdated: comm.lastUpdated ?? new Date().toISOString(),
                    noRule: false
                };
            } catch (err) {
                return { doctorId: d._id.toString(), doctorName: d.fullName, total: 0, sessions: 0, productionBase: 0, commissionRate: 0, lastUpdated: new Date().toISOString(), noRule: false };
            }
        })
    );

    const commissionTotal = commissionResults.reduce((sum, c) => sum + c.total, 0);
    const semRegra = commissionResults.filter(c => c.noRule).length;

    return {
        total: parseFloat((expenseTotal + commissionTotal).toFixed(2)),
        count: expenses.length,
        breakdown: {
            expenses: parseFloat(expenseTotal.toFixed(2)),
            comissoes: parseFloat(commissionTotal.toFixed(2)),
            detalheComissoes: commissionResults,
            semRegra
        }
    };
}

/**
 * 📊 Comparativos: mês atual vs mês anterior
 *
 * Regra arquitetural: usa snapshot quando disponível; fallback para runtime.
 */
async function calculateComparativos(year, month, preComputed = {}) {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    const calcVariacao = (atual, anterior) => {
        if (!anterior || anterior === 0) return atual > 0 ? 100 : 0;
        return parseFloat((((atual - anterior) / anterior) * 100).toFixed(1));
    };

    // Mês anterior — checks em paralelo, depois fetches em paralelo
    const [prevSnapReady, prevExpReady] = await Promise.all([
        financialSnapshotService.isMonthlySnapshotReady(prevYear, prevMonth),
        financialExpenseSnapshotService.isMonthlySnapshotReady(prevYear, prevMonth),
    ]);
    const [prevFinancial, prevExpData] = await Promise.all([
        prevSnapReady
            ? financialSnapshotService.getMonthlyAggregate(prevYear, prevMonth)
            : calculateRealTime(prevYear, prevMonth),
        prevExpReady
            ? financialExpenseSnapshotService.getMonthlyAggregate(prevYear, prevMonth)
            : calculateDespesas(prevYear, prevMonth),
    ]);
    const prevCaixa = prevFinancial.caixa;
    const prevProducao = prevFinancial.producao;
    const prevDespesas = prevExpData.total;

    // Mês atual — usa preComputed do Phase 1 quando disponível (evita recompute)
    let currentCaixa = 0, currentProducao = 0, currentDespesas = 0;
    const nowMoment = moment.tz(TIMEZONE);
    const isCurrentMonth = year === nowMoment.year() && month === nowMoment.month() + 1;

    if (isCurrentMonth && preComputed.currentRealTime) {
        currentCaixa = preComputed.currentRealTime.caixa;
        currentProducao = preComputed.currentRealTime.producao;
        currentDespesas = preComputed.currentDespesas?.total || 0;
    } else if (!isCurrentMonth) {
        // Mês passado — checks em paralelo, depois fetches em paralelo
        const [currentSnapReady, currentExpReady] = await Promise.all([
            financialSnapshotService.isMonthlySnapshotReady(year, month),
            financialExpenseSnapshotService.isMonthlySnapshotReady(year, month),
        ]);
        const [currFinancial, currExpData] = await Promise.all([
            currentSnapReady
                ? financialSnapshotService.getMonthlyAggregate(year, month)
                : calculateRealTime(year, month),
            currentExpReady
                ? financialExpenseSnapshotService.getMonthlyAggregate(year, month)
                : calculateDespesas(year, month),
        ]);
        currentCaixa = currFinancial.caixa;
        currentProducao = currFinancial.producao;
        currentDespesas = currExpData.total;
    } else {
        // Fallback: isCurrentMonth sem preComputed
        const [currRt, currDp] = await Promise.all([
            calculateRealTime(year, month),
            calculateDespesas(year, month),
        ]);
        currentCaixa = currRt.caixa;
        currentProducao = currRt.producao;
        currentDespesas = currDp.total;
    }

    return {
        mesAnterior: {
            caixa: parseFloat(prevCaixa.toFixed(2)),
            producao: parseFloat(prevProducao.toFixed(2)),
            despesas: parseFloat(prevDespesas.toFixed(2))
        },
        mesAtual: {
            caixa: parseFloat(currentCaixa.toFixed(2)),
            producao: parseFloat(currentProducao.toFixed(2)),
            despesas: parseFloat(currentDespesas.toFixed(2))
        },
        variacao: {
            caixa: calcVariacao(currentCaixa, prevCaixa),
            producao: calcVariacao(currentProducao, prevProducao),
            despesas: calcVariacao(currentDespesas, prevDespesas)
        }
    };
}

/**
 * ⚠️ Painel de risco operacional
 */
function calculateRiscoOperacional(data, metas, profissionais) {
    const motivos = [];
    let nivel = 'baixo';

    const totalProducao = data.producao || 1;
    const pctConvenio = ((data.producaoDetalhe.convenio || 0) / totalProducao) * 100;
    const pctParticular = ((data.producaoDetalhe.particular || 0) / totalProducao) * 100;

    if (pctConvenio > 60) {
        motivos.push('Dependência de convênios acima de 60%');
        nivel = 'alto';
    }
    if (pctParticular < 20) {
        motivos.push('Baixa conversão de particular');
        if (nivel === 'baixo') nivel = 'medio';
    }
    if (metas.ritmo.diferenca < 0 && Math.abs(metas.ritmo.diferenca) > metas.configuracao.metaDiariaNecessaria * 3) {
        motivos.push('Gap diário elevado — ritmo muito abaixo do esperado');
        nivel = 'alto';
    } else if (metas.ritmo.diferenca < 0) {
        motivos.push('Ritmo de caixa abaixo do esperado para a meta');
        if (nivel === 'baixo') nivel = 'medio';
    }
    if (!metas.projecao.bateMeta) {
        motivos.push('Projeção indica que a meta mensal não será atingida');
        if (nivel === 'baixo') nivel = 'medio';
    }
    const baixoDesempenho = (profissionais.lista || []).filter(p => p.produtividade < 70);
    if (baixoDesempenho.length > 0) {
        motivos.push(`${baixoDesempenho.length} profissional(is) abaixo da média de produção`);
        if (nivel === 'baixo') nivel = 'medio';
    }

    if (motivos.length === 0) {
        motivos.push('Nenhum risco crítico identificado');
    }

    return {
        nivel,
        motivos,
        impacto: nivel === 'alto' ? 'Não bater meta mensal' : (nivel === 'medio' ? 'Atraso ou redução de margem' : 'Estável')
    };
}

/**
 * 🎯 Ações executivas acionáveis
 */
function calculateAcoesExecutivas(data, metas, profissionais, riscoOperacional) {
    const acoes = [];
    const totalProducao = data.producao || 1;
    const pctConvenio = ((data.producaoDetalhe.convenio || 0) / totalProducao) * 100;
    const pctParticular = ((data.producaoDetalhe.particular || 0) / totalProducao) * 100;
    const metaDiaria = metas.configuracao.metaDiariaNecessaria || 1;
    const gapPorDia = metas.gap.porDia || 0;

    // Ação 1: aumentar particular
    if (pctParticular < 30 || metas.porTipo.particular.realizado < metas.porTipo.particular.meta * 0.6) {
        const slots = Math.max(2, Math.ceil(gapPorDia / 200));
        acoes.push({
            tipo: 'aumentar_particular',
            prioridade: 'alta',
            impactoEstimado: parseFloat((slots * 200).toFixed(2)),
            descricao: `Adicionar +${slots} atendimento(s) particular(es)/dia`,
            motivo: 'Particular está abaixo do ritmo ideal ou da meta definida',
            acaoSugerida: 'Abrir slots particulares na agenda e intensificar captação'
        });
    }

    // Ação 2: reduzir dependência convênio
    if (pctConvenio > 60) {
        acoes.push({
            tipo: 'reduzir_dependencia_convenio',
            prioridade: pctConvenio > 75 ? 'alta' : 'media',
            impactoRisco: 'alto',
            descricao: `Convênios representam ${pctConvenio.toFixed(0)}% da produção`,
            motivo: 'Alta dependência de convênio reduz margem e previsibilidade de caixa',
            acaoSugerida: 'Incentivar conversão para particular e renegociar tabela convênio'
        });
    }

    // Ação 3: fechar gap de meta
    if (!metas.projecao.bateMeta && gapPorDia > 0) {
        const atendimentosNecessarios = Math.ceil(gapPorDia / 150);
        acoes.push({
            tipo: 'aumentar_agenda',
            prioridade: gapPorDia > metaDiaria * 1.5 ? 'alta' : 'media',
            impactoEstimado: parseFloat(gapPorDia.toFixed(2)),
            descricao: `Aumentar ${atendimentosNecessarios} atendimento(s)/dia para bater meta`,
            motivo: `Projeção de fechamento (R$ ${metas.projecao.final.toLocaleString('pt-BR')}) abaixo da meta mensal`,
            acaoSugerida: 'Abrir horários extras, reativar pacientes inativos ou campanha de retorno'
        });
    }

    // Ação 4: focar em profissionais com baixa produtividade
    const baixoDesempenho = (profissionais.lista || []).filter(p => p.produtividade < 70);
    baixoDesempenho.forEach(p => {
        acoes.push({
            tipo: 'focar_profissional_baixo',
            prioridade: 'media',
            profissional: p.nome,
            impactoEstimado: parseFloat(((p.producao * 0.3) - p.producao).toFixed(2)), // se chegar na média
            descricao: `${p.nome} está ${(100 - p.produtividade).toFixed(0)}% abaixo da média da equipe`,
            motivo: 'Desempenho individual impacta a capacidade total da clínica',
            acaoSugerida: 'Revisar agenda, tempo de sessão e taxa de ocupação do profissional'
        });
    });

    // Ação 5: manter ritmo (se tudo ok)
    if (acoes.length === 0) {
        acoes.push({
            tipo: 'manter_ritmo',
            prioridade: 'baixa',
            descricao: 'Clínica está em ritmo saudável para a meta mensal',
            motivo: 'Indicadores dentro da faixa esperada',
            acaoSugerida: 'Continuar monitorando e manter as boas práticas atuais'
        });
    }

    return acoes.sort((a, b) => {
        const map = { alta: 3, media: 2, baixa: 1 };
        return (map[b.prioridade] || 0) - (map[a.prioridade] || 0);
    });
}

/**
 * 🔍 Drill-down enriquecido por profissional
 */
function buildDrillDown(data, profissionais) {
    const caixaTotal = data.caixa || 1;
    const producaoTotal = data.producao || 1;

    const profissionaisDetalhe = (profissionais.lista || []).map(p => {
        const particularPct = p.producao > 0 ? (p.particular / p.producao) * 100 : 0;
        const convenioPct = p.producao > 0 ? (p.convenio / p.producao) * 100 : 0;
        return {
            id: p.id,
            nome: p.nome,
            especialidade: p.especialidade,
            resumo: {
                receita: p.realizado,
                producao: p.producao,
                atendimentos: p.quantidade,
                ticketMedio: p.ticketMedio,
                eficiencia: p.eficiencia,
                produtividade: p.produtividade
            },
            mix: {
                particular: parseFloat(particularPct.toFixed(1)),
                convenio: parseFloat(convenioPct.toFixed(1)),
                pacote: p.producao > 0 ? parseFloat(((p.pacote / p.producao) * 100).toFixed(1)) : 0,
                liminar: p.producao > 0 ? parseFloat(((p.liminar / p.producao) * 100).toFixed(1)) : 0
            },
            contribuicao: {
                caixaPct: caixaTotal > 0 ? parseFloat(((p.realizado / caixaTotal) * 100).toFixed(1)) : 0,
                producaoPct: producaoTotal > 0 ? parseFloat(((p.producao / producaoTotal) * 100).toFixed(1)) : 0
            },
            comissao: p.comissao || { total: 0, sessoes: 0, breakdown: null },
            diagnostico: {
                status: p.produtividade >= 100 ? 'top' : (p.produtividade >= 70 ? 'regular' : 'atencao'),
                acaoSugerida: p.produtividade >= 100
                    ? 'Manter ritmo e usar como referência para a equipe'
                    : (p.produtividade >= 70
                        ? 'Pequenos ajustes na agenda podem elevar a produção'
                        : 'Revisar ocupação, mix de convênio e tempo de sessão')
            }
        };
    });

    return {
        profissionais: profissionaisDetalhe,
        resumoGeral: {
            totalProfissionais: profissionais.totalProfissionais || 0,
            mediaProducao: profissionais.mediaProducao || 0,
            emAtencao: profissionaisDetalhe.filter(p => p.diagnostico.status === 'atencao').length,
            topPerformers: profissionaisDetalhe.filter(p => p.diagnostico.status === 'top').length
        }
    };
}

/**
 * 💰 Indicadores financeiros: Lucro, Margem e Ponto de Equilíbrio
 */
function calculateIndicadores(caixa, producao, despesasTotal, metas) {
    const lucro = parseFloat(((caixa || 0) - (despesasTotal || 0)).toFixed(2));
    const margemPercentual = caixa > 0 ? parseFloat(((lucro / caixa) * 100).toFixed(1)) : 0;
    const pontoEquilibrio = lucro >= 0 ? 0 : parseFloat((Math.abs(lucro)).toFixed(2));

    let statusLucro = lucro >= 0 ? 'positivo' : 'negativo';
    let statusMargem = 'ruim';
    if (margemPercentual >= 30) statusMargem = 'bom';
    else if (margemPercentual >= 15) statusMargem = 'atencao';

    // Ponto de equilíbrio em relação à meta mensal (% do que falta para cobrir despesas vs meta)
    const pontoEquilibrioVsMeta = metas?.configuracao?.metaMensal > 0
        ? parseFloat(((pontoEquilibrio / metas.configuracao.metaMensal) * 100).toFixed(1))
        : 0;

    return {
        lucro,
        margemPercentual,
        pontoEquilibrio,
        pontoEquilibrioVsMeta,
        statusLucro,
        statusMargem
    };
}

async function calculatePendentes(year, month) {
    const startStr = moment.tz([year, month - 1], TIMEZONE).startOf('month').format('YYYY-MM-DD');
    const endStr = moment.tz([year, month - 1], TIMEZONE).endOf('month').format('YYYY-MM-DD');

    const now = moment().tz(TIMEZONE);
    const isCurrentMonth = now.year() === year && now.month() + 1 === month;
    const cacheKey = `pendentes_${year}_${month}`;
    const cacheTTL = isCurrentMonth ? PENDENTES_CURRENT_TTL : PENDENTES_PAST_TTL;
    const cached = getPendentesCached(cacheKey, cacheTTL);
    if (cached) return cached;

    const _t0 = Date.now();

    // Única query: busca todos os pending com populates necessários para processamento
    // allPendingTotal e allParticularTotal são calculados do mesmo dataset
    const paymentsAll = await Payment.find({ status: 'pending' })
        .populate('patient', 'fullName')
        .populate('doctor', 'fullName specialty')
        .populate('appointment', 'date time operationalStatus')
        .lean();
    console.log(`[pendentes] paymentsAll.find+populate = ${Date.now() - _t0}ms (${paymentsAll.length} docs)`);

    const allPendingTotal = paymentsAll.reduce((s, p) => s + (p.amount || 0), 0);

    let convenioTotal = 0;
    let particularTotal = 0;
    const convenioItems = [];
    const particularItems = [];
    const skippedAudit = [];

    for (const p of paymentsAll) {
        // insurance.status é inicializado como template em todo Payment — não indica convênio
        const isConvenio = p.billingType === 'convenio' || p.paymentMethod === 'convenio';
        const valor = p.amount || 0;

        // Determina a data relevante para filtro de mês
        // appointment.date é ISODate (Date object), paymentDate/serviceDate são strings
        let dataRef = null;
        if (p.appointment?.date) {
            dataRef = moment(p.appointment.date).format('YYYY-MM-DD');
        } else if (p.paymentDate) {
            dataRef = moment(p.paymentDate).format('YYYY-MM-DD');
        } else if (p.serviceDate) {
            dataRef = moment(p.serviceDate).format('YYYY-MM-DD');
        }
        
        // Se não tem data de referência, inclui mesmo assim (payment órfão)
        const dentroDoMes = !dataRef || (dataRef >= startStr && dataRef <= endStr);

        if (!dentroDoMes) {
            skippedAudit.push({
                _id: p._id.toString(),
                amount: valor,
                dataRef,
                patient: p.patient?.fullName,
                reason: 'FORA_DO_MES'
            });
            continue;
        }

        // INV-4: pendentes apenas de sessões já realizadas
        if (p.appointment && p.appointment?.operationalStatus !== 'completed') {
            skippedAudit.push({
                _id: p._id.toString(),
                amount: valor,
                dataRef,
                patient: p.patient?.fullName,
                reason: 'APPOINTMENT_NOT_COMPLETED'
            });
            continue;
        }

        const item = {
            sessionId: p._id,
            data: dataRef || moment(p.createdAt).format('YYYY-MM-DD'),
            hora: p.appointment?.time || '',
            paciente: p.patient?.fullName || 'Paciente',
            valor: parseFloat((valor || 0).toFixed(2)),
            status: p.status
        };

        if (isConvenio) {
            item.convenio = p.insurance?.provider || p.insurance?.insuranceCompany || 'Convênio';
            convenioTotal += valor;
            convenioItems.push(item);
        } else {
            item.paymentMethod = p.paymentMethod || 'particular';
            particularTotal += valor;
            particularItems.push(item);
        }
    }

    const total = convenioTotal + particularTotal;

    // ── 🆕 DÉBITOS VENCIDOS: apenas data <= hoje (sessões que já deveriam ter sido pagas) ──
    const hoje = moment().tz(TIMEZONE).format('YYYY-MM-DD');
    const convenioVencidos = convenioItems.filter(i => i.data && i.data <= hoje);
    const particularVencidos = particularItems.filter(i => i.data && i.data <= hoje);
    const vencidosTotal = [...particularVencidos, ...convenioVencidos].reduce((s, i) => s + i.valor, 0);

    // ── 🆕 V2 FINANCIAL ENGINE: agrupamento por paciente + especialidade correta ──
    // Monta resultado do engine manualmente a partir dos payments já filtrados
    // FIX: converter para Set de strings para comparação correta (ObjectId !== string)
    const monthPaymentIds = new Set([...convenioItems, ...particularItems].map(i => i.sessionId?.toString()));
    const enginePayments = paymentsAll.filter(p => monthPaymentIds.has(p._id.toString()));

    const byPatient = {};
    const byDoctor = {};
    const bySpecialty = {};
    const byBillingType = { particular: { total: 0, count: 0, items: [] }, convenio: { total: 0, count: 0, items: [] } };

    // Valores que são billing types, não especialidades clínicas
    const billingTypeValues = new Set(['convenio', 'convênio', 'liminar', 'particular', 'insurance', 'package_session', 'session', 'avulso']);

    for (const p of enginePayments) {
        const valor = p.amount || 0;
        const isConvenio = p.billingType === 'convenio' || p.paymentMethod === 'convenio';
        const btype = isConvenio ? 'convenio' : 'particular';
        
        // byPatient — apenas particular (convênio não é dívida do paciente)
        const pid = p.patient?._id?.toString() || p.patientId;
        if (pid && !isConvenio) {
            if (!byPatient[pid]) {
                byPatient[pid] = {
                    patient: p.patient || { fullName: 'Desconhecido', _id: pid },
                    patientId: pid,
                    total: 0,
                    count: 0,
                    items: []
                };
            }
            byPatient[pid].total += valor;
            byPatient[pid].count += 1;
            byPatient[pid].items.push({
                _id: p._id,
                amount: valor,
                status: p.status,
                paymentMethod: p.paymentMethod,
                billingType: p.billingType,
                paymentDate: p.paymentDate,
                serviceDate: p.serviceDate,
                data: p.appointment?.date || p.paymentDate,
                hora: p.appointment?.time || '',
                specialty: (() => { const s = p.doctor?.specialty || p.serviceType || p.sessionType; return (s && !billingTypeValues.has(String(s).toLowerCase())) ? s : 'N/A'; })(),
                doctor: p.doctor || null,
                appointment: p.appointment || null,
                notes: p.notes
            });
        }

        // byDoctor
        const did = p.doctor?._id?.toString();
        if (did) {
            if (!byDoctor[did]) {
                byDoctor[did] = {
                    doctor: p.doctor,
                    doctorId: did,
                    total: 0,
                    count: 0,
                    items: []
                };
            }
            byDoctor[did].total += valor;
            byDoctor[did].count += 1;
            byDoctor[did].items.push({ _id: p._id, amount: valor, data: p.appointment?.date || p.paymentDate });
        }

        // bySpecialty
        const spec = p.doctor?.specialty || p.serviceType || p.sessionType || 'N/A';
        if (!bySpecialty[spec]) bySpecialty[spec] = { total: 0, count: 0, items: [] };
        bySpecialty[spec].total += valor;
        bySpecialty[spec].count += 1;
        bySpecialty[spec].items.push({ _id: p._id, amount: valor, data: p.appointment?.date || p.paymentDate });

        // byBillingType
        byBillingType[btype].total += valor;
        byBillingType[btype].count += 1;
        byBillingType[btype].items.push({ _id: p._id, amount: valor, data: p.appointment?.date || p.paymentDate });
    }

    // Total de débitos de particular/pacote independente do mês (inclui dívidas antigas)
    const allParticularTotal = paymentsAll
        .filter(p => p.billingType !== 'convenio' && p.paymentMethod !== 'convenio')
        .reduce((s, p) => s + (p.amount || 0), 0);

    console.log(`[pendentes] TOTAL = ${Date.now() - _t0}ms`);

    const result = {
        total: parseFloat(total.toFixed(2)),
        allPendingTotal: parseFloat(allPendingTotal.toFixed(2)),
        allParticularTotal: parseFloat(allParticularTotal.toFixed(2)),
        convenio: {
            total: parseFloat(convenioTotal.toFixed(2)),
            count: convenioItems.length,
            items: convenioItems
        },
        particular: {
            total: parseFloat(particularTotal.toFixed(2)),
            count: particularItems.length,
            items: particularItems
        },
        // 🆕 DÉBITOS VENCIDOS: apenas sessões com data <= hoje
        vencidos: {
            total: parseFloat(vencidosTotal.toFixed(2)),
            convenio: {
                total: parseFloat(convenioVencidos.reduce((s, i) => s + i.valor, 0).toFixed(2)),
                count: convenioVencidos.length,
                items: convenioVencidos
            },
            particular: {
                total: parseFloat(particularVencidos.reduce((s, i) => s + i.valor, 0).toFixed(2)),
                count: particularVencidos.length,
                items: particularVencidos
            }
        },
        // ── COMPAT V2: estrutura nova para frontend moderno ──
        v2_financial: {
            total,
            count: enginePayments.length,
            byPatient,
            byDoctor,
            bySpecialty,
            byBillingType
        }
    };
    setPendentesCached(cacheKey, result);
    return result;
}

// GET /v2/financial/dashboard/sanity-check
// Retorna o resultado do sanity check financeiro para o mês solicitado
router.get('/sanity-check', auth, async (req, res) => {
    try {
        const { month, year } = req.query;
        const targetYear = year ? parseInt(year) : moment().year();
        const targetMonth = month ? parseInt(month) : moment().month() + 1;

        const start = moment.tz([targetYear, targetMonth - 1, 1], TIMEZONE).startOf('day').utc().toDate();
        const end = moment.tz([targetYear, targetMonth - 1, 1], TIMEZONE).endOf('month').endOf('day').utc().toDate();

        const [cash, production, cashByDay, productionByDay] = await Promise.all([
            unifiedFinancialService.calculateCash(start, end),
            unifiedFinancialService.calculateProduction(start, end),
            unifiedFinancialService.calculateCashByDay(start, end),
            unifiedFinancialService.calculateProductionByDay(start, end)
        ]);

        const cashSumByDay = Array.from(cashByDay.values()).reduce((s, d) => s + d.caixa, 0);
        const prodSumByDay = Array.from(productionByDay.map.values()).reduce((s, d) => s + d.producao, 0);

        const checks = [
            { name: 'Caixa total == soma diária', pass: Math.abs(cash.total - cashSumByDay) < 0.01 },
            { name: 'Produção total == soma diária', pass: Math.abs(production.total - prodSumByDay) < 0.01 },
            { name: 'Caixa >= 0', pass: cash.total >= 0 },
            { name: 'Produção >= 0', pass: production.total >= 0 },
            { name: 'Recebido + Pendente == Produção', pass: Math.abs(production.recebido + production.pendente - production.total) < 0.01 },
            { name: 'Caixa particular + pacote + convenio + liminar == total', pass: Math.abs(cash.particular + cash.pacote + cash.convenio + cash.liminar - cash.total) < 0.01 },
            { name: 'Contagens coerentes', pass: production.total === 0 || production.count > 0 },
        ];

        const allPass = checks.every(c => c.pass);

        res.json({
            success: true,
            status: allPass ? 'healthy' : 'failed',
            period: { year: targetYear, month: targetMonth },
            summary: {
                caixa: cash.total,
                producao: production.total,
                recebido: production.recebido,
                pendente: production.pendente,
                transacoes: cash.count,
                sessoes: production.count
            },
            checks,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /v2/financial/dashboard/rebuild-snapshot
 * Reconstrói o FinancialDailySnapshot para um range de datas.
 * Usa unifiedFinancialService como fonte determinística da verdade.
 */
import { rebuildSnapshotRange } from '../workers/financialSnapshotWorker.v2.js';

router.post('/rebuild-snapshot', auth, async (req, res) => {
    try {
        const { startDate, endDate } = req.body;

        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                message: 'startDate e endDate são obrigatórios (YYYY-MM-DD)'
            });
        }

        console.log(`[DashboardV3] 🔄 Rebuild solicitado: ${startDate} → ${endDate} por ${req.user?.name || req.user?.email}`);

        const results = await rebuildSnapshotRange(startDate, endDate);

        const ok = results.filter(r => r.status === 'ok');
        const errors = results.filter(r => r.status === 'error');

        res.json({
            success: true,
            message: `Rebuild concluído: ${ok.length} dias OK, ${errors.length} erros`,
            range: { startDate, endDate },
            results,
            errors: errors.length > 0 ? errors : undefined,
            executedBy: req.user?.name || req.user?.email
        });
    } catch (err) {
        console.error('[DashboardV3] ❌ Erro no rebuild:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /v2/financial/dashboard/validate-snapshot
 * 🔍 SHADOW VALIDATION: compara snapshot vs realtime
 * Não altera dados — apenas lê e reporta divergências.
 */
import { validateSnapshotVsRealtime, validateSnapshotRange } from '../workers/financialSnapshotWorker.v2.js';

router.post('/validate-snapshot', auth, async (req, res) => {
    try {
        const { startDate, endDate, date } = req.body;

        if (date) {
            // Validação de um dia específico
            const result = await validateSnapshotVsRealtime(date);
            return res.json({
                success: true,
                mode: 'shadow_validation',
                date,
                ...result,
                action: result.hasDivergence
                    ? 'Divergência detectada — considere rebuild-snapshot para este dia'
                    : 'Snapshot alinhado com realtime'
            });
        }

        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                message: 'Informe date (YYYY-MM-DD) ou startDate+endDate'
            });
        }

        const result = await validateSnapshotRange(startDate, endDate);

        res.json({
            success: true,
            mode: 'shadow_validation',
            ...result,
            healthy: result.divergenceCount === 0,
            action: result.divergenceCount > 0
                ? `${result.divergenceCount} dias com divergência — considere rebuild`
                : 'Todos os snapshots alinhados com realtime'
        });
    } catch (err) {
        console.error('[DashboardV3] ❌ Erro na validação:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /v2/financial/dashboard/debitos
// Fonte única de débitos pendentes — substitui /api/financial/dashboard/debitos
// Query opcional: ?month=&year= (filtro por mês)
router.get('/debitos', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { default: Payment } = await import('../models/Payment.js');
        const { month, year } = req.query;

        const query = { status: 'pending', billingType: { $nin: ['convenio', 'liminar'] } };
        if (month && year) {
            const start = moment.tz([parseInt(year), parseInt(month) - 1, 1], TIMEZONE).startOf('day').toDate();
            const end = moment.tz([parseInt(year), parseInt(month) - 1, 1], TIMEZONE).endOf('month').endOf('day').toDate();
            query.paymentDate = { $gte: start, $lte: end };
        }

        const payments = await Payment.find(query)
            .populate('patient', 'fullName')
            .populate('appointment', 'date time clinicalStatus')
            .sort({ paymentDate: -1 })
            .lean();

        // ✅ CORREÇÃO: débito real só quando o agendamento foi completado
        // ou quando não há agendamento (débito manual). Agendamentos futuros são "a receber".
        const realDebtPayments = payments.filter(p =>
            !p.appointment || p.appointment.clinicalStatus === 'completed'
        );

        const debitos = realDebtPayments.map(p => ({
            _id: p._id,
            date: p.appointment?.date || (p.serviceDate ? p.serviceDate.toISOString().split('T')[0] : (p.paymentDate ? p.paymentDate.toISOString().split('T')[0] : null)),
            time: p.appointment?.time || null,
            paymentStatus: p.status,
            paciente: p.patient?.fullName || 'Paciente',
            valor: p.amount,
            tipo: p.paymentMethod || p.billingType || 'N/A'
        }));

        const total = debitos.reduce((s, d) => s + (d.valor || 0), 0);

        logMetric('FinancialDashboardV2', 'debitos', { count: debitos.length, total });

        res.json({ success: true, data: debitos, total });
    } catch (err) {
        console.error('[DashboardV2] Erro /debitos:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /v2/financial/dashboard/base-recorrente
// Base recorrente do mês: agenda firme, pacotes ativos, guias de convênio
router.get('/base-recorrente', auth, authorize(['admin', 'secretary']), async (req, res) => {
    try {
        const { month, year } = req.query;
        if (!month || !year) {
            return res.status(400).json({ success: false, message: 'month e year são obrigatórios' });
        }

        const start = moment.tz([parseInt(year), parseInt(month) - 1, 1], TIMEZONE).startOf('day').toDate();
        const end = moment.tz([parseInt(year), parseInt(month) - 1, 1], TIMEZONE).endOf('month').endOf('day').toDate();

        const billingTypeOf = (a) => {
            if (a.billingType === 'convenio') return 'convenio';
            if (a.billingType === 'liminar' || a.liminarContract) return 'liminar';
            if (a.package || a.billingType === 'pacote') return 'pacote';
            return 'particular';
        };

        const sessionValueOf = (a) => {
            if (a.billingType === 'convenio') return a.insuranceValue || 0;
            return a.sessionValue || 0;
        };

        // 1. Appointments ativos no mês
        const appointments = await Appointment.find({
            date: { $gte: start, $lte: end },
            operationalStatus: { $in: ['pre_agendado', 'scheduled', 'confirmed', 'completed'] }
        }).select('billingType liminarContract package sessionValue insuranceValue operationalStatus').lean();

        const agendaFirme = { pacote: { count: 0, valor: 0 }, convenio: { count: 0, valor: 0 }, particular: { count: 0, valor: 0 }, liminar: { count: 0, valor: 0 } };
        let totalAgendado = 0, totalValorAgendado = 0;

        const realizados = { pacote: { count: 0, valor: 0 }, convenio: { count: 0, valor: 0 }, particular: { count: 0, valor: 0 }, liminar: { count: 0, valor: 0 } };
        let totalRealizado = 0, totalValorRealizado = 0;

        for (const a of appointments) {
            const tipo = billingTypeOf(a);
            const valor = sessionValueOf(a);
            agendaFirme[tipo].count += 1;
            agendaFirme[tipo].valor += valor;
            totalAgendado += 1;
            totalValorAgendado += valor;

            if (a.operationalStatus === 'completed') {
                realizados[tipo].count += 1;
                realizados[tipo].valor += valor;
                totalRealizado += 1;
                totalValorRealizado += valor;
            }
        }

        // 2. Pacotes ativos
        const pacotesAtivos = await Package.find(
            { status: { $in: ['active', 'confirmed'] } },
            { totalSessions: 1, sessionsDone: 1, sessionsUsed: 1, sessionValue: 1, patient: 1 }
        ).lean();

        const totalPacotesSessoes = pacotesAtivos.reduce((s, p) => {
            const done = p.sessionsDone || p.sessionsUsed || 0;
            return s + Math.max(0, (p.totalSessions || 0) - done);
        }, 0);

        const pacoteAgendadoJulho = appointments.filter(a => billingTypeOf(a) === 'pacote').length;

        // 3. Guias convênio ativas
        const guiasAtivasRaw = await mongoose.connection.db.collection('insuranceguides').aggregate([
            { $match: { status: 'active' } },
            { $group: {
                _id: '$insurancePlan',
                guias: { $sum: 1 },
                sessoesRestantes: { $sum: { $subtract: [{ $ifNull: ['$totalSessions', 0] }, { $ifNull: ['$usedSessions', 0] }] } }
            }}
        ]).toArray();

        const guiasAtivas = guiasAtivasRaw.map(g => ({
            plano: g._id || 'sem plano',
            guias: g.guias,
            sessoesRestantes: Math.max(0, g.sessoesRestantes)
        }));

        const totalGuiasAtivas = guiasAtivas.reduce((s, g) => s + g.guias, 0);
        const totalSessoesGuia = guiasAtivas.reduce((s, g) => s + g.sessoesRestantes, 0);

        // 4. Referência mês anterior (produção)
        const prevStart = moment(start).subtract(1, 'month').startOf('month').toDate();
        const prevEnd = moment(start).subtract(1, 'month').endOf('month').toDate();
        const producaoMesAnterior = await Appointment.aggregate([
            { $match: { date: { $gte: prevStart, $lte: prevEnd }, operationalStatus: 'completed' } },
            { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$billingType', 'convenio'] }, { $ifNull: ['$insuranceValue', 0] }, { $ifNull: ['$sessionValue', 0] }] } } } }
        ]);
        const referenciaMesAnterior = producaoMesAnterior[0]?.total || 0;

        res.json({
            success: true,
            period: { month: parseInt(month), year: parseInt(year) },
            agendaFirme,
            realizados,
            totais: {
                agendado: { sessoes: totalAgendado, valor: totalValorAgendado },
                realizado: { sessoes: totalRealizado, valor: totalValorRealizado },
                pendenteAgenda: { sessoes: totalAgendado - totalRealizado, valor: totalValorAgendado - totalValorRealizado }
            },
            pacotes: {
                ativos: pacotesAtivos.length,
                sessoesRestantes: totalPacotesSessoes,
                agendadasNoMes: pacoteAgendadoJulho,
                semAgendamentoNoMes: Math.max(0, totalPacotesSessoes - pacoteAgendadoJulho)
            },
            convenios: {
                guiasAtivas: totalGuiasAtivas,
                sessoesAutorizadas: totalSessoesGuia,
                porPlano: guiasAtivas
            },
            referenciaMesAnterior,
            sugestoesMeta: {
                conservadora: Math.ceil(totalValorAgendado / 1000) * 1000,
                ambiciosa: Math.ceil(referenciaMesAnterior * 0.9 / 1000) * 1000
            }
        });
    } catch (err) {
        console.error('[DashboardV2] Erro /base-recorrente:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

export default router;
