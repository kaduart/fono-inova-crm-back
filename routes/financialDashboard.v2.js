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
import { calculateDoctorCommission } from '../services/commissionService.js';

const router = express.Router();
const TIMEZONE = 'America/Sao_Paulo';

const paymentBaseFilter = {
    status: { $in: ['paid', 'completed', 'confirmed'] },
    amount: { $gte: 1 }
};

const META_CONFIG = {
    mensal: 40000,
    diasUteis: 26
};

async function loadGoal(year, month, clinicId = 'default') {
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

    // Fallback: busca no modelo Planning (salvo via /api/v2/goals)
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const planning = await Planning.findOne({
        type: 'monthly',
        'period.start': start,
        'period.end': end,
    }).lean();

    return {
        metaMensal: planning?.targets?.expectedRevenue ?? META_CONFIG.mensal,
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

        console.log(`[DashboardV3] Calculando real-time: ${monthKey}`);

        // Fase 1: queries independentes em paralelo
        const [data, aReceber, despesas, comparativos] = await Promise.all([
            calculateRealTime(targetYear, targetMonth),
            calculateAReceber(targetYear, targetMonth),
            calculateDespesas(targetYear, targetMonth),
            calculateComparativos(targetYear, targetMonth),
        ]);

        // Fase 2: dependem de `data`
        const [metas, profissionais] = await Promise.all([
            calculateMetas(data, targetYear, targetMonth),
            calculateProfissionais(data, targetYear, targetMonth),
        ]);

        const insights = generateInsights(data, metas, profissionais);
        const riscoOperacional = calculateRiscoOperacional(data, metas, profissionais);
        const acoesExecutivas = calculateAcoesExecutivas(data, metas, profissionais, riscoOperacional);
        const drillDown = buildDrillDown(data, profissionais);

        res.json({
            success: true,
            source: 'real-time',
            resumo: {
                caixa: data.caixa,
                caixaDetalhe: data.caixaDetalhe,
                producao: data.producao,
                producaoDetalhe: data.producaoDetalhe,
                aReceber,
                saldo: data.saldo,
                despesas,
                metas,
                profissionais: profissionais.ranking
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
                    byMethod: data.producaoDetalhe
                },
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
                drillDown
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
    const percentualRealizado = (realizadoMes / metaMensal) * 100;

    let statusMeta = 'vermelho';
    if (percentualRealizado >= 100) statusMeta = 'verde';
    else if (percentualRealizado >= 80) statusMeta = 'amarelo-verde';
    else if (percentualRealizado >= 60) statusMeta = 'amarelo';

    const alertas = {
        atrasado: realizadoMes < ritmoEsperado,
        critico: realizadoDia < (metaDiariaNecessaria * 0.7),
        ok: realizadoMes >= metaMensal,
        mensagem: []
    };

    if (alertas.ok) alertas.mensagem.push('🎉 Meta mensal batida!');
    else if (alertas.critico) alertas.mensagem.push('⚠️ Dia crítico: caixa abaixo de 70% da meta diária.');
    else if (alertas.atrasado) alertas.mensagem.push('🐢 Ritmo abaixo do necessário para bater meta.');
    else alertas.mensagem.push('✅ Ritmo adequado para meta mensal.');

    if (projecaoFinal < metaMensal) {
        alertas.mensagem.push(`🔮 Projeção de fechamento: R$ ${projecaoFinal.toFixed(2).replace('.', ',')} (abaixo da meta).`);
    } else {
        alertas.mensagem.push(`🔮 Projeção de fechamento: R$ ${projecaoFinal.toFixed(2).replace('.', ',')} (acima da meta).`);
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
 * 👩‍⚕️ Calcula performance por profissional
 */
async function calculateProfissionais(data, year, month) {
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').utc().toDate();
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month').utc().toDate();

    const doctors = await Doctor.find({ active: { $ne: false } }).select('_id fullName specialty commissionRules').lean();

    // Appointments do mês (produção)
    const appointments = await Appointment.find({
        date: { $gte: start, $lt: end },
        operationalStatus: { $in: ['confirmed', 'completed', 'scheduled'] },
        isDeleted: { $ne: true }
    }).select('doctor sessionValue billingType serviceType insuranceProvider paymentStatus paymentOrigin').lean();

    // Payments do mês (caixa real) com appointment vinculado
    const payments = await Payment.find({
        ...paymentBaseFilter,
        financialDate: { $gte: start, $lte: end },
        
        appointment: { $exists: true, $ne: null }
    }).select('appointment amount').lean();

    const paymentMap = new Map();
    payments.forEach(p => {
        const apptId = p.appointment?.toString();
        if (!paymentMap.has(apptId)) paymentMap.set(apptId, 0);
        paymentMap.set(apptId, paymentMap.get(apptId) + (p.amount || 0));
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

    appointments.forEach(a => {
        const docId = a.doctor?.toString();
        if (!docId || !profMap.has(docId)) return;

        const prof = profMap.get(docId);
        const valor = a.sessionValue || 0;
        const billingType = a.billingType || 'particular';
        const isConvenio = billingType === 'convenio' || (a.insuranceProvider && a.insuranceProvider.trim() !== '');
        const isPacote = a.serviceType === 'package_session';
        const isLiminar = billingType === 'liminar' || a.paymentOrigin === 'liminar';

        prof.producao += valor;
        prof.quantidade += 1;

        if (isConvenio) prof.convenio += valor;
        else if (isPacote) prof.pacote += valor;
        else if (isLiminar) prof.liminar += valor;
        else prof.particular += valor;

        const pago = paymentMap.get(a._id.toString()) || 0;
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

    lista = lista.map(p => ({
        ...p,
        comissao: commissionMap.get(p.id) || { total: 0, sessoes: 0, breakdown: null },
        ticketMedio: p.quantidade > 0 ? parseFloat((p.producao / p.quantidade).toFixed(2)) : 0,
        eficiencia: p.producao > 0 ? parseFloat(((p.realizado / p.producao) * 100).toFixed(1)) : 0,
        produtividade: mediaProducao > 0 ? parseFloat(((p.producao / mediaProducao) * 100).toFixed(1)) : 100
    }));

    const rankingPorRealizado = [...lista].sort((a, b) => b.realizado - a.realizado);
    const rankingPorProducao = [...lista].sort((a, b) => b.producao - a.producao);

    return {
        lista,
        ranking: rankingPorRealizado.slice(0, 10),
        rankingPorProducao: rankingPorProducao.slice(0, 10),
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
 * 🔄 Calcula dados em tempo real
 */
async function calculateRealTime(year, month) {
    const start = moment.tz([year, month - 1], TIMEZONE).startOf('month').utc().toDate();
    const end = moment.tz([year, month - 1], TIMEZONE).endOf('month').utc().toDate();
    const todayStart = moment.tz(TIMEZONE).startOf('day').utc().toDate();
    const todayEnd = moment.tz(TIMEZONE).endOf('day').utc().toDate();

    const payments = await Payment.find({
        ...paymentBaseFilter,
        financialDate: { $gte: start, $lte: end }
    }).populate('patient', 'fullName').lean();

    let validPayments = payments.filter(p => {
        const nome = (p.patient?.fullName || p.patientName || '').toLowerCase();
        return !nome.includes('teste') && !nome.includes('test ');
    });

    const paymentAppointmentIds = validPayments
        .map(p => p.appointment?.toString())
        .filter(Boolean);
    if (paymentAppointmentIds.length > 0) {
        const paymentAppointments = await Appointment.find({
            _id: { $in: paymentAppointmentIds }
        }).select('_id isDeleted operationalStatus').lean();
        const existingAppointmentsMap = new Map(
            paymentAppointments.map(a => [a._id.toString(), a])
        );
        validPayments = validPayments.filter(p => {
            const apptId = p.appointment?.toString();
            if (!apptId) return true;
            const appt = existingAppointmentsMap.get(apptId);
            if (!appt) return false;
            if (appt.isDeleted === true) return false;
            if (['canceled', 'cancelled', 'cancelado'].includes(appt.operationalStatus)) return false;
            return true;
        });
    }

    let caixaTotal = 0;
    let caixaHoje = 0;
    let caixaParticular = 0, caixaConvenio = 0, caixaPacote = 0, caixaLiminar = 0;
    const caixaByMethod = { pix: 0, dinheiro: 0, cartao: 0, outros: 0 };

    validPayments.forEach(p => {
        caixaTotal += p.amount;
        if (moment(p.financialDate).isBetween(todayStart, todayEnd, null, '[]')) caixaHoje += p.amount;

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

    const appointments = await Appointment.find({
        date: { $gte: start, $lt: end },
        operationalStatus: { $in: ['confirmed', 'completed', 'scheduled'] },
        isDeleted: { $ne: true },
        patient: { $exists: true, $ne: null }
    }).populate('patient', 'fullName').lean();

    const patientIdsArray = [...new Set(appointments.map(a => a.patient?._id?.toString() || a.patient?.toString()).filter(Boolean))];

    const Patient = (await import('../models/Patient.js')).default;
    const validPatients = await Patient.find({ _id: { $in: patientIdsArray }, isDeleted: { $ne: true } }).select('_id').lean();
    const validPatientIdsSet = new Set(validPatients.map(p => p._id.toString()));

    const validAppointments = appointments.filter(a => {
        const pid = a.patient?._id?.toString() || a.patient?.toString();
        return validPatientIdsSet.has(pid);
    });

    const monthPayments = await Payment.find({
        ...paymentBaseFilter,
        financialDate: { $gte: start, $lte: end }
    }).select('appointment').lean();
    const paidAppointmentIds = new Set(monthPayments.map(p => p.appointment?.toString()).filter(Boolean));

    let producaoTotal = 0;
    let producaoParticular = 0, producaoConvenio = 0, producaoPacote = 0, producaoLiminar = 0;
    let recebidoProducao = 0, aReceberProducao = 0;

    validAppointments.forEach(a => {
        const valor = a.sessionValue || 0;
        producaoTotal += valor;

        const billingType = a.billingType || 'particular';
        const isConvenio = billingType === 'convenio' || (a.insuranceProvider && a.insuranceProvider.trim() !== '');
        const isPacote = a.serviceType === 'package_session';
        const isLiminar = billingType === 'liminar' || a.paymentOrigin === 'liminar';

        if (isConvenio) producaoConvenio += valor;
        else if (isPacote) producaoPacote += valor;
        else if (isLiminar) producaoLiminar += valor;
        else producaoParticular += valor;

        const temPayment = paidAppointmentIds.has(a._id.toString());
        const foiPagoViaPacote = a.paymentStatus === 'package_paid' || isPacote;
        const foiPago = temPayment || foiPagoViaPacote || isConvenio || isLiminar;

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
    const startOfMonth = moment.tz([year, month - 1], TIMEZONE).startOf('month');
    const endOfMonth = moment.tz([year, month - 1], TIMEZONE).endOf('month');

    const sessoes = await Session.find({
        date: { $gte: startOfMonth.utc().toDate(), $lte: endOfMonth.utc().toDate() },
        status: 'completed',
        $or: [
            { paymentMethod: 'convenio' },
            { billingType: 'convenio' },
            { insuranceGuide: { $exists: true, $ne: null } }
        ],
        $or: [
            { isPaid: false },
            { isPaid: { $exists: false } },
            { paymentStatus: { $in: ['pending', 'pending_receipt'] } }
        ]
    }).populate('package', 'insuranceGrossAmount').lean();

    const total = sessoes.reduce((sum, s) => sum + (s.package?.insuranceGrossAmount || s.sessionValue || 0), 0);
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
 */
async function calculateComparativos(year, month) {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    const prevData = await calculateRealTime(prevYear, prevMonth);
    const prevDespesas = await calculateDespesas(prevYear, prevMonth);
    const currentData = await calculateRealTime(year, month);
    const currentDespesas = await calculateDespesas(year, month);

    const calcVariacao = (atual, anterior) => {
        if (!anterior || anterior === 0) return atual > 0 ? 100 : 0;
        return parseFloat((((atual - anterior) / anterior) * 100).toFixed(1));
    };

    return {
        mesAnterior: {
            caixa: parseFloat(prevData.caixa.toFixed(2)),
            producao: parseFloat(prevData.producao.toFixed(2)),
            despesas: parseFloat(prevDespesas.total.toFixed(2))
        },
        mesAtual: {
            caixa: parseFloat(currentData.caixa.toFixed(2)),
            producao: parseFloat(currentData.producao.toFixed(2)),
            despesas: parseFloat(currentDespesas.total.toFixed(2))
        },
        variacao: {
            caixa: calcVariacao(currentData.caixa, prevData.caixa),
            producao: calcVariacao(currentData.producao, prevData.producao),
            despesas: calcVariacao(currentDespesas.total, prevDespesas.total)
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

export default router;
