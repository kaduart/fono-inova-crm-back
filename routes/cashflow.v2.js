// routes/cashflow.v2.js - CAIXA REAL COMPLETO
import express from 'express';
import moment from 'moment-timezone';
import { auth } from '../middleware/auth.js';
import Payment from '../models/Payment.js';
import Appointment from '../models/Appointment.js';
import Expense from '../models/Expense.js';

const router = express.Router();

// GET /api/v2/cashflow?date=2026-04-10
router.get('/', auth, async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date || moment.tz('America/Sao_Paulo').format('YYYY-MM-DD');
        
        // Range do dia em Brasília (UTC-3)
        // O dia 10/04 em Brasília vai das 03:00 UTC do dia 10 até 02:59:59 UTC do dia 11
        const start = moment.tz(targetDate, 'America/Sao_Paulo').startOf('day').utc().toDate();
        const end = moment.tz(targetDate, 'America/Sao_Paulo').endOf('day').utc().toDate();
        
        // 🎯 Busca PAGAMENTOS DO DIA (APENAS valores >= 1 real - ignora testes)
        // 💰 Usa financialDate como fonte única de verdade
        // financialDate é sempre preenchida quando o pagamento entra no caixa
        const payments = await Payment.find({
            status: { $in: ['paid', 'completed', 'confirmed'] },
            amount: { $gte: 1 },
            financialDate: { $gte: start, $lte: end }
        }).populate('patient', 'fullName').lean();
        
        // 🎯 Busca DESPESAS DO DIA
        const expenses = await Expense.find({
            date: targetDate,
            status: { $nin: ['canceled', 'cancelado'] }
        }).lean();
        
        // 🎯 Busca ATENDIMENTOS DO DIA (Produção)
        // Appointments usam o campo 'date' que é Date em UTC
        const appointments = await Appointment.find({
            date: { $gte: start, $lt: end },
            operationalStatus: { $in: ['confirmed', 'completed', 'scheduled'] }
        }).populate('patient', 'fullName').populate('doctor', 'fullName specialty').lean();
        
        // 🔧 CORREÇÃO: Buscar nomes de pacientes que não foram populados ou têm patientName = 'N/A'
        const patientIdsToFetch = [];
        const patientMap = new Map();
        const patientIdsDoDia = new Set(); // Para buscar pagamentos
        
        for (const a of appointments) {
            const patientId = a.patient?._id?.toString() || a.patient?.toString();
            if (patientId) {
                patientIdsDoDia.add(patientId);
            }
            
            // Se tem patient populado, usa ele
            if (a.patient?.fullName && a.patient.fullName !== 'N/A') {
                patientMap.set(patientId, a.patient.fullName);
            }
            // Se não tem nome válido, precisa buscar
            if ((!a.patientName || a.patientName === 'N/A') && a.patient) {
                if (patientId && !patientMap.has(patientId)) {
                    patientIdsToFetch.push(patientId);
                }
            }
        }
        
        // 🔧 BUSCAR TODOS OS PAGAMENTOS DOS PACIENTES DO DIA
        // Isso inclui pacotes pagos anteriormente e pagamentos recentes
        const patientIdsArray = Array.from(patientIdsDoDia);
        const allPaymentsForPatients = await Payment.find({
            patient: { $in: patientIdsArray },
            status: { $in: ['paid', 'completed', 'confirmed'] }
        }).select('patient amount createdAt').lean();
        
        // Criar mapa de pacientes que já pagaram algo
        const patientPaymentMap = new Map();
        for (const p of allPaymentsForPatients) {
            const pid = p.patient?.toString();
            if (!patientPaymentMap.has(pid)) {
                patientPaymentMap.set(pid, []);
            }
            patientPaymentMap.get(pid).push(p);
        }
        
        // Busca pacientes faltantes em uma única query
        if (patientIdsToFetch.length > 0) {
            const Patient = (await import('../models/Patient.js')).default;
            const patients = await Patient.find({
                _id: { $in: patientIdsToFetch }
            }).select('_id fullName').lean();
            
            for (const p of patients) {
                patientMap.set(p._id.toString(), p.fullName);
            }
        }
        
        // 🎯 Busca ONTEM para comparação
        const yesterdayStart = moment.tz(targetDate, 'America/Sao_Paulo').subtract(1, 'day').startOf('day').utc().toDate();
        const yesterdayEnd = moment.tz(targetDate, 'America/Sao_Paulo').subtract(1, 'day').endOf('day').utc().toDate();
        
        const yesterdayPayments = await Payment.find({
            status: { $in: ['paid', 'completed', 'confirmed'] },
            amount: { $gte: 1 },
            financialDate: { $gte: yesterdayStart, $lte: yesterdayEnd }
        }).lean();
        
        const yesterdayTotal = yesterdayPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
        
        // 🎯 Busca MÊS ATUAL para média e projeção
        const monthStart = moment.tz(targetDate, 'America/Sao_Paulo').startOf('month').utc().toDate();
        const monthPayments = await Payment.find({
            status: { $in: ['paid', 'completed', 'confirmed'] },
            amount: { $gte: 1 },
            createdAt: { $gte: monthStart, $lte: end }
        }).lean();
        
        const totalMes = monthPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
        const dayOfMonth = moment.tz(targetDate, 'America/Sao_Paulo').date();
        const mediaDiariaMes = dayOfMonth > 0 ? totalMes / dayOfMonth : 0;
        const projecaoMes = mediaDiariaMes * 30;
        
        // ========== CAIXA - DINHEIRO QUE ENTROU ==========
        let totalCaixa = 0;
        let pix = 0, dinheiro = 0, cartao = 0, outros = 0;
        let qtdPix = 0, qtdDinheiro = 0, qtdCartao = 0;
        let particularCaixa = 0, pacoteCaixa = 0, convenioCaixa = 0;
        
        // Por especialidade no caixa
        const porEspecialidadeCaixa = {};
        
        const transacoesCaixa = payments.map(p => {
            totalCaixa += p.amount;
            
            // Por método
            const method = (p.paymentMethod || '').toLowerCase();
            if (method.includes('pix')) { pix += p.amount; qtdPix++; }
            else if (method.includes('card') || method.includes('cartao') || method.includes('crédito') || method.includes('debito')) { cartao += p.amount; qtdCartao++; }
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
            
            // Determina método de pagamento padronizado
            let metodo = 'Outros';
            if (method.includes('pix')) metodo = 'Pix';
            else if (method.includes('dinheiro') || method.includes('cash')) metodo = 'Dinheiro';
            else if (method.includes('cartão') || method.includes('cartao') || method.includes('card') || method.includes('crédito') || method.includes('debito')) metodo = 'Cartão';
            
            // Determina tipo de serviço
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
                metodo: metodo,
                tipo: tipo,
                servico: servico,
                especialidade: p.specialty || p.sessionType || '-',
                hora: moment(p.financialDate || p.createdAt).format('HH:mm'),
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
        
        // ========== PRODUÇÃO DO DIA - TODOS ATENDIMENTOS ==========
        let totalProducao = 0;
        let aReceber = 0;
        let producaoParticular = 0, producaoConvenio = 0, producaoPacote = 0;
        
        // Por especialidade
        const porEspecialidade = {};
        
        // Pendentes de cobrança
        const pendentesCobranca = [];
        
        const transacoesProducao = appointments.map(a => {
            const valor = a.sessionValue || 0;
            totalProducao += valor;
            
            // 🔧 CORREÇÃO: Resolve o nome do paciente com fallback
            const patientId = a.patient?._id?.toString() || a.patient?.toString();
            const patientName = a.patient?.fullName || 
                               a.patientName || 
                               a.patientInfo?.fullName || 
                               patientMap.get(patientId) || 
                               'Paciente não identificado';
            
            const billingType = a.billingType || 'particular';
            // 🏥 Convênio: billingType explícito OU insuranceProvider preenchido
            const isConvenio = billingType === 'convenio' || 
                              (a.insuranceProvider && a.insuranceProvider.trim() !== '');
            // 📦 Pacote: APENAS quando serviceType é explicitamente 'package_session'
            // O campo 'package' pode existir em outros tipos de atendimento (ex: avaliação que gerou pacote)
            const isPacote = a.serviceType === 'package_session';
            
            if (isConvenio) producaoConvenio += valor;
            else if (isPacote) producaoPacote += valor;
            else producaoParticular += valor;
            
            // Por especialidade
            const esp = a.doctor?.specialty || a.specialty || 'Outra';
            if (!porEspecialidade[esp]) {
                porEspecialidade[esp] = { total: 0, quantidade: 0, recebido: 0, pendente: 0 };
            }
            porEspecialidade[esp].total += valor;
            porEspecialidade[esp].quantidade += 1;
            
            // 🔧 VERIFICAÇÃO REAL DE PAGAMENTO
            // O paymentStatus do appointment pode estar desatualizado
            // Verificamos: 1) payment no appointment, 2) pagamentos do paciente no sistema
            const temPaymentNoAppointment = a.payment && a.paymentStatus === 'paid';
            const pidForPayment = a.patient?._id?.toString() || a.patient?.toString();
            
            // ⚠️ CORREÇÃO: Verificar se tem pagamento ESPECÍFICO para este appointment
            // ou se é pacote pre-pago (package_paid)
            const pagamentosDoPaciente = patientPaymentMap.get(pidForPayment) || [];
            
            // Verifica se algum pagamento deste paciente foi feito HOJE (mesmo dia do appointment)
            // ou se o appointment tem package_paid
            const foiPagoHoje = pagamentosDoPaciente.some(p => {
                const dataPagamento = moment(p.financialDate || p.createdAt).tz('America/Sao_Paulo').format('YYYY-MM-DD');
                return dataPagamento === targetDate;
            });
            
            // Se é pacote ou convênio com package_paid, já foi pago
            const foiPagoViaPacote = a.paymentStatus === 'package_paid' || isPacote;
            
            // Foi pago se: tem payment no appointment, foi pago hoje, ou é pacote pre-pago
            const foiPago = temPaymentNoAppointment || foiPagoHoje || foiPagoViaPacote;
            
            const categoria = foiPago ? 'recebido' : 'a_receber';
            
            // ⚠️ PENDENTE DE COBRANÇA: Só particular que NÃO FOI PAGO
            // - Convênio: fatura para o convênio (não é pendente de cobrança do paciente)
            // - Pacote: já foi pago quando comprou o pacote (sessão foi pre-paga)
            // - Particular com pagamento no sistema: já foi pago
            if (!foiPago && !isConvenio) {
                aReceber += valor;
                porEspecialidade[esp].pendente += valor;
                
                // Adiciona à lista de pendentes (só particulares não pagos)
                pendentesCobranca.push({
                    id: a._id,
                    paciente: patientName,
                    telefone: a.patientInfo?.phone || a.patient?.phone || '-',
                    valor: valor,
                    horario: a.time,
                    especialidade: esp,
                    professional: a.doctor?.fullName || a.professionalName || '-',
                    tipo: isConvenio ? 'Convênio' : (isPacote ? 'Pacote' : 'Particular'),
                    convenio: a.insuranceProvider || null
                });
            } else {
                porEspecialidade[esp].recebido += valor;
            }
            
            return {
                id: a._id,
                paciente: patientName,
                valor: valor,
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
                categoria: categoria,
                professional: a.doctor?.fullName || a.professionalName || '-'
            };
        });
        
        // Calcula variação vs ontem
        const variacao = yesterdayTotal > 0 
            ? ((totalCaixa - yesterdayTotal) / yesterdayTotal * 100).toFixed(1)
            : totalCaixa > 0 ? 100 : 0;
        
        // Comparação com média mensal
        const vsMediaMes = mediaDiariaMes > 0
            ? ((totalCaixa - mediaDiariaMes) / mediaDiariaMes * 100).toFixed(1)
            : 0;
        
        // Ticket médio
        const ticketMedio = payments.length > 0 ? (totalCaixa / payments.length) : 0;
        const ticketMedioProducao = appointments.length > 0 ? (totalProducao / appointments.length) : 0;
        
        // Taxa de eficiência (% recebido da produção)
        const taxaEficiencia = totalProducao > 0 ? ((totalCaixa / totalProducao) * 100).toFixed(1) : 0;
        
        // Formata por especialidade
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
                
                // ========== CAIXA - DINHEIRO QUE ENTROU ==========
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
                
                // ========== DESPESAS ==========
                despesas: {
                    total: totalDespesas,
                    porCategoria: despesasPorCategoria,
                    quantidade: expenses.length
                },
                
                // ========== SALDO ==========
                saldo: {
                    bruto: totalCaixa,
                    liquido: saldoLiquido,
                    despesaTotal: totalDespesas
                },
                
                // ========== PRODUÇÃO DO DIA ==========
                producao: {
                    total: totalProducao,
                    aReceber: aReceber,
                    recebido: totalCaixa,
                    quantidadeAtendimentos: appointments.length,
                    ticketMedio: ticketMedioProducao,
                    taxaEficiencia: parseFloat(taxaEficiencia),
                    porTipo: {
                        particular: producaoParticular,
                        pacote: producaoPacote,
                        convenio: producaoConvenio
                    },
                    porEspecialidade: especialidadesResumo
                },
                
                // ========== PENDENTES DE COBRANÇA ==========
                pendentesCobranca: pendentesCobranca.sort((a, b) => a.horario.localeCompare(b.horario)),
                
                // ========== PACOTES ATENDIDOS HOJE ==========
                pacotesAtendidos: transacoesProducao.filter(t => t.tipo === 'Pacote').map(t => ({
                    id: t.id,
                    horario: t.hora,
                    paciente: t.paciente,
                    servico: t.servico,
                    especialidade: t.especialidade,
                    professional: t.professional,
                    valor: t.valor,
                    statusPagamento: t.categoria === 'recebido' ? 'Pago' : 'Pendente'
                })),
                
                // ========== CONVÊNIOS ATENDIDOS HOJE ==========
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
                
                // ========== COMPARATIVOS ==========
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
                    quantidade: payments.length,
                    quantidadeAtendimentos: appointments.length,
                    ticketMedio,
                    ontem: yesterdayTotal
                },
                
                // Transações detalhadas
                transacoes: transacoesCaixa,
                transacoesProducao: transacoesProducao
            }
        });
        
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

export default router;
