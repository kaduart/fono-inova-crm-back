// services/financial/ConvenioMetricsService.js
// Serviço específico para métricas de convênio - SEPARA receita realizada de caixa

import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Session from '../../models/Session.js';
import Package from '../../models/Package.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';

const TIMEZONE = 'America/Sao_Paulo';

/**
 * 💡 CONCEITO IMPORTANTE:
 * 
 * RECEITA REALIZADA ≠ CAIXA
 * 
 * - Receita Realizada: Valor do serviço prestado (sessão completed)
 *   → Conta no mês do atendimento
 *   → Mostra produção da clínica
 * 
 * - Caixa: Dinheiro que efetivamente entrou
 *   → Conta quando o convênio paga (30 dias depois)
 *   → Não inclui convênios "a receber"
 * 
 * - A Receber: Convênios que ainda não pagaram
 *   → Pipeline de entrada futura
 *   → Importante para projeção de caixa
 */

class ConvenioMetricsService {

    /**
     * Busca métricas completas de convênio para um período
     * SEPARA receita realizada de caixa real
     */
    async getConvenioMetrics({ month, year }) {
        const periodo = this._getPeriodDates(month, year);
        const { start, end } = periodo;

        console.log(`[ConvenioMetrics] Calculando métricas para ${month}/${year}`);

        // Executar queries em paralelo
        const [
            sessoesRealizadas,
            sessoesAgendadas,
            pacotesAtivos,
            guiasAtivas,
            provisaoConvenio,      // Provisão realizada até o mês
            provisaoAgendadas      // NOVO: Provisão de sessões agendadas futuras
        ] = await Promise.all([
            this._getSessoesRealizadas(start, end),
            this._getSessoesAgendadas(start, end),
            this._getPacotesAtivos(),
            this._getGuiasAtivas(),
            this._getProvisaoConvenio(year, month), // Provisão até último dia do mês
            this._getProvisaoAgendadas(year, month) // Provisão de agendadas futuras
        ]);

        // Calcular valores
        const receitaRealizada = this._calcularReceitaRealizada(sessoesRealizadas);
        const aReceberPeriodo = this._calcularAReceber(sessoesRealizadas); // Só do período
        const pipeline = this._calcularPipeline(sessoesAgendadas);

        return {
            period: {
                month: parseInt(month),
                year: parseInt(year),
                startDate: start,
                endDate: end
            },
            
            // ========================================
            // RECEITA REALIZADA (Produção)
            // ========================================
            receitaRealizada: {
                description: 'Valor dos serviços prestados no período (independentemente de pagamento)',
                total: receitaRealizada.total,
                quantidadeSessoes: receitaRealizada.quantidade,
                porConvenio: receitaRealizada.porConvenio,
                porEspecialidade: receitaRealizada.porEspecialidade
            },

            // ========================================
            // A RECEBER DO PERÍODO (Só do mês pesquisado)
            // ========================================
            aReceber: {
                description: 'Convênios a faturar ou já faturados aguardando pagamento (SÓ DO MÊS PESQUISADO)',
                total: aReceberPeriodo.total,
                quantidadeSessoes: aReceberPeriodo.quantidade,
                porStatus: aReceberPeriodo.porStatus // pending_billing, billed, partial
            },

            // ========================================
            // PROVISÃO CONVÊNIO (Acumulado até o mês pesquisado)
            // ========================================
            provisaoConvenio: {
                description: 'Total acumulado de convênios a receber ATÉ O ÚLTIMO DIA DO MÊS PESQUISADO',
                total: provisaoConvenio.total,
                quantidadeSessoes: provisaoConvenio.quantidadeSessoes,
                ateData: provisaoConvenio.ateData, // Último dia do mês pesquisado
                porMes: provisaoConvenio.porMes // Detalhamento por mês das sessões
            },

            // ========================================
            // PIPELINE FUTURO
            // ========================================
            pipelineFuturo: {
                description: 'Sessões agendadas para períodos futuros',
                total: pipeline.total,
                quantidadeSessoes: pipeline.quantidade,
                porMes: pipeline.porMes
            },

            // ========================================
            // ATIVOS
            // ========================================
            ativos: {
                pacotesConvenio: pacotesAtivos.count,
                guiasAtivas: guiasAtivas.count,
                totalSessoesDisponiveis: guiasAtivas.totalSessoesRestantes,
                valorTotalDisponivel: guiasAtivas.valorEstimado
            },

            // ========================================
            // RESUMO EXECUTIVO
            // ========================================
            resumo: {
                producaoMes: receitaRealizada.total,           // O que foi produzido no mês
                entradaEsperada: aReceberPeriodo.total,        // O que vai entrar do mês
                provisaoTotal: provisaoConvenio.total,         // Provisão acumulada até o mês
                coberturaConvenio: receitaRealizada.total > 0 ? 
                    (aReceberPeriodo.total / receitaRealizada.total * 100).toFixed(1) : 0
            }
        };
    }

    /**
     * Busca sessões de convênio REALIZADAS no período
     * Estas contam como RECEITA REALIZADA
     */
    async _getSessoesRealizadas(start, end) {
        // start/end podem ser strings ou Date; garantir Date para ISODate queries
        const startDate = start instanceof Date ? start : moment.tz(start, TIMEZONE).startOf('day').toDate();
        const endDate = end instanceof Date ? end : moment.tz(end, TIMEZONE).endOf('day').toDate();
        const sessoes = await Session.find({
            status: 'completed',
            date: { $gte: startDate, $lte: endDate },
            $or: [
                { paymentMethod: 'convenio' },
                { insuranceGuide: { $exists: true, $ne: null } }
            ]
        })
        .populate('patient', 'fullName')
        .populate('doctor', 'fullName specialty')
        .populate('package', 'insuranceProvider insuranceGrossAmount')
        .populate('insuranceGuide', 'number insurance')
        .lean();

        return sessoes;
    }

    /**
     * Busca sessões de convênio AGENDADAS no período
     * Estas representam pipeline futuro
     */
    async _getSessoesAgendadas(start, end) {
        const startDate = start instanceof Date ? start : moment.tz(start, TIMEZONE).startOf('day').toDate();
        const endDate = end instanceof Date ? end : moment.tz(end, TIMEZONE).endOf('day').toDate();
        const sessoes = await Session.find({
            status: 'scheduled',
            date: { $gte: startDate, $lte: endDate },
            $or: [
                { paymentMethod: 'convenio' },
                { insuranceGuide: { $exists: true, $ne: null } }
            ]
        })
        .populate('package', 'insuranceProvider insuranceGrossAmount')
        .lean();

        return sessoes;
    }

    /**
     * Busca pacotes de convênio ativos
     */
    async _getPacotesAtivos() {
        const count = await Package.countDocuments({
            type: 'convenio',
            status: { $in: ['active', 'in-progress'] }
        });

        return { count };
    }

    /**
     * Busca guias ativas e calcula saldo
     */
    async _getGuiasAtivas() {
        const guias = await InsuranceGuide.find({
            status: 'active',
            expiresAt: { $gte: new Date() }
        }).lean();

        const totalSessoesRestantes = guias.reduce((sum, g) => {
            return sum + (g.totalSessions - g.usedSessions);
        }, 0);

        // Valor estimado (assumindo média de R$ 180 - idealmente viraria de uma tabela)
        const valorEstimado = totalSessoesRestantes * 180;

        return {
            count: guias.length,
            totalSessoesRestantes,
            valorEstimado
        };
    }

    /**
     * Calcula PROVISÃO de convênios
     * Total acumulado de sessões realizadas ATÉ O MÊS PESQUISADO que ainda não foram pagas
     * 
     * Exemplo: Se estamos em 19/02/2026, pega todas as sessões realizadas de 01/01/2026 até 28/02/2026
     * que ainda não foram pagas (isPaid = false ou paymentStatus != 'paid')
     */
    async _getProvisaoConvenio(ano, mes) {
        // Data final do mês pesquisado (último dia)
        const ultimoDiaMes = moment(`${ano}-${String(mes).padStart(2, '0')}-01`)
            .endOf('month')
            .format('YYYY-MM-DD');
        
        // Busca TODAS as sessões realizadas ATÉ O ÚLTIMO DIA DO MÊS PESQUISADO
        // que ainda não foram pagas
        const ultimoDiaDate = moment.tz(ultimoDiaMes, TIMEZONE).endOf('day').toDate();
        const sessoes = await Session.find({
            status: 'completed',
            date: { $lte: ultimoDiaDate },
            $and: [
                {
                    $or: [
                        { paymentMethod: 'convenio' },
                        { insuranceGuide: { $exists: true, $ne: null } }
                    ]
                },
                {
                    $or: [
                        { isPaid: false },
                        { paymentStatus: { $in: ['pending', 'pending_receipt'] } }
                    ]
                }
            ]
        })
        .populate('package', 'insuranceProvider insuranceGrossAmount')
        .lean();

        // Calcula total
        let total = 0;
        const porMes = {};

        for (const sessao of sessoes) {
            const valor = sessao.package?.insuranceGrossAmount || sessao.sessionValue || 0;
            if (valor === 0) continue;
            total += valor;

            // Agrupa por mês da sessão (não do recebimento)
            const mesSessao = sessao.date.substring(0, 7); // YYYY-MM
            const mesFormatado = moment(sessao.date).format('MM/YYYY');
            
            if (!porMes[mesSessao]) {
                porMes[mesSessao] = {
                    mes: mesFormatado,
                    valor: 0,
                    quantidade: 0
                };
            }
            
            porMes[mesSessao].valor += valor;
            porMes[mesSessao].quantidade += 1;
        }

        return {
            total,
            quantidadeSessoes: sessoes.length,
            porMes: Object.values(porMes).sort((a, b) => a.mes.localeCompare(b.mes)),
            ateData: ultimoDiaMes
        };
    }

    /**
     * Calcula PROVISÃO DE SESSÕES AGENDADAS (Futuras)
     * Valor projetado de sessões de convênio já agendadas para meses futuros
     * Útil para tomada de decisão e projeção de caixa
     */
    async _getProvisaoAgendadas(year, mes) {
        // Data inicial: primeiro dia do mês seguinte ao pesquisado
        const primeiroDiaMesSeguinte = moment(`${year}-${String(mes).padStart(2, '0')}-01`)
            .add(1, 'month')
            .startOf('month')
            .format('YYYY-MM-DD');
        
        // Busca TODAS as sessões agendadas a partir do mês seguinte
        const primeiroDiaDate = moment.tz(primeiroDiaMesSeguinte, TIMEZONE).startOf('day').toDate();
        const sessoes = await Session.find({
            status: 'scheduled',
            date: { $gte: primeiroDiaDate }, // A partir do próximo mês
            $or: [
                { paymentMethod: 'convenio' },
                { insuranceGuide: { $exists: true, $ne: null } }
            ]
        })
        .populate('package', 'insuranceProvider insuranceGrossAmount')
        .lean();

        // Calcula total
        let total = 0;
        const porMes = {};
        const porConvenio = {};

        for (const sessao of sessoes) {
            const valor = sessao.package?.insuranceGrossAmount || sessao.sessionValue || 0;
            if (valor === 0) continue;
            total += valor;

            // Agrupa por mês da sessão
            const mesSessao = sessao.date.substring(0, 7); // YYYY-MM
            const mesFormatado = moment(sessao.date).format('MM/YYYY');
            
            if (!porMes[mesSessao]) {
                porMes[mesSessao] = {
                    mes: mesFormatado,
                    valor: 0,
                    quantidade: 0
                };
            }
            
            porMes[mesSessao].valor += valor;
            porMes[mesSessao].quantidade += 1;

            // Por convênio
            const convenio = sessao.package?.insuranceProvider || 'nao_informado';
            if (!porConvenio[convenio]) {
                porConvenio[convenio] = { valor: 0, quantidade: 0 };
            }
            porConvenio[convenio].valor += valor;
            porConvenio[convenio].quantidade += 1;
        }

        return {
            total,
            quantidadeSessoes: sessoes.length,
            porMes: Object.values(porMes).sort((a, b) => a.mes.localeCompare(b.mes)),
            porConvenio,
            aPartirDe: primeiroDiaMesSeguinte
        };
    }

    /**
     * Calcula receita realizada a partir das sessões
     */
    _calcularReceitaRealizada(sessoes) {
        let total = 0;
        const porConvenio = {};
        const porEspecialidade = {};

        for (const sessao of sessoes) {
            const valor = sessao.package?.insuranceGrossAmount || sessao.sessionValue || 0;

            total += valor;

            // Por convênio
            const convenio = sessao.package?.insuranceProvider || 
                            sessao.insuranceGuide?.insurance || 
                            'nao_informado';
            
            if (!porConvenio[convenio]) {
                porConvenio[convenio] = { valor: 0, quantidade: 0 };
            }
            porConvenio[convenio].valor += valor;
            porConvenio[convenio].quantidade += 1;

            // Por especialidade
            const especialidade = sessao.sessionType || 'nao_informada';
            if (!porEspecialidade[especialidade]) {
                porEspecialidade[especialidade] = { valor: 0, quantidade: 0 };
            }
            porEspecialidade[especialidade].valor += valor;
            porEspecialidade[especialidade].quantidade += 1;
        }

        return {
            total,
            quantidade: sessoes.length,
            porConvenio,
            porEspecialidade
        };
    }

    /**
     * Calcula "A Receber" - convênios que ainda não pagaram
     */
    _calcularAReceber(sessoes) {
        // Aqui você pode integrar com o modelo Payment se existir
        // Por enquanto, assumimos que todas as sessões de convênio são "a receber"
        // até que seja marcado como recebido

        let total = 0;
        const porStatus = {
            pending_billing: { valor: 0, quantidade: 0, descricao: 'A faturar' },
            billed: { valor: 0, quantidade: 0, descricao: 'Faturado, aguardando pagamento' },
            partial: { valor: 0, quantidade: 0, descricao: 'Pago parcialmente' }
        };

        for (const sessao of sessoes) {
            // Só conta sessões efetivamente não pagas
            if (sessao.isPaid === true) continue;

            const valor = sessao.package?.insuranceGrossAmount || sessao.sessionValue || 0;
            if (valor === 0) continue; // ignora sessões sem valor real cadastrado

            total += valor;

            const status = 'pending_billing';
            porStatus[status].valor += valor;
            porStatus[status].quantidade += 1;
        }

        return {
            total,
            quantidade: sessoes.length,
            porStatus
        };
    }

    /**
     * Calcula pipeline de sessões agendadas
     */
    _calcularPipeline(sessoes) {
        let total = 0;
        const porMes = {};

        for (const sessao of sessoes) {
            const valor = sessao.package?.insuranceGrossAmount || 
                         sessao.sessionValue || 
                         180;

            total += valor;

            const mes = sessao.date.substring(0, 7); // YYYY-MM
            if (!porMes[mes]) {
                porMes[mes] = { mes, valor: 0, quantidade: 0 };
            }
            porMes[mes].valor += valor;
            porMes[mes].quantidade += 1;
        }

        return {
            total,
            quantidade: sessoes.length,
            porMes: Object.values(porMes).sort((a, b) => a.mes.localeCompare(b.mes))
        };
    }

    /**
     * Retorna datas do período
     */
    _getPeriodDates(month, year) {
        const startStr = `${year}-${String(month).padStart(2, '0')}-01`;
        const endStr = moment(`${year}-${String(month).padStart(2, '0')}-01`)
            .endOf('month')
            .format('YYYY-MM-DD');
        
        // Retornar Date objects para queries ISODate no MongoDB
        const start = moment.tz(startStr, TIMEZONE).startOf('day').toDate();
        const end = moment.tz(endStr, TIMEZONE).endOf('day').toDate();
        
        return { start, end, startStr, endStr };
    }

    /**
     * Busca FATURAMENTOS de convênio no período (baseado em insurance.billedAt)
     * Retorna o valor das guias que foram enviadas/faturadas no mês
     */
    async getFaturamentosPorPeriodo(month, year) {
        const start = moment(`${year}-${String(month).padStart(2, '0')}-01`).startOf('month').toDate();
        const end = moment(`${year}-${String(month).padStart(2, '0')}-01`).endOf('month').toDate();

        console.log(`[ConvenioMetrics] Buscando faturamentos de ${month}/${year}`);

        // Importar Payment
        const { default: Payment } = await import('../../models/Payment.js');

        // Buscar payments faturados no período (baseado em insurance.billedAt)
        const faturamentos = await Payment.find({
            billingType: 'convenio',
            'insurance.billedAt': { $gte: start, $lte: end },
            'insurance.status': { $in: ['billed', 'received', 'partial'] }
        })
        .populate('patient', 'fullName')
        .populate('appointment', 'date')
        .lean();

        // Calcular totais
        let total = 0;
        const porConvenio = {};
        const porStatus = {
            billed: { valor: 0, quantidade: 0, descricao: 'Faturado, aguardando pagamento' },
            received: { valor: 0, quantidade: 0, descricao: 'Pago pelo convênio' },
            partial: { valor: 0, quantidade: 0, descricao: 'Pago parcialmente' }
        };

        for (const fat of faturamentos) {
            const valor = fat.insurance?.grossAmount || fat.amount || 0;
            total += valor;

            // Por convênio
            const convenio = fat.insuranceProvider || 'nao_informado';
            if (!porConvenio[convenio]) {
                porConvenio[convenio] = { valor: 0, quantidade: 0 };
            }
            porConvenio[convenio].valor += valor;
            porConvenio[convenio].quantidade += 1;

            // Por status
            const status = fat.insurance?.status || 'billed';
            if (porStatus[status]) {
                porStatus[status].valor += valor;
                porStatus[status].quantidade += 1;
            }
        }

        return {
            total,
            quantidade: faturamentos.length,
            porConvenio,
            porStatus,
            faturamentos: faturamentos.map(f => ({
                _id: f._id,
                patient: f.patient?.fullName,
                valor: f.insurance?.grossAmount || f.amount,
                status: f.insurance?.status,
                billedAt: f.insurance?.billedAt,
                receivedAt: f.insurance?.receivedAt,
                convenio: f.insuranceProvider
            }))
        };
    }

    // ============================================
    // MÉTODOS PARA INTEGRAÇÃO COM DASHBOARD EXISTENTE
    // ============================================

    /**
     * Retorna resumo rápido para o dashboard principal
     * NÃO afeta o caixa - apenas informação estratégica
     */
    async getDashboardSummary() {
        const hoje = moment().tz(TIMEZONE);
        const mesAtual = hoje.month() + 1;
        const anoAtual = hoje.year();

        const metrics = await this.getConvenioMetrics({
            month: mesAtual,
            year: anoAtual
        });

        return {
            // Cards para o dashboard
            cards: {
                producaoMes: {
                    label: 'Produção Convênio',
                    value: metrics.receitaRealizada.total,
                    sublabel: `${metrics.receitaRealizada.quantidadeSessoes} sessões`,
                    color: 'blue',
                    icon: 'hospital'
                },
                aReceber: {
                    label: 'A Receber Convênios',
                    value: metrics.aReceber.total,
                    sublabel: `${metrics.aReceber.quantidadeSessoes} sessões pendentes`,
                    color: 'orange',
                    icon: 'clock'
                },
                pipeline: {
                    label: 'Pipeline Futuro',
                    value: metrics.pipelineFuturo.total,
                    sublabel: `${metrics.pipelineFuturo.quantidadeSessoes} sessões agendadas`,
                    color: 'green',
                    icon: 'calendar'
                }
            },

            // Alertas
            alertas: this._gerarAlertas(metrics)
        };
    }

    /**
     * Gera alertas baseados nas métricas
     */
    _gerarAlertas(metrics) {
        const alertas = [];

        // Alerta: Muitas sessões a faturar
        if (metrics.aReceber.porStatus.pending_billing.quantidade > 10) {
            alertas.push({
                tipo: 'warning',
                titulo: 'Sessões pendentes de faturamento',
                mensagem: `${metrics.aReceber.porStatus.pending_billing.quantidade} sessões de convênio ainda não foram faturadas`,
                acao: 'Verificar guias pendentes'
            });
        }

        // Alerta: Pipeline alto (bom problema)
        if (metrics.pipelineFuturo.quantidadeSessoes > 20) {
            alertas.push({
                tipo: 'info',
                titulo: 'Pipeline de convênios saudável',
                mensagem: `${metrics.pipelineFuturo.quantidadeSessoes} sessões agendadas para os próximos meses`,
                acao: 'Visualizar agenda'
            });
        }

        return alertas;
    }

    // ============================================
    // FATURAMENTO EM LOTE
    // ============================================

    /**
     * Fatura múltiplos atendimentos de convênio em lote
     * @param {Object} params - { paymentIds, notaFiscal, dataFaturamento }
     * @returns {Object} resultado do faturamento
     */
    async faturarEmLote({ paymentIds, notaFiscal, dataFaturamento }) {
        const Payment = mongoose.model('Payment');
        const Package = mongoose.model('Package');
        const Session = mongoose.model('Session');
        
        console.log(`[ConvenioMetrics] Faturando ${paymentIds.length} atendimentos em lote`);

        const result = {
            faturados: 0,
            erros: 0,
            detalhes: [],
            totalValor: 0
        };

        for (const paymentId of paymentIds) {
            try {
                // 🔹 POPULA O PACKAGE para ter acesso ao valor do convênio
                const payment = await Payment.findById(paymentId)
                    .populate('package', 'insuranceProvider insuranceGrossAmount sessionValue')
                    .populate('patient', 'fullName');
                
                if (!payment) {
                    result.erros++;
                    result.detalhes.push({ paymentId, status: 'erro', msg: 'Payment não encontrado' });
                    continue;
                }

                // Verifica se já está faturado
                if (payment.insurance?.status === 'billed') {
                    result.detalhes.push({ paymentId, status: 'ignorado', msg: 'Já faturado' });
                    continue;
                }

                // 🔹 DETERMINA O VALOR CORRETO DO CONVÊNIO
                // Prioridade: 1. insuranceGrossAmount do package, 2. sessionValue do package, 3. valor existente, 4. 0
                const valorConvenio = payment.package?.insuranceGrossAmount || 
                                     payment.package?.sessionValue || 
                                     payment.insurance?.grossAmount || 
                                     payment.amount || 
                                     0;

                // Atualiza status para faturado
                payment.insurance.status = 'billed';
                payment.insurance.billedAt = dataFaturamento;
                payment.insurance.grossAmount = valorConvenio; // 🔹 GARANTE QUE TEM VALOR
                payment.amount = valorConvenio; // 🔹 ATUALIZA O AMOUNT TAMBÉM
                
                if (notaFiscal) {
                    payment.insurance.invoiceNumber = notaFiscal;
                }

                await payment.save();

                // 🔹 ATUALIZAR SESSION.PAYMENTID para vincular sessão ao payment
                if (payment.session) {
                    await Session.updateOne(
                        { _id: payment.session },
                        { 
                            $set: { 
                                paymentId: payment._id,
                                isPaid: true,
                                paidAt: dataFaturamento
                            } 
                        }
                    );
                }

                result.faturados++;
                result.totalValor += valorConvenio;
                result.detalhes.push({ 
                    paymentId, 
                    status: 'faturado', 
                    valor: valorConvenio,
                    paciente: payment.patient?.fullName 
                });

            } catch (error) {
                console.error(`[ConvenioMetrics] Erro ao faturar ${paymentId}:`, error);
                result.erros++;
                result.detalhes.push({ paymentId, status: 'erro', msg: error.message });
            }
        }

        console.log(`[ConvenioMetrics] Faturamento em lote concluído: ${result.faturados} sucesso, ${result.erros} erros`);
        return result;
    }

    /**
     * Fatura TODOS os atendimentos pendentes de um paciente específico
     * @param {Object} params - { patientId, notaFiscal, dataFaturamento }
     * @returns {Object} resultado do faturamento
     */
    async faturarTodosDoPaciente({ patientId, notaFiscal, dataFaturamento }) {
        const Payment = mongoose.model('Payment');
        
        console.log(`[ConvenioMetrics] Buscando atendimentos pendentes do paciente ${patientId}`);

        // Busca todos os payments do paciente que estão pendentes de faturamento
        const paymentsPendentes = await Payment.find({
            patient: patientId,
            'insurance.status': { $in: ['pending_billing', null] },
            paymentMethod: 'convenio'
        }).select('_id');

        const paymentIds = paymentsPendentes.map(p => p._id.toString());

        console.log(`[ConvenioMetrics] Encontrados ${paymentIds.length} atendimentos pendentes`);

        if (paymentIds.length === 0) {
            return {
                faturados: 0,
                message: 'Nenhum atendimento pendente de faturamento para este paciente'
            };
        }

        // Fatura em lote
        return await this.faturarEmLote({
            paymentIds,
            notaFiscal,
            dataFaturamento
        });
    }

    /**
     * Recebe pagamento de convênio e registra no caixa
     * IMPORTANTE: O recebimento aparece no caixa da data de recebimento, não do atendimento!
     * 
     * @param {Object} params - { paymentId, dataRecebimento, valorRecebido, notaFiscal }
     * @returns {Object} resultado
     */
    async receberPagamentoConvenio({ paymentId, dataRecebimento, valorRecebido, notaFiscal }) {
        const Payment = mongoose.model('Payment');
        
        console.log(`[ConvenioMetrics] Recebendo pagamento ${paymentId} em ${dataRecebimento}`);

        try {
            // 🔹 POPULA PARA TER ACESSO AOS DADOS
            const payment = await Payment.findById(paymentId)
                .populate('package', 'insuranceProvider insuranceGrossAmount sessionValue')
                .populate('patient', 'fullName');
            
            if (!payment) {
                throw new Error('Payment não encontrado');
            }

            // Verifica se já foi recebido
            if (payment.insurance?.status === 'received') {
                throw new Error('Pagamento já foi recebido');
            }

            // 🔹 DETERMINA O VALOR A RECEBER (se não fornecido, pega do insurance.grossAmount ou package)
            const valorEfetivo = valorRecebido || 
                                 payment.insurance?.grossAmount || 
                                 payment.package?.insuranceGrossAmount || 
                                 payment.package?.sessionValue || 
                                 payment.amount || 
                                 0;

            // Garante que o objeto insurance existe
            if (!payment.insurance) {
                payment.insurance = {};
            }
            
            // Atualiza o payment para recebido
            payment.insurance.status = 'received';
            payment.insurance.receivedAt = dataRecebimento;
            payment.insurance.receivedAmount = valorEfetivo;
            payment.insurance.grossAmount = payment.insurance.grossAmount || valorEfetivo; // Garante que tem grossAmount
            
            if (notaFiscal) {
                payment.insurance.invoiceNumber = notaFiscal;
            }
            
            // Marca o billingType como convenio se não estiver definido
            if (!payment.billingType) {
                payment.billingType = 'convenio';
            }
            
            // 🔹 ATUALIZA O AMOUNT SE ESTIVER ZERO
            if (!payment.amount || payment.amount === 0) {
                payment.amount = valorEfetivo;
            }
            
            // Marca como pago - ISSO FAZ APARECER NO CAIXA DO DIA DO RECEBIMENTO!
            payment.status = 'paid';
            payment.paidAt = new Date(dataRecebimento);
            payment.paymentDate = dataRecebimento;

            await payment.save();

            console.log(`[ConvenioMetrics] Recebimento registrado no caixa de ${dataRecebimento} - Valor: R$${valorEfetivo}`);

            return {
                success: true,
                paymentId,
                valorRecebido: valorEfetivo,
                dataRecebimento,
                paciente: payment.patient?.fullName,
                message: `Recebimento registrado no caixa de ${dataRecebimento}`
            };

        } catch (error) {
            console.error('[ConvenioMetrics] Erro ao receber pagamento:', error);
            throw error;
        }
    }

    /**
     * Recebe múltiplos pagamentos de convênio em lote
     * @param {Object} params - { paymentIds, dataRecebimento }
     * @returns {Object} resultado
     */
    async receberEmLote({ paymentIds, dataRecebimento }) {
        const result = {
            recebidos: 0,
            erros: 0,
            detalhes: [],
            totalValor: 0
        };

        for (const paymentId of paymentIds) {
            try {
                const payment = await mongoose.model('Payment').findById(paymentId);
                
                if (!payment) {
                    result.erros++;
                    result.detalhes.push({ paymentId, status: 'erro', msg: 'Payment não encontrado' });
                    continue;
                }

                const valorRecebido = payment.insurance?.grossAmount || 0;

                await this.receberPagamentoConvenio({
                    paymentId,
                    dataRecebimento,
                    valorRecebido,
                    notaFiscal: payment.insurance?.invoiceNumber
                });

                result.recebidos++;
                result.totalValor += valorRecebido;
                result.detalhes.push({ 
                    paymentId, 
                    status: 'recebido', 
                    valor: valorRecebido 
                });

            } catch (error) {
                console.error(`[ConvenioMetrics] Erro ao receber ${paymentId}:`, error);
                result.erros++;
                result.detalhes.push({ paymentId, status: 'erro', msg: error.message });
            }
        }

        return result;
    }
}

export default new ConvenioMetricsService();
