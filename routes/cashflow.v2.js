// routes/cashflow.v2.js - CAIXA REAL FECHADO PARA PRODUÇÃO (V2 PURA)
import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Expense from '../models/Expense.js';
import unifiedFinancialService from '../services/unifiedFinancialService.v2.js';

const router = express.Router();

// GET /api/v2/cashflow?date=2026-04-10
router.get('/', auth, async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date || moment.tz('America/Sao_Paulo').format('YYYY-MM-DD');

        // Range do dia em Brasília (UTC-3)
        const start = moment.tz(targetDate, 'America/Sao_Paulo').startOf('day').utc().toDate();
        const end = moment.tz(targetDate, 'America/Sao_Paulo').endOf('day').utc().toDate();

        // ============================================================
        // 🎯 CAIXA & PRODUÇÃO — Fonte única de verdade (V2 pura)
        // ============================================================
        const [cash, production] = await Promise.all([
            unifiedFinancialService.calculateCash(start, end),
            unifiedFinancialService.calculateProduction(start, end)
        ]);

        // ============================================================
        // 🎯 BUSCA DESPESAS DO DIA
        // ============================================================
        const expenses = await Expense.find({
            date: targetDate,
            status: { $nin: ['canceled', 'cancelado'] }
        }).lean();

        // ============================================================
        // 🔧 DADOS AUXILIARES PARA EXIBIÇÃO (transações detalhadas)
        // ============================================================
        const appointmentIds = cash.payments.map(p => p.appointment?.toString()).filter(Boolean);
        const sessionApptIds = production.sessions.map(s => s.appointmentId?.toString()).filter(Boolean);
        const allApptIds = Array.from(new Set([...appointmentIds, ...sessionApptIds]));

        const [appointmentsMap, doctorsMap, patientMap] = await Promise.all([
            allApptIds.length > 0
                ? Appointment.find({ _id: { $in: allApptIds } })
                    .select('_id time doctor specialty operationalStatus billingType insuranceProvider serviceType package patient patientName patientInfo paymentStatus paymentMethod')
                    .populate('patient', 'fullName phone')
                    .populate('doctor', 'fullName specialty')
                    .populate('package', 'paymentType sessionValue totalValue totalSessions model')
                    .lean()
                    .then(list => new Map(list.map(a => [a._id.toString(), a])))
                : new Map(),
            (async () => {
                const doctorIds = Array.from(new Set(production.sessions.map(s => s.doctor?.toString()).filter(Boolean)));
                if (doctorIds.length === 0) return new Map();
                const docs = await (await import('../models/Doctor.js')).default.find({ _id: { $in: doctorIds } }).select('_id fullName specialty').lean();
                return new Map(docs.map(d => [d._id.toString(), d]));
            })(),
            (async () => {
                const patientIds = Array.from(new Set(production.sessions.map(s => s.patient?.toString()).filter(Boolean)));
                if (patientIds.length === 0) return new Map();
                const pts = await (await import('../models/Patient.js')).default.find({ _id: { $in: patientIds } }).select('_id fullName phone').lean();
                return new Map(pts.map(p => [p._id.toString(), p]));
            })()
        ]);

        // sessionId → appointmentId — fallback para payments sem p.appointment direto
        const sessionToApptIdMap = new Map(
            production.sessions
                .filter(s => s._id && s.appointmentId)
                .map(s => [s._id.toString(), s.appointmentId.toString()])
        );

        // patientId → serviceType — via sessions de produção (não depende de populate)
        const patientIdToServiceType = new Map();
        for (const s of production.sessions) {
            if (!s.patient || !s.appointmentId) continue;
            const appt = appointmentsMap.get(s.appointmentId.toString());
            if (appt?.serviceType) {
                patientIdToServiceType.set(s.patient.toString(), appt.serviceType);
            }
        }

        // ============================================================
        // 🎯 COMPARATIVOS: ONTEM E MÊS
        // ============================================================
        const yesterdayStart = moment.tz(targetDate, 'America/Sao_Paulo').subtract(1, 'day').startOf('day').utc().toDate();
        const yesterdayEnd = moment.tz(targetDate, 'America/Sao_Paulo').subtract(1, 'day').endOf('day').utc().toDate();

        const yesterdayCash = await unifiedFinancialService.calculateCash(yesterdayStart, yesterdayEnd);
        const yesterdayTotal = yesterdayCash.total;

        const monthStart = moment.tz(targetDate, 'America/Sao_Paulo').startOf('month').utc().toDate();
        const monthCash = await unifiedFinancialService.calculateCash(monthStart, end);
        const totalMes = monthCash.total;
        const dayOfMonth = moment.tz(targetDate, 'America/Sao_Paulo').date();
        const mediaDiariaMes = dayOfMonth > 0 ? totalMes / dayOfMonth : 0;
        const projecaoMes = mediaDiariaMes * 30;

        // ============================================================
        // ========== TRANSAÇÕES DE CAIXA ==========
        // ============================================================
        let qtdPix = 0, qtdDinheiro = 0, qtdCartao = 0;
        const porEspecialidadeCaixa = {};

        // Mapa: sessionId → isPrepaid (true=pré-pago, false=por sessão)
        // Usado para detectar consumo de sessão pré-paga que escapou dos filtros padrão
        const pkgSessionPrepaidMap = new Map(
            production.sessions
                .filter(s => !!s.package)
                .map(s => {
                    const apptS = s.appointmentId ? appointmentsMap.get(s.appointmentId.toString()) : null;
                    const pt = apptS?.package?.paymentType || apptS?.package?.model;
                    return [s._id.toString(), pt === 'full' || pt === 'prepaid'];
                })
        );

        const transacoesCaixa = cash.payments.map(p => {
            const method = (p.paymentMethod || '').toLowerCase();

            // Busca appt: direto → via session → via paciente (payments sem link explícito)
            const apptId = p.appointment?.toString()
                || (p.session ? sessionToApptIdMap.get(p.session.toString()) : null);
            const appt = apptId ? appointmentsMap.get(apptId) : null;
            const patientId = p.patient?._id?.toString() || p.patient?.toString();

            const notes = (p.notes || '').toLowerCase();
            const desc = (p.description || '').toLowerCase();
            let tipo = 'Particular';
            let servico = 'Sessão';

            const isPackagePayment =
                notes.includes('pacote') || desc.includes('pacote') ||
                p.type === 'package' || p.serviceType === 'package_session' ||
                p.package || appt?.package ||
                (p.session && pkgSessionPrepaidMap.has(p.session.toString()));

            // Pagamentos de pacote só entram no caixa se o appointment foi concluído
            if (isPackagePayment && appt && appt.operationalStatus !== 'completed') {
                return null;
            }

            if (isPackagePayment) {
                tipo = 'Pacote';
                // Usa serviceType real do agendamento; fallback para 'Sessão de Pacote'
                const pkgServiceType = appt?.serviceType || p.serviceType || patientIdToServiceType.get(patientId);
                const serviceMap = { 'evaluation': 'Avaliação', 'session': 'Sessão', 'individual_session': 'Sessão Individual', 'package_session': 'Sessão de Pacote', 'tongue_tie_test': 'Teste da Linguinha', 'neuropsych_evaluation': 'Avaliação Neuropsicológica', 'return': 'Retorno', 'meet': 'Meet', 'alignment': 'Alinhamento' };
                servico = (pkgServiceType && pkgServiceType !== 'package_session')
                    ? (serviceMap[pkgServiceType] || 'Sessão de Pacote')
                    : 'Sessão de Pacote';

                // Pacote pré-pago sendo CONSUMIDO (não é compra do dia nem per-session)
                // → NÃO entra em TRANSAÇÕES (dinheiro entrou quando o pacote foi comprado)
                const isCompraHoje = !!p.package; // pagamento tem ref direta ao pacote = é a compra
                const pkgPaymentType = appt?.package?.paymentType || appt?.package?.model;
                const isSessionPrepaid = p.session ? pkgSessionPrepaidMap.get(p.session.toString()) : false;
                const isPrepaidConsumo = !isCompraHoje && (pkgPaymentType === 'full' || pkgPaymentType === 'prepaid' || isSessionPrepaid === true);

                if (isPrepaidConsumo) return null;
            } else if (notes.includes('convênio') || desc.includes('convenio') || p.type === 'insurance' || p.billingType === 'convenio') {
                tipo = 'Convênio';
                servico = 'Sessão Convênio';
            } else {
                // 🎯 Fonte de verdade: Appointment > Payment > fallback por paciente
                const serviceType = appt?.serviceType || p.serviceType || patientIdToServiceType.get(patientId);
                if (serviceType) {
                    const serviceMap = { 'evaluation': 'Avaliação', 'session': 'Sessão', 'individual_session': 'Sessão Individual', 'package_session': 'Sessão de Pacote', 'tongue_tie_test': 'Teste da Linguinha', 'neuropsych_evaluation': 'Avaliação Neuropsicológica', 'return': 'Retorno', 'meet': 'Meet', 'alignment': 'Alinhamento' };
                    servico = serviceMap[serviceType] || 'Sessão';
                }
            }

            if (method.includes('pix')) qtdPix++;
            else if (method.includes('card') || method.includes('cartao') || method.includes('crédito') || method.includes('debito') || method.includes('credit') || method.includes('debit')) qtdCartao++;
            else if (method.includes('cash') || method.includes('dinheiro')) qtdDinheiro++;

            // 🎯 Fonte de verdade: Appointment (doctor/specialty/sessionType) > Payment > 'Outra'
            const esp = appt?.doctor?.specialty || appt?.specialty || appt?.sessionType || p.specialty || p.sessionType || 'Outra';
            if (!porEspecialidadeCaixa[esp]) porEspecialidadeCaixa[esp] = 0;
            porEspecialidadeCaixa[esp] += p.amount;

            let metodo = 'Outros';
            if (method.includes('pix')) metodo = 'Pix';
            else if (method.includes('dinheiro') || method.includes('cash')) metodo = 'Dinheiro';
            else if (method.includes('cartão') || method.includes('cartao') || method.includes('card') || method.includes('crédito') || method.includes('debito') || method.includes('credit') || method.includes('debit')) metodo = 'Cartão';

            return {
                id: p._id,
                paciente: p.patient?.fullName || p.patientName || 'Paciente não identificado',
                valor: p.amount,
                metodo,
                tipo,
                servico,
                especialidade: appt?.doctor?.specialty || appt?.specialty || appt?.sessionType || p.specialty || p.sessionType || 'Outra',
                profissional: appt?.doctor?.fullName || appt?.professionalName || '-',
                hora: appt?.time || moment(p.createdAt || p.financialDate).format('HH:mm'),
                data: moment(p.financialDate || p.createdAt).format('DD/MM/YYYY'),
                categoria: 'recebido',
                observacao: p.notes || p.description || '-',
                billingType: p.billingType || '-',
                kind: p.kind || '-',
                package: !!p.package || !!appt?.package,
                appointmentStatus: appt?.operationalStatus || '-'
            };
        }).filter(Boolean);

        // Recalcula totais do caixa a partir das transações já filtradas
        const totalCaixaFiltrado = transacoesCaixa.reduce((s, t) => s + t.valor, 0);
        const pixFiltrado = transacoesCaixa.filter(t => t.metodo === 'Pix').reduce((s, t) => s + t.valor, 0);
        const dinheiroFiltrado = transacoesCaixa.filter(t => t.metodo === 'Dinheiro').reduce((s, t) => s + t.valor, 0);
        const cartaoFiltrado = transacoesCaixa.filter(t => t.metodo === 'Cartão').reduce((s, t) => s + t.valor, 0);
        const outrosFiltrado = transacoesCaixa.filter(t => !['Pix', 'Dinheiro', 'Cartão'].includes(t.metodo)).reduce((s, t) => s + t.valor, 0);
        const countCaixaFiltrado = transacoesCaixa.length;

        // ========== DESPESAS DO DIA ==========
        let totalDespesas = 0;
        const despesasPorCategoria = {};
        expenses.forEach(e => {
            totalDespesas += e.amount;
            const cat = e.category || 'other';
            if (!despesasPorCategoria[cat]) despesasPorCategoria[cat] = 0;
            despesasPorCategoria[cat] += e.amount;
        });
        const saldoLiquido = totalCaixaFiltrado - totalDespesas;

        // ========== PRODUÇÃO DO DIA ==========
        let recebidoProducao = 0;
        let aReceber = 0;
        const porEspecialidade = {};
        const pendentesCobranca = [];

        const transacoesProducao = production.sessions.map(s => {
            const valor = s.sessionValue > 0
                ? s.sessionValue
                : s.package?.sessionValue > 0
                    ? s.package.sessionValue
                    : (s.package?.totalValue && s.package?.totalSessions)
                        ? Math.round(s.package.totalValue / s.package.totalSessions)
                        : 0;

            const patient = patientMap.get(s.patient?.toString());
            const doctor = doctorsMap.get(s.doctor?.toString());
            const appt = s.appointmentId ? appointmentsMap.get(s.appointmentId.toString()) : null;

            const patientName = patient?.fullName || appt?.patientName || appt?.patientInfo?.fullName || 'Paciente não identificado';
            const isConvenio = (s.paymentMethod || '').toLowerCase() === 'convenio' || s.paymentOrigin === 'convenio';
            const isPacote = !!s.package;

            // Detecta pacote pré-pago: dinheiro entrou na compra, sessão consumida = receita realizada
            const pkgPayType = appt?.package?.paymentType || appt?.package?.model;
            const isPrepaidPkg = isPacote && (pkgPayType === 'full' || pkgPayType === 'prepaid');

            const esp = doctor?.specialty || appt?.specialty || 'Outra';
            if (!porEspecialidade[esp]) {
                porEspecialidade[esp] = { total: 0, quantidade: 0, recebido: 0, pendente: 0 };
            }
            porEspecialidade[esp].total += valor;
            porEspecialidade[esp].quantidade += 1;

            // Pacote pré-pago: sessão consumida = "paga" (money came in at package purchase)
            const foiPago = s.isPaid === true || s.paymentStatus === 'paid' || s.paymentStatus === 'package_paid' || isPrepaidPkg;
            const categoria = isConvenio ? 'recebido' : (foiPago ? 'recebido' : 'a_receber');

            if (!foiPago && !isConvenio) {
                aReceber += valor;
                porEspecialidade[esp].pendente += valor;
                pendentesCobranca.push({
                    id: s._id,
                    paciente: patientName,
                    telefone: patient?.phone || appt?.patientInfo?.phone || '-',
                    valor,
                    horario: appt?.time || '',
                    especialidade: esp,
                    professional: doctor?.fullName || '-',
                    tipo: isConvenio ? 'Convênio' : (isPacote ? 'Pacote' : 'Particular'),
                    convenio: isConvenio ? 'Convênio' : null
                });
            } else {
                porEspecialidade[esp].recebido += valor;
                recebidoProducao += valor;
            }

            return {
                id: s._id,
                paciente: patientName,
                valor,
                metodo: s.paymentMethod || (isConvenio ? 'Convênio' : 'Pendente'),
                tipo: isConvenio ? 'Convênio' : (isPacote ? 'Pacote' : 'Particular'),
                servico: appt?.serviceType === 'evaluation' ? 'Avaliação' :
                        appt?.serviceType === 'package_session' ? 'Sessão de Pacote' :
                        appt?.serviceType === 'convenio_session' ? 'Sessão Convênio' :
                        appt?.serviceType === 'tongue_tie_test' ? 'Teste da Linguinha' :
                        appt?.serviceType === 'neuropsych_evaluation' ? 'Avaliação Neuropsicológica' :
                        appt?.serviceType === 'return' ? 'Retorno' : 'Sessão',
                especialidade: esp,
                hora: appt?.time || '',
                data: moment(s.date).format('DD/MM/YYYY'),
                status: appt?.operationalStatus || 'completed',
                categoria,
                professional: doctor?.fullName || '-',
                paymentModel: isPacote ? (isPrepaidPkg ? 'prepaid' : 'per_session') : null
            };
        });

        // Comparativos e métricas
        const variacao = yesterdayTotal > 0
            ? ((totalCaixaFiltrado - yesterdayTotal) / yesterdayTotal * 100).toFixed(1)
            : totalCaixaFiltrado > 0 ? 100 : 0;
        const vsMediaMes = mediaDiariaMes > 0
            ? ((totalCaixaFiltrado - mediaDiariaMes) / mediaDiariaMes * 100).toFixed(1)
            : 0;
        const ticketMedio = countCaixaFiltrado > 0 ? (totalCaixaFiltrado / countCaixaFiltrado) : 0;
        const ticketMedioProducao = production.count > 0 ? (production.total / production.count) : 0;
        const taxaEficiencia = production.total > 0 ? ((recebidoProducao / production.total) * 100).toFixed(1) : 0;

        const especialidadesResumo = Object.entries(porEspecialidade).map(([nome, dados]) => ({
            nome,
            total: dados.total,
            quantidade: dados.quantidade,
            recebido: dados.recebido,
            pendente: dados.pendente,
            ticketMedio: dados.quantidade > 0 ? (dados.total / dados.quantidade).toFixed(2) : 0
        })).sort((a, b) => b.total - a.total);

        res.json({
            success: true,
            data: {
                data: targetDate,
                caixa: {
                    total: totalCaixaFiltrado,
                    pix: pixFiltrado,
                    dinheiro: dinheiroFiltrado,
                    cartao: cartaoFiltrado,
                    outros: outrosFiltrado,
                    qtdPix,
                    qtdDinheiro,
                    qtdCartao
                },
                porTipo: (() => {
                    const acc = { particular: 0, pacote: 0, convenio: 0, liminar: 0 };
                    for (const t of transacoesCaixa) {
                        if (t.tipo === 'Particular') acc.particular += t.valor;
                        else if (t.tipo === 'Pacote') acc.pacote += t.valor;
                        else if (t.tipo === 'Convênio') acc.convenio += t.valor;
                        else if (t.tipo === 'Liminar') acc.liminar += t.valor;
                    }
                    return acc;
                })(),
                porEspecialidade: porEspecialidadeCaixa,
                despesas: {
                    total: totalDespesas,
                    porCategoria: despesasPorCategoria,
                    quantidade: expenses.length
                },
                saldo: {
                    bruto: totalCaixaFiltrado,
                    liquido: saldoLiquido,
                    despesaTotal: totalDespesas
                },
                producao: {
                    total: production.total,
                    aReceber,
                    recebido: recebidoProducao,
                    quantidadeAtendimentos: production.count,
                    ticketMedio: ticketMedioProducao,
                    taxaEficiencia: parseFloat(taxaEficiencia),
                    porTipo: {
                        particular: production.particular,
                        pacote: production.pacote,
                        convenio: production.convenio
                    },
                    porEspecialidade: especialidadesResumo
                },
                pendentesCobranca: pendentesCobranca.sort((a, b) => a.horario.localeCompare(b.horario)),
                pacotesAtendidos: transacoesProducao.filter(t => t.tipo === 'Pacote').map(t => ({
                    id: t.id,
                    horario: t.hora,
                    paciente: t.paciente,
                    servico: t.servico,
                    especialidade: t.especialidade,
                    professional: t.professional,
                    valor: t.valor,
                    statusPagamento: t.categoria === 'recebido' ? 'Pago' : 'Pendente',
                    paymentModel: t.paymentModel
                })),
                conveniosAtendidos: transacoesProducao.filter(t => t.tipo === 'Convênio').map(t => ({
                    id: t.id,
                    horario: t.hora,
                    paciente: t.paciente,
                    servico: t.servico,
                    especialidade: t.especialidade,
                    professional: t.professional,
                    valor: t.valor,
                    convenio: t.metodo === 'Convênio' ? 'Convênio' : t.metodo
                })),
                comparativos: {
                    ontem: yesterdayTotal,
                    variacaoVsOntem: parseFloat(variacao),
                    mediaDiariaMes: parseFloat(mediaDiariaMes.toFixed(2)),
                    vsMediaMes: parseFloat(vsMediaMes),
                    totalAcumuladoMes: totalMes,
                    projecaoMes: parseFloat(projecaoMes.toFixed(2)),
                    diasDecorridos: dayOfMonth
                },
                estatisticas: {
                    quantidade: countCaixaFiltrado,
                    quantidadeAtendimentos: production.count,
                    ticketMedio,
                    ontem: yesterdayTotal
                },
                transacoes: transacoesCaixa,
                transacoesProducao: transacoesProducao
            }
        });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/v2/cashflow/month?month=2026-04
// Retorna resumo diário do mês inteiro em UMA requisição (substitui 30 chamadas diárias)
router.get('/month', auth, async (req, res) => {
    try {
        const { month } = req.query;
        if (!month || !/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({ success: false, error: 'Parâmetro month obrigatório (formato: YYYY-MM)' });
        }

        const [year, monthNum] = month.split('-').map(Number);
        const monthStart = moment.tz([year, monthNum - 1, 1], 'America/Sao_Paulo').startOf('day');
        const monthEnd = moment.tz([year, monthNum - 1, 1], 'America/Sao_Paulo').endOf('month').endOf('day');
        const start = monthStart.clone().utc().toDate();
        const end = monthEnd.clone().utc().toDate();

        // 🎯 Fonte única de verdade V2
        const [cashMap, productionResult] = await Promise.all([
            unifiedFinancialService.calculateCashByDay(start, end),
            unifiedFinancialService.calculateProductionByDay(start, end)
        ]);

        const producaoMap = productionResult.map;

        // Preenche todos os dias do mês
        const daysInMonth = monthStart.daysInMonth();
        const result = [];
        for (let d = 1; d <= daysInMonth; d++) {
            const dayStr = moment.tz([year, monthNum - 1, d], 'America/Sao_Paulo').format('YYYY-MM-DD');
            const caixaData = cashMap.get(dayStr);
            const prodData = producaoMap.get(dayStr);
            result.push({
                date: dayStr,
                caixa: caixaData?.caixa || 0,
                producao: prodData?.producao || 0,
                atendimentos: prodData?.atendimentos || 0
            });
        }

        res.json({
            success: true,
            month,
            data: result
        });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
