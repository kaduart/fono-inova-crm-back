// routes/financialDashboard.v2.js
/**
 * 💰 DASHBOARD FINANCEIRO V3 — META ENGINE PROFISSIONAL
 *
 * Real-time + Metas configuráveis + Performance por profissional
 * + Ranking + Alertas inteligentes + Insights operacionais
 */

import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
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
import financialMetricsService from '../services/financialMetrics.service.js';
import financialSnapshotService from '../services/financialSnapshot.service.js';
import financialExpenseSnapshotService from '../services/financialExpenseSnapshot.service.js';
import { calculatePendentesEngine, getPatientPendingPayments } from '../services/financialEngine.js';
import { isConvenioSession } from '../utils/billingHelpers.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

const paymentBaseFilter = {
    status: { $in: ['paid', 'completed', 'confirmed'] },
    amount: { $gte: 1 }
};

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

        // 🆕 PROJEÇÃO V2: tenta usar snapshot primeiro
        const snapshotReady = await financialSnapshotService.isMonthlySnapshotReady(targetYear, targetMonth);
        let data, profissionais, source = 'real-time';

        if (snapshotReady) {
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

            const [aReceberSnap, comparativosSnap, pendentesSnap] = await Promise.all([
                calculateAReceber(targetYear, targetMonth),
                calculateComparativos(targetYear, targetMonth),
                calculatePendentes(targetYear, targetMonth),
            ]);

            const metasSnap = await calculateMetas(data, targetYear, targetMonth);
            const profissionaisSnap = await calculateProfissionaisFromSnapshot(snap.profissionais, targetYear, targetMonth);

            const insightsSnap = generateInsights(data, metasSnap, profissionaisSnap);
            const riscoOperacionalSnap = calculateRiscoOperacional(data, metasSnap, profissionaisSnap);
            const acoesExecutivasSnap = calculateAcoesExecutivas(data, metasSnap, profissionaisSnap, riscoOperacionalSnap);
            const drillDownSnap = buildDrillDown(data, profissionaisSnap);
            const indicadoresSnap = calculateIndicadores(data.caixa, data.producao, despesasSnap.total, metasSnap);

            return res.json({
                success: true,
                source,
                resumo: {
                    caixa: data.caixa,
                    caixaDetalhe: data.caixaDetalhe,
                    producao: data.producao,
                    producaoDetalhe: { ...data.producaoDetalhe, pendente: pendentesSnap.total },
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
                        breakdown: data.caixaDetalhe,
                        byMethod: data.caixaByMethod
                    },
                    revenue: {
                        total: data.producao,
                        byMethod: { ...data.producaoDetalhe, pendente: pendentesSnap.total }
                    },
                    pendentes: pendentesSnap,
                    expenses: {
                        total: despesasSnap.total,
                        count: despesasSnap.count,
                        breakdown: despesasSnap.breakdown
                    },
                    balance: data.saldo,
                    metas: metasSnap,
                    profissionais: profissionaisSnap,
                    insights: insightsSnap,
                    comparativos: comparativosSnap,
                    riscoOperacional: riscoOperacionalSnap,
                    acoesExecutivas: acoesExecutivasSnap,
                    drillDown: drillDownSnap,
                    indicadores: indicadoresSnap
                },
                metadata: { projection: true }
            });
        }

        console.log(`[DashboardV3] Calculando real-time: ${monthKey}`);

        // Fase 1: queries independentes em paralelo
        const [dataRt, aReceber, despesas, comparativos, pendentes] = await Promise.all([
            calculateRealTime(targetYear, targetMonth),
            calculateAReceber(targetYear, targetMonth),
            calculateDespesas(targetYear, targetMonth),
            calculateComparativos(targetYear, targetMonth),
            calculatePendentes(targetYear, targetMonth),
        ]);
        data = dataRt;

        // Fase 2: dependem de `data`
        const [metas, profissionaisRt] = await Promise.all([
            calculateMetas(data, targetYear, targetMonth),
            calculateProfissionais(data, targetYear, targetMonth),
        ]);
        profissionais = profissionaisRt;

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
                caixaDetalhe: data.caixaDetalhe,
                producao: data.producao,
                producaoDetalhe: { ...data.producaoDetalhe, pendente: pendentes.total },
                aReceber,
                pendentes,
                saldo: data.saldo,
                despesas,
                metas,
                profissionais: profissionais.ranking,
                indicadores
            },
            data: {
                period: { month: targetMonth, year: targetYear },
                cash: {
                    total: data.caixa,
                    breakdown: data.caixaDetalhe,
                    byMethod: data.caixaByMethod
                },
                revenue: {
                    total: data.producao,
                    byMethod: { ...data.producaoDetalhe, pendente: pendentes.total }
                },
                pendentes,
                expenses: {
                    total: despesas.total,
                    count: despesas.count
                },
                balance: data.saldo,
                metas,
                profissionais,
                insights,
                comparativos,
                riscoOperacional,
                acoesExecutivas,
                drillDown,
                indicadores
            },
            metadata: {
                projection: false
            }
        });

    } catch (error) {
        console.error('[DashboardV3] Erro:', error);
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
        const { startDate, endDate } = req.body;
        if (!startDate || !endDate) {
            return res.status(400).json({ success: false, error: 'startDate e endDate são obrigatórios' });
        }

        console.log(`[DashboardV3] Rebuild snapshot: ${startDate} → ${endDate}`);

        const { processFinancialEvent } = await import('../workers/financialSnapshotWorker.js');

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
            } else if (p.status === 'partial') {
                await processFinancialEvent('PAYMENT_PARTIAL', payload);
            }
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
 * 🎯 Calcula metas inteligentes de gestão
 */
async function calculateMetas(data, year, month, clinicId = 'default') {
    const now = moment.tz(TIMEZONE);
    const endOfMonth = moment.tz([year, month - 1], TIMEZONE).endOf('month');
    const daysInMonth = endOfMonth.date();
    const daysPassed = Math.min(now.date(), daysInMonth);
    const daysRemaining = Math.max(daysInMonth - daysPassed, 1);

    const goal = await loadGoal(year, month, clinicId);
    const metaMensal = goal.metaMensal;
    const diasUteis = goal.diasUteis;
    const metaDiariaNecessaria = metaMensal / diasUteis;

    const realizadoMes = data.caixa;
    const realizadoDia = data.caixaHoje || 0;

    const mediaDiariaAtual = daysPassed > 0 ? realizadoMes / daysPassed : 0;
    const projecaoFinal = mediaDiariaAtual * daysInMonth;

    const gapValor = Math.max(metaMensal - realizadoMes, 0);
    const gapPorDia = gapValor / daysRemaining;

    const ritmoEsperado = (daysPassed / diasUteis) * metaMensal;
    const diferencaRitmo = realizadoMes - ritmoEsperado;

    const percentualEsperado = (daysPassed / diasUteis) * 100;
    const percentualRealizado = metaMensal > 0 ? (realizadoMes / metaMensal) * 100 : 0;

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
        alertas.mensagem.push('⚠️ Dia crítico: caixa abaixo de 70% da meta diária.');
    } else if (alertas.atrasado) {
        alertas.mensagem.push('🐢 Ritmo abaixo do necessário para bater meta.');
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
            metaDiariaNecessaria: parseFloat(metaDiariaNecessaria.toFixed(2))
        },
        realizado: {
            mes: parseFloat(realizadoMes.toFixed(2)),
            hoje: parseFloat(realizadoDia.toFixed(2))
        },
        ritmo: {
            esperadoAteAgora: parseFloat(ritmoEsperado.toFixed(2)),
            realizadoAteAgora: parseFloat(realizadoMes.toFixed(2)),
            diferenca: parseFloat(diferencaRitmo.toFixed(2)),
            mediaDiariaAtual: parseFloat(mediaDiariaAtual.toFixed(2)),
            percentualEsperado: parseFloat(percentualEsperado.toFixed(1)),
            percentualRealizado: parseFloat(percentualRealizado.toFixed(1))
        },
        projecao: {
            final: parseFloat(projecaoFinal.toFixed(2)),
            bateMeta: projecaoFinal >= metaMensal
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
                realizado: parseFloat((data.caixaDetalhe.particular || 0).toFixed(2)),
                percentualDoTotal: data.caixa > 0 ? parseFloat(((data.caixaDetalhe.particular || 0) / data.caixa * 100).toFixed(1)) : 0
            },
            pacote: {
                meta: parseFloat((goal.breakdown.pacote || 0).toFixed(2)),
                realizado: parseFloat((data.caixaDetalhe.pacote || 0).toFixed(2)),
                percentualDoTotal: data.caixa > 0 ? parseFloat(((data.caixaDetalhe.pacote || 0) / data.caixa * 100).toFixed(1)) : 0
            },
            convenio: {
                meta: parseFloat((goal.breakdown.convenio || 0).toFixed(2)),
                realizado: parseFloat((data.caixaDetalhe.convenio || 0).toFixed(2)),
                percentualDoTotal: data.caixa > 0 ? parseFloat(((data.caixaDetalhe.convenio || 0) / data.caixa * 100).toFixed(1)) : 0
            },
            liminar: {
                meta: parseFloat((goal.breakdown.liminar || 0).toFixed(2)),
                realizado: parseFloat((data.caixaDetalhe.liminar || 0).toFixed(2)),
                percentualDoTotal: data.caixa > 0 ? parseFloat(((data.caixaDetalhe.liminar || 0) / data.caixa * 100).toFixed(1)) : 0
            }
        }
    };
}

/**
 * 👩‍⚕️ Calcula performance por profissional — ALINHADO COM ARQUITETURA V2 (Session)
 */
async function calculateProfissionais(data, year, month) {
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').utc().toDate();
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month').utc().toDate();

    const doctors = await Doctor.find({ active: { $ne: false } }).select('_id fullName specialty commissionRules').lean();

    // Produção = Sessions completadas no mês (V2)
    const sessions = await Session.find({
        date: { $gte: start, $lte: end },
        status: 'completed'
    }).select('doctor sessionValue paymentMethod package paymentOrigin').lean();

    // Caixa real = Payments do mês vinculados a sessões
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

    const paymentMap = new Map();
    [...particularPayments, ...convenioPayments].forEach(p => {
        const sessionId = p.session?.toString();
        if (!sessionId) return;
        const val = p.billingType === 'convenio' ? (p.insurance?.receivedAmount || p.amount || 0) : (p.amount || 0);
        paymentMap.set(sessionId, (paymentMap.get(sessionId) || 0) + val);
    });

    // Sessões de pacote convênio pagas (sem Payment vinculado)
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
        const valor = s.sessionValue || 0;
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
 * 🔄 Calcula dados em tempo real — ALINHADO COM ARQUITETURA V2
 *
 * Caixa e Produção totais usam FinancialMetricsService (fonte única de verdade).
 * Breakdowns manuais são calculados sobre a MESMA base de dados do V2.
 */
async function calculateRealTime(year, month) {
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').utc().toDate();
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month').utc().toDate();
    const todayStart = moment.tz(TIMEZONE).startOf('day').utc().toDate();
    const todayEnd = moment.tz(TIMEZONE).endOf('day').utc().toDate();
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    // ───────────────────────────────────────────────
    // 1. TOTAIS V2 (fonte única de verdade)
    // ───────────────────────────────────────────────
    const [cashV2, productionV2, todayCashV2] = await Promise.all([
        financialMetricsService.calculateCash({ startDate: start, endDate: end }),
        financialMetricsService.calculateProduction({ startDate: start, endDate: end }),
        financialMetricsService.calculateCash({ startDate: todayStart, endDate: todayEnd })
    ]);

    const caixaTotal = cashV2.total;
    const caixaHoje = todayCashV2.total;
    const producaoTotal = productionV2.total;

    // ───────────────────────────────────────────────
    // 2. Breakdown de CAIXA por método e tipo de negócio
    //    Usa os MESMOS critérios do V2 para seleção de documentos.
    // ───────────────────────────────────────────────
    const [particularPayments, convenioPayments] = await Promise.all([
        Payment.find({
            billingType: 'particular',
            status: 'paid',
            paymentDate: { $gte: startStr, $lte: endStr }
        }).select('amount paymentMethod notes description type serviceType billingType').lean(),

        Payment.find({
            billingType: 'convenio',
            'insurance.status': { $in: ['received', 'partial'] },
            'insurance.receivedAt': { $gte: start, $lte: end }
        }).select('amount insurance.receivedAmount paymentMethod notes description type serviceType billingType').lean()
    ]);

    // Sessões de pacote convênio pagas (FASE 1 — proteção anti-duplicação)
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
                amount: { $ifNull: ['$sessionValue', '$pkg.insuranceGrossAmount'] },
                paymentMethod: '$paymentMethod',
                notes: { $literal: '' },
                description: { $literal: '' },
                billingType: { $literal: 'convenio' },
                type: { $literal: '' },
                serviceType: { $literal: 'package_session' }
            }
        }
    ]);

    const allCashItems = [
        ...particularPayments.map(p => ({ ...p, amount: p.amount })),
        ...convenioPayments.map(p => ({ ...p, amount: p.insurance?.receivedAmount || p.amount })),
        ...sessionCashResult
    ];

    let caixaParticular = 0, caixaConvenio = 0, caixaPacote = 0, caixaLiminar = 0;
    const caixaByMethod = { pix: 0, dinheiro: 0, cartao: 0, outros: 0 };

    allCashItems.forEach(p => {
        const method = (p.paymentMethod || '').toLowerCase();
        if (method.includes('pix')) caixaByMethod.pix += p.amount;
        else if (method.includes('card') || method.includes('cartao') || method.includes('crédito') || method.includes('debito') || method.includes('credit') || method.includes('debit')) caixaByMethod.cartao += p.amount;
        else if (method.includes('cash') || method.includes('dinheiro')) caixaByMethod.dinheiro += p.amount;
        else caixaByMethod.outros += p.amount;

        const notes = (p.notes || '').toLowerCase();
        const desc = (p.description || '').toLowerCase();
        const billingType = p.billingType || 'particular';

        if (notes.includes('pacote') || desc.includes('pacote') || p.type === 'package' || p.serviceType === 'package_session') caixaPacote += p.amount;
        else if (billingType === 'convenio' || notes.includes('convênio') || desc.includes('convenio') || p.type === 'insurance') caixaConvenio += p.amount;
        else if (billingType === 'liminar' || notes.includes('liminar')) caixaLiminar += p.amount;
        else caixaParticular += p.amount;
    });

    // ───────────────────────────────────────────────
    // 3. Produção: Session.status = 'completed' (V2)
    // ───────────────────────────────────────────────
    const sessions = await Session.find({
        date: { $gte: start, $lte: end },
        status: 'completed'
    }).populate('package', 'insuranceGrossAmount type').lean();

    let producaoParticular = 0, producaoConvenio = 0, producaoPacote = 0, producaoLiminar = 0;
    let recebidoProducao = 0, aReceberProducao = 0;

    sessions.forEach(s => {
        const valor = (s.sessionValue > 0 ? s.sessionValue : null)
          ?? s.package?.sessionValue
          ?? s.package?.insuranceGrossAmount
          ?? 0;
        const paymentMethod = s.paymentMethod || 'particular';
        const isConvenio = isConvenioSession(s);
        const isPacote = !!s.package;
        const isLiminar = paymentMethod === 'liminar_credit' || s.paymentOrigin === 'liminar';

        if (isConvenio) producaoConvenio += valor;
        else if (isLiminar) producaoLiminar += valor;
        else if (isPacote) producaoPacote += valor;
        else producaoParticular += valor;

        const foiPago = s.isPaid === true || isConvenio || isLiminar;
        if (foiPago) recebidoProducao += valor;
        else aReceberProducao += valor;
    });

    return {
        caixa: caixaTotal,
        caixaHoje,
        caixaDetalhe: { particular: caixaParticular, pacote: caixaPacote, convenio: caixaConvenio, liminar: caixaLiminar },
        caixaByMethod,
        producao: producaoTotal,
        producaoDetalhe: { particular: producaoParticular, pacote: producaoPacote, convenio: producaoConvenio, liminar: producaoLiminar, recebido: recebidoProducao, pendente: aReceberProducao },
        saldo: caixaTotal
    };
}

async function calculateAReceber(year, month) {
    const startStr = moment.tz([year, month - 1], TIMEZONE).startOf('month').format('YYYY-MM-DD');
    const endStr = moment.tz([year, month - 1], TIMEZONE).endOf('month').format('YYYY-MM-DD');

    // 🆕 Fonte de verdade: Payment — convênios pendentes
    const startDate = moment.tz([year, month - 1], TIMEZONE).startOf('month').toDate();
    const endDate = moment.tz([year, month - 1], TIMEZONE).endOf('month').toDate();
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
                    { serviceDate: { $gte: startStr, $lte: endStr } },
                    { createdAt: { $gte: startDate, $lte: endDate } }
                ]
            }
        ]
    }).lean();

    const total = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
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
    const doctors = await Doctor.find({ active: { $ne: false } }).select('_id fullName').lean();
    const commissionResults = await Promise.all(
        doctors.map(async (d) => {
            try {
                const comm = await calculateDoctorCommission(d._id, start, end);
                return {
                    doctorId: d._id.toString(),
                    doctorName: d.fullName,
                    total: comm.totalCommission,
                    sessions: comm.totalSessions
                };
            } catch (err) {
                return { doctorId: d._id.toString(), doctorName: d.fullName, total: 0, sessions: 0 };
            }
        })
    );

    const activeCommissions = commissionResults.filter(c => c.total > 0);
    const commissionTotal = activeCommissions.reduce((sum, c) => sum + c.total, 0);

    return {
        total: parseFloat((expenseTotal + commissionTotal).toFixed(2)),
        count: expenses.length,
        breakdown: {
            expenses: parseFloat(expenseTotal.toFixed(2)),
            comissoes: parseFloat(commissionTotal.toFixed(2)),
            detalheComissoes: activeCommissions
        }
    };
}

/**
 * 📊 Comparativos: mês atual vs mês anterior
 *
 * Regra arquitetural: usa snapshot quando disponível; fallback para runtime.
 */
async function calculateComparativos(year, month) {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    const calcVariacao = (atual, anterior) => {
        if (!anterior || anterior === 0) return atual > 0 ? 100 : 0;
        return parseFloat((((atual - anterior) / anterior) * 100).toFixed(1));
    };

    // Tenta snapshot para mês anterior
    let prevCaixa = 0, prevProducao = 0, prevDespesas = 0;
    const prevSnapReady = await financialSnapshotService.isMonthlySnapshotReady(prevYear, prevMonth);
    const prevExpReady = await financialExpenseSnapshotService.isMonthlySnapshotReady(prevYear, prevMonth);
    if (prevSnapReady) {
        const prevSnap = await financialSnapshotService.getMonthlyAggregate(prevYear, prevMonth);
        prevCaixa = prevSnap.caixa;
        prevProducao = prevSnap.producao;
    } else {
        const prevRt = await calculateRealTime(prevYear, prevMonth);
        prevCaixa = prevRt.caixa;
        prevProducao = prevRt.producao;
    }
    if (prevExpReady) {
        const prevExp = await financialExpenseSnapshotService.getMonthlyAggregate(prevYear, prevMonth);
        prevDespesas = prevExp.total;
    } else {
        const prevDp = await calculateDespesas(prevYear, prevMonth);
        prevDespesas = prevDp.total;
    }

    // Tenta snapshot para mês atual
    let currentCaixa = 0, currentProducao = 0, currentDespesas = 0;
    const currentSnapReady = await financialSnapshotService.isMonthlySnapshotReady(year, month);
    const currentExpReady = await financialExpenseSnapshotService.isMonthlySnapshotReady(year, month);
    if (currentSnapReady) {
        const currSnap = await financialSnapshotService.getMonthlyAggregate(year, month);
        currentCaixa = currSnap.caixa;
        currentProducao = currSnap.producao;
    } else {
        const currRt = await calculateRealTime(year, month);
        currentCaixa = currRt.caixa;
        currentProducao = currRt.producao;
    }
    if (currentExpReady) {
        const currExp = await financialExpenseSnapshotService.getMonthlyAggregate(year, month);
        currentDespesas = currExp.total;
    } else {
        const currDp = await calculateDespesas(year, month);
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

    // 🆕 VALIDAÇÃO: Busca TODOS os pendentes para auditoria
    const allPendingRaw = await Payment.find({ status: 'pending' })
        .select('_id amount paymentDate serviceDate createdAt appointment patient billingType paymentMethod')
        .lean();
    
    const allPendingTotal = allPendingRaw.reduce((s, p) => s + (p.amount || 0), 0);
    console.log(`[DashboardV3][AUDIT] Todos os payments pending no BD: ${allPendingRaw.length} items, total: ${allPendingTotal}`);

    // 🆕 Fonte de verdade: Payment (V1) — BUSCA AMPLA para não perder dados
    // Problema: payments criados em meses anteriores para sessões deste mês
    // Solução: busca todos os pending e filtra no JS pela data do appointment/payment
    const paymentsAll = await Payment.find({ status: 'pending' })
        .populate('patient', 'fullName')
        .populate('doctor', 'fullName specialty')
        .populate('appointment', 'date time')
        .lean();

    let convenioTotal = 0;
    let particularTotal = 0;
    const convenioItems = [];
    const particularItems = [];
    const skippedAudit = [];

    for (const p of paymentsAll) {
        const isConvenio = p.billingType === 'convenio' || p.paymentMethod === 'convenio' || (p.insurance && p.insurance.status);
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

    if (skippedAudit.length > 0) {
        console.log(`[DashboardV3][AUDIT] ${skippedAudit.length} payments pending FORA do mês ${startStr}~${endStr}:`, skippedAudit.slice(0, 10));
    }

    const total = convenioTotal + particularTotal;
    console.log(`[DashboardV3][AUDIT] No mês ${startStr}~${endStr}: particular=${particularItems.length} convenio=${convenioItems.length} total=${total}`);

    // ── 🆕 DÉBITOS VENCIDOS: apenas data <= hoje (sessões que já deveriam ter sido pagas) ──
    const hoje = moment().tz(TIMEZONE).format('YYYY-MM-DD');
    const convenioVencidos = convenioItems.filter(i => i.data && i.data <= hoje);
    const particularVencidos = particularItems.filter(i => i.data && i.data <= hoje);
    const vencidosTotal = convenioVencidos.reduce((s, i) => s + i.valor, 0) + particularVencidos.reduce((s, i) => s + i.valor, 0);
    console.log(`[DashboardV3][AUDIT] Vencidos até ${hoje}: particular=${particularVencidos.length} convenio=${convenioVencidos.length} total=${vencidosTotal}`);

    // ── 🆕 V2 FINANCIAL ENGINE: agrupamento por paciente + especialidade correta ──
    // Passa todos os pending do mês para o engine (sem filtro de data, pois já filtramos)
    const monthPayments = [...convenioItems, ...particularItems].map(i => i.sessionId);
    const enginePayments = paymentsAll.filter(p => monthPayments.includes(p._id.toString()));
    
    // Monta resultado do engine manualmente a partir dos payments já filtrados
    const byPatient = {};
    const byDoctor = {};
    const bySpecialty = {};
    const byBillingType = { particular: { total: 0, count: 0, items: [] }, convenio: { total: 0, count: 0, items: [] } };

    for (const p of enginePayments) {
        const valor = p.amount || 0;
        const isConvenio = p.billingType === 'convenio' || p.paymentMethod === 'convenio' || (p.insurance && p.insurance.status);
        const btype = isConvenio ? 'convenio' : 'particular';
        
        // byPatient
        const pid = p.patient?._id?.toString() || p.patientId;
        if (pid) {
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
                specialty: p.doctor?.specialty || p.serviceType || p.sessionType || 'N/A',
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

    return {
        total: parseFloat(total.toFixed(2)),
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
}

export default router;
