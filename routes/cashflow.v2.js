// routes/cashflow.v2.js - CAIXA REAL FECHADO PARA PRODUÇÃO
import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Expense from '../models/Expense.js';

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
        // 🎯 BUSCA PAGAMENTOS DO DIA — FONTES ÚNICAS DE VERDADE
        // ============================================================
        const paymentBaseFilter = {
            status: { $in: ['paid', 'completed', 'confirmed'] },
            amount: { $gte: 1 }
        };

        const payments = await Payment.find({
            ...paymentBaseFilter,
            $or: [
                { financialDate: { $gte: start, $lte: end } },
                { financialDate: { $exists: false }, paymentDate: { $gte: start, $lte: end } },
                { financialDate: null, paymentDate: { $gte: start, $lte: end } }
            ]
        }).populate('patient', 'fullName').lean();

        // ============================================================
        // 🎯 BUSCA DESPESAS DO DIA
        // ============================================================
        const expenses = await Expense.find({
            date: targetDate,
            status: { $nin: ['canceled', 'cancelado'] }
        }).lean();

        // ============================================================
        // 🎯 BUSCA ATENDIMENTOS DO DIA (Produção)
        // ============================================================
        const appointments = await Appointment.find({
            date: { $gte: start, $lt: end },
            operationalStatus: { $in: ['confirmed', 'completed', 'scheduled'] },
            isDeleted: { $ne: true },
            patient: { $exists: true, $ne: null }
        }).populate('patient', 'fullName').populate('doctor', 'fullName specialty').populate('package', 'paymentType sessionValue totalValue totalSessions model').lean();

        // ============================================================
        // 🔧 RESOLVE NOMES DE PACIENTES E FILTRA DELETADOS
        // ============================================================
        const patientIdsToFetch = [];
        const patientMap = new Map();
        const patientIdsDoDia = new Set();

        for (const a of appointments) {
            const patientId = a.patient?._id?.toString() || a.patient?.toString();
            if (patientId) patientIdsDoDia.add(patientId);

            if (a.patient?.fullName && a.patient.fullName !== 'N/A') {
                patientMap.set(patientId, a.patient.fullName);
            }
            if ((!a.patientName || a.patientName === 'N/A') && a.patient && !patientMap.has(patientId)) {
                patientIdsToFetch.push(patientId);
            }
        }

        const patientIdsArray = Array.from(patientIdsDoDia);

        // 💰 Mapa de pagamentos por APPOINTMENT (fonte única de verdade para "foi pago")
        const appointmentPaymentMap = new Map();
        for (const p of payments) {
            const apptId = p.appointment?.toString();
            if (apptId) {
                appointmentPaymentMap.set(apptId, p);
            }
        }

        // Filtra pacientes soft-deleted
        const Patient = (await import('../models/Patient.js')).default;
        const validPatients = await Patient.find({
            _id: { $in: patientIdsArray },
            isDeleted: { $ne: true }
        }).select('_id fullName').lean();

        const validPatientIdsSet = new Set(validPatients.map(p => p._id.toString()));
        for (const p of validPatients) patientMap.set(p._id.toString(), p.fullName);

        const missingValidIds = patientIdsToFetch.filter(id => validPatientIdsSet.has(id));
        if (missingValidIds.length > 0) {
            const patients = await Patient.find({ _id: { $in: missingValidIds } }).select('_id fullName').lean();
            for (const p of patients) patientMap.set(p._id.toString(), p.fullName);
        }

        // Appointments válidos (paciente não deletado)
        const validAppointments = appointments.filter(a => {
            const pid = a.patient?._id?.toString() || a.patient?.toString();
            return validPatientIdsSet.has(pid);
        });

        // Mapa de horário do appointment (transações de caixa mostram horário do atendimento)
        const appointmentTimeMap = new Map();
        for (const a of appointments) {
            appointmentTimeMap.set(a._id.toString(), a.time);
        }

        // ============================================================
        // 🎯 COMPARATIVOS: ONTEM E MÊS
        // ============================================================
        const yesterdayStart = moment.tz(targetDate, 'America/Sao_Paulo').subtract(1, 'day').startOf('day').utc().toDate();
        const yesterdayEnd = moment.tz(targetDate, 'America/Sao_Paulo').subtract(1, 'day').endOf('day').utc().toDate();

        const yesterdayPayments = await Payment.find({
            ...paymentBaseFilter,
            financialDate: { $gte: yesterdayStart, $lte: yesterdayEnd }
        }).lean();
        const yesterdayTotal = yesterdayPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

        const monthStart = moment.tz(targetDate, 'America/Sao_Paulo').startOf('month').utc().toDate();
        const monthPayments = await Payment.find({
            ...paymentBaseFilter,
            createdAt: { $gte: monthStart, $lte: end }
        }).lean();
        const totalMes = monthPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
        const dayOfMonth = moment.tz(targetDate, 'America/Sao_Paulo').date();
        const mediaDiariaMes = dayOfMonth > 0 ? totalMes / dayOfMonth : 0;
        const projecaoMes = mediaDiariaMes * 30;

        // ============================================================
        // ========== CAIXA - DINHEIRO QUE ENTROU ==========
        // ============================================================
        let totalCaixa = 0;
        let pix = 0, dinheiro = 0, cartao = 0, outros = 0;
        let qtdPix = 0, qtdDinheiro = 0, qtdCartao = 0;
        let particularCaixa = 0, pacoteCaixa = 0, convenioCaixa = 0;
        const porEspecialidadeCaixa = {};

        // 1) Filtra testes e consumo de pacote (NÃO é entrada de caixa)
        let validPayments = payments.filter(p => {
            const nome = (p.patient?.fullName || p.patientName || '').toLowerCase();
            if (nome.includes('teste') || nome.includes('test ')) return false;
            if (p.isFromPackage === true) return false; // 📦 Dinheiro já entrou na compra do pacote
            return true;
        });

        // 2) Exclui payments cujo appointment foi deletado ou cancelado
        //    e blindagem contra duplicidade de pacote já quitado
        const paymentAppointmentIds = validPayments
            .map(p => p.appointment?.toString())
            .filter(Boolean);
        if (paymentAppointmentIds.length > 0) {
            const paymentAppointments = await Appointment.find({
                _id: { $in: paymentAppointmentIds }
            }).select('_id isDeleted operationalStatus serviceType package').lean();
            const existingAppointmentsMap = new Map(
                paymentAppointments.map(a => [a._id.toString(), a])
            );

            validPayments = validPayments.filter(p => {
                const apptId = p.appointment?.toString();
                if (!apptId) return true; // Payment sem appointment (ajuste, etc.)
                const appt = existingAppointmentsMap.get(apptId);
                // Hard-deleted (não achou) OU soft-deleted/cancelado = exclui do caixa
                if (!appt) return false;
                if (appt.isDeleted === true) return false;
                if (['canceled', 'cancelled', 'cancelado'].includes(appt.operationalStatus)) return false;
                return true;
            });

            // 🛡️ BLINDAGEM PACOTE: exclui payments de sessões de pacote já quitado
            const packageIdsFromAppointments = Array.from(new Set(
                paymentAppointments
                    .filter(a => a.package && a.serviceType === 'package_session')
                    .map(a => a.package.toString())
            ));
            if (packageIdsFromAppointments.length > 0) {
                const packages = await Package.find({
                    _id: { $in: packageIdsFromAppointments }
                }).select('_id sessionsDone totalPaid sessionValue paymentType').lean();
                const packageMap = new Map(packages.map(p => [p._id.toString(), p]));

                validPayments = validPayments.filter(p => {
                    const apptId = p.appointment?.toString();
                    const appt = existingAppointmentsMap.get(apptId);
                    if (!appt || appt.serviceType !== 'package_session' || !appt.package) return true;

                    const pkg = packageMap.get(appt.package.toString());
                    if (!pkg) return true;

                    // Pacote per-session: cada sessão é paga no dia — nunca excluir do caixa
                    if (pkg.paymentType === 'per-session') return true;

                    const dividaTotal = (pkg.sessionsDone || 0) * (pkg.sessionValue || 0);
                    const totalPaid = pkg.totalPaid || 0;

                    if (totalPaid >= dividaTotal) {
                        console.log(`[CashflowV2] Excluindo payment ${p._id} do caixa: pacote já cobre sessões (${totalPaid} >= ${dividaTotal})`);
                        return false;
                    }
                    return true;
                });
            }
        }

        const transacoesCaixa = validPayments.map(p => {
            totalCaixa += p.amount;

            // 💰 FONTES DA VERDADE: Payment.paymentMethod
            const method = (p.paymentMethod || '').toLowerCase();
            if (method.includes('pix')) { pix += p.amount; qtdPix++; }
            else if (method.includes('card') || method.includes('cartao') || method.includes('crédito') || method.includes('debito') || method.includes('credit') || method.includes('debit')) { cartao += p.amount; qtdCartao++; }
            else if (method.includes('cash') || method.includes('dinheiro')) { dinheiro += p.amount; qtdDinheiro++; }
            else { outros += p.amount; }

            // Por tipo
            const notes = (p.notes || '').toLowerCase();
            const desc = (p.description || '').toLowerCase();
            if (notes.includes('pacote') || desc.includes('pacote') || p.type === 'package' || p.serviceType === 'package_session') pacoteCaixa += p.amount;
            else if (notes.includes('convênio') || desc.includes('convenio') || p.type === 'insurance' || p.billingType === 'convenio') convenioCaixa += p.amount;
            else particularCaixa += p.amount;

            // Especialidade
            const esp = p.specialty || p.sessionType || 'Outra';
            if (!porEspecialidadeCaixa[esp]) porEspecialidadeCaixa[esp] = 0;
            porEspecialidadeCaixa[esp] += p.amount;

            // Método padronizado para exibição
            let metodo = 'Outros';
            if (method.includes('pix')) metodo = 'Pix';
            else if (method.includes('dinheiro') || method.includes('cash')) metodo = 'Dinheiro';
            else if (method.includes('cartão') || method.includes('cartao') || method.includes('card') || method.includes('crédito') || method.includes('debito') || method.includes('credit') || method.includes('debit')) metodo = 'Cartão';

            // Tipo de serviço
            let tipo = 'Particular';
            let servico = 'Sessão';
            if (notes.includes('pacote') || desc.includes('pacote') || p.serviceType === 'package_session') {
                tipo = 'Pacote';
                servico = notes.includes('avaliação') ? 'Avaliação (Pacote)' :
                         notes.includes('teste') ? 'Teste (Pacote)' : 'Sessão de Pacote';
            } else if (notes.includes('convênio') || desc.includes('convenio') || p.type === 'insurance' || p.billingType === 'convenio') {
                tipo = 'Convênio';
                servico = 'Sessão Convênio';
            } else if (p.serviceType) {
                const serviceMap = {
                    'evaluation': 'Avaliação',
                    'session': 'Sessão',
                    'individual_session': 'Sessão Individual',
                    'package_session': 'Sessão de Pacote',
                    'tongue_tie_test': 'Teste da Linguinha',
                    'neuropsych_evaluation': 'Avaliação Neuropsicológica',
                    'return': 'Retorno',
                    'meet': 'Meet',
                    'alignment': 'Alinhamento'
                };
                servico = serviceMap[p.serviceType] || 'Sessão';
            }

            return {
                id: p._id,
                paciente: p.patient?.fullName || p.patientName || 'Paciente não identificado',
                valor: p.amount,
                metodo,
                tipo,
                servico,
                especialidade: p.specialty || p.sessionType || '-',
                hora: (p.appointment && appointmentTimeMap.get(p.appointment.toString())) || moment(p.financialDate || p.createdAt).format('HH:mm'),
                data: moment(p.financialDate || p.createdAt).format('DD/MM/YYYY'),
                categoria: 'recebido'
            };
        });

        // ========== DESPESAS DO DIA ==========
        let totalDespesas = 0;
        const despesasPorCategoria = {};
        expenses.forEach(e => {
            totalDespesas += e.amount;
            const cat = e.category || 'other';
            if (!despesasPorCategoria[cat]) despesasPorCategoria[cat] = 0;
            despesasPorCategoria[cat] += e.amount;
        });
        const saldoLiquido = totalCaixa - totalDespesas;

        // ========== PRODUÇÃO DO DIA ==========
        // Para hoje: só conta sessões cuja hora já passou (produção real)
        const nowBrasilia = moment.tz('America/Sao_Paulo');
        const isToday = targetDate === nowBrasilia.format('YYYY-MM-DD');
        const currentTimeStr = nowBrasilia.format('HH:mm');

        const appointmentsProducao = isToday
            ? validAppointments.filter(a => !a.time || a.time <= currentTimeStr)
            : validAppointments;

        let totalProducao = 0;
        let recebidoProducao = 0;
        let aReceber = 0;
        let producaoParticular = 0, producaoConvenio = 0, producaoPacote = 0;
        const porEspecialidade = {};
        const pendentesCobranca = [];

        const transacoesProducao = appointmentsProducao.map(a => {
            const pkgSessionValue = a.package?.sessionValue || (a.package?.totalValue && a.package?.totalSessions ? Math.round(a.package.totalValue / a.package.totalSessions) : 0);
            const valor = a.sessionValue || pkgSessionValue || 0;
            totalProducao += valor;

            const patientId = a.patient?._id?.toString() || a.patient?.toString();
            const patientName = a.patient?.fullName ||
                               a.patientName ||
                               a.patientInfo?.fullName ||
                               patientMap.get(patientId) ||
                               'Paciente não identificado';

            const billingType = a.billingType || 'particular';
            const isConvenio = billingType === 'convenio' ||
                              (a.insuranceProvider && a.insuranceProvider.trim() !== '');
            const isPacote = a.serviceType === 'package_session';

            if (isConvenio) producaoConvenio += valor;
            else if (isPacote) producaoPacote += valor;
            else producaoParticular += valor;

            const esp = a.doctor?.specialty || a.specialty || 'Outra';
            if (!porEspecialidade[esp]) {
                porEspecialidade[esp] = { total: 0, quantidade: 0, recebido: 0, pendente: 0 };
            }
            porEspecialidade[esp].total += valor;
            porEspecialidade[esp].quantidade += 1;

            // Verificação real de pagamento: Payment vinculado ao appointment
            const temPaymentNoAppointment = !!appointmentPaymentMap.get(a._id.toString());
            const packagePaymentType = a.package?.paymentType || null;
            // per_session / per-session: cada sessão paga individualmente → não conta como pago via pacote
            const isPerSession = packagePaymentType === 'per_session' || packagePaymentType === 'per-session';
            const foiPagoViaPacote = a.paymentStatus === 'package_paid'
                || (isPacote && !isPerSession);
            const foiPago = temPaymentNoAppointment || foiPagoViaPacote;
            const categoria = foiPago ? 'recebido' : 'a_receber';

            if (!foiPago) {
                aReceber += valor;
                porEspecialidade[esp].pendente += valor;
                pendentesCobranca.push({
                    id: a._id,
                    paciente: patientName,
                    telefone: a.patientInfo?.phone || a.patient?.phone || '-',
                    valor,
                    horario: a.time,
                    especialidade: esp,
                    professional: a.doctor?.fullName || a.professionalName || '-',
                    tipo: isConvenio ? 'Convênio' : (isPacote ? 'Pacote' : 'Particular'),
                    convenio: a.insuranceProvider || null
                });
            } else {
                porEspecialidade[esp].recebido += valor;
                recebidoProducao += valor;
            }

            return {
                id: a._id,
                paciente: patientName,
                valor,
                metodo: a.paymentMethod || (isConvenio ? 'Convênio' : 'Pendente'),
                tipo: isConvenio ? 'Convênio' : (isPacote ? 'Pacote' : 'Particular'),
                servico: a.serviceType === 'evaluation' ? 'Avaliação' :
                        a.serviceType === 'package_session' ? 'Sessão de Pacote' :
                        a.serviceType === 'tongue_tie_test' ? 'Teste da Linguinha' :
                        a.serviceType === 'neuropsych_evaluation' ? 'Avaliação Neuropsicológica' :
                        a.serviceType === 'return' ? 'Retorno' : 'Sessão',
                especialidade: a.doctor?.specialty || a.specialty || '-',
                hora: a.time,
                data: moment(a.date).format('DD/MM/YYYY'),
                status: a.operationalStatus,
                categoria,
                professional: a.doctor?.fullName || a.professionalName || '-',
                paymentModel: isPacote
                    ? (a.package?.model === 'prepaid' || a.package?.paymentType === 'full' ? 'prepaid' : 'per_session')
                    : null
            };
        });

        // Comparativos e métricas
        const variacao = yesterdayTotal > 0
            ? ((totalCaixa - yesterdayTotal) / yesterdayTotal * 100).toFixed(1)
            : totalCaixa > 0 ? 100 : 0;
        const vsMediaMes = mediaDiariaMes > 0
            ? ((totalCaixa - mediaDiariaMes) / mediaDiariaMes * 100).toFixed(1)
            : 0;
        const ticketMedio = validPayments.length > 0 ? (totalCaixa / validPayments.length) : 0;
        const ticketMedioProducao = validAppointments.length > 0 ? (totalProducao / validAppointments.length) : 0;
        const taxaEficiencia = totalProducao > 0 ? ((recebidoProducao / totalProducao) * 100).toFixed(1) : 0;

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
                    total: totalCaixa,
                    pix,
                    dinheiro,
                    cartao,
                    outros,
                    qtdPix,
                    qtdDinheiro,
                    qtdCartao
                },
                porTipo: {
                    particular: particularCaixa,
                    pacote: pacoteCaixa,
                    convenio: convenioCaixa
                },
                porEspecialidade: porEspecialidadeCaixa,
                despesas: {
                    total: totalDespesas,
                    porCategoria: despesasPorCategoria,
                    quantidade: expenses.length
                },
                saldo: {
                    bruto: totalCaixa,
                    liquido: saldoLiquido,
                    despesaTotal: totalDespesas
                },
                producao: {
                    total: totalProducao,
                    aReceber,
                    recebido: recebidoProducao,
                    quantidadeAtendimentos: appointmentsProducao.length,
                    ticketMedio: ticketMedioProducao,
                    taxaEficiencia: parseFloat(taxaEficiencia),
                    porTipo: {
                        particular: producaoParticular,
                        pacote: producaoPacote,
                        convenio: producaoConvenio
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
                    quantidade: validPayments.length,
                    quantidadeAtendimentos: appointmentsProducao.length,
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

export default router;
