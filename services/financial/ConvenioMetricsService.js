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
        const sessoes = await Session.find({
            status: 'completed',
            date: { $gte: start, $lte: end },
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
        const sessoes = await Session.find({
            status: 'scheduled',
            date: { $gte: start, $lte: end },
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
        const sessoes = await Session.find({
            status: 'completed',
            date: { $lte: ultimoDiaMes }, // Até o último dia do mês pesquisado
            $or: [
                { paymentMethod: 'convenio' },
                { insuranceGuide: { $exists: true, $ne: null } }
            ],
            // Ainda não recebido
            $or: [
                { isPaid: false },
                { paymentStatus: { $in: ['pending', 'pending_receipt'] } }
            ]
        })
        .populate('package', 'insuranceProvider insuranceGrossAmount')
        .lean();

        // Calcula total
        let total = 0;
        const porMes = {};

        for (const sessao of sessoes) {
            const valor = sessao.package?.insuranceGrossAmount || 
                         sessao.sessionValue || 
                         180; // fallback
            
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
        const sessoes = await Session.find({
            status: 'scheduled',
            date: { $gte: primeiroDiaMesSeguinte }, // A partir do próximo mês
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
            const valor = sessao.package?.insuranceGrossAmount || 
                         sessao.sessionValue || 
                         180; // fallback
            
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
            // Valor da sessão (do pacote ou fallback)
            const valor = sessao.package?.insuranceGrossAmount || 
                         sessao.sessionValue || 
                         180; // fallback

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
            const valor = sessao.package?.insuranceGrossAmount || 
                         sessao.sessionValue || 
                         180;

            total += valor;

            // Determina status (simplificado - idealmente viria do Payment)
            const status = sessao.isPaid ? 'partial' : 'pending_billing';
            
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
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const end = moment(`${year}-${String(month).padStart(2, '0')}-01`)
            .endOf('month')
            .format('YYYY-MM-DD');
        
        return { start, end };
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
}

export default new ConvenioMetricsService();
