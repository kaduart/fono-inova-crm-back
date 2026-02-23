// services/financial/FinancialOverviewService.js
// Orquestrador do Financial Overview - reutiliza serviços existentes

import moment from 'moment-timezone';
import mongoose from 'mongoose';
import Payment from '../../models/Payment.js';
import Expense from '../../models/Expense.js';
import Planning from '../../models/Planning.js';
import Package from '../../models/Package.js';
import Leads from '../../models/Leads.js';
import Appointment from '../../models/Appointment.js';
import Sale from '../../models/Sale.js';
import FinancialInsightsEngine from './FinancialInsightsEngine.js';
import ConvenioMetricsService from './ConvenioMetricsService.js';

const TIMEZONE = 'America/Sao_Paulo';

class FinancialOverviewService {

    /**
     * Busca overview financeiro completo com comparação de períodos
     * INCLUI métricas de convênio separadas
     */
    async getOverview({ month, year, compare = 'previous' }) {
        const periodoAtual = this._getPeriodDates(month, year);
        const periodoComparativo = this._getComparisonPeriod(month, year, compare);

        // Buscar métricas em paralelo (incluindo convênios, crédito de pacotes e métricas operacionais)
        const [metricsAtual, metricsComparativo, planning, convenioMetrics, creditoPacotes, metricasOperacionais] = await Promise.all([
            this._calculateMetrics(periodoAtual),
            this._calculateMetrics(periodoComparativo),
            this._getPlanning(month, year),
            ConvenioMetricsService.getConvenioMetrics({ month, year }), // NOVO: Métricas de convênio
            this._getCreditoPacotes(), // NOVO: Crédito em pacotes ativos
            this._calculateMetricasOperacionais(periodoAtual) // NOVO: Métricas operacionais (funnel)
        ]);

        // Calcular variações
        const variation = this._calculateVariations(metricsAtual, metricsComparativo);

        // Calcular projeções
        const projecao = this._calculateProjection(metricsAtual.receita, month, year);
        const valorDiarioNecessario = FinancialInsightsEngine.calculateDailyRequired(
            planning?.target || 0,
            metricsAtual.receita,
            this._getRemainingDays(month, year)
        );

        // Montar objeto de métricas final
        const metrics = {
            receita: metricsAtual.receita,
            despesas: metricsAtual.despesas,
            lucro: metricsAtual.lucro,
            margem: metricsAtual.margem,
            caixa: metricsAtual.caixa,
            aReceber: metricsAtual.aReceber,
            
            // NOVO: Separar receitas por tipo
            particularRecebido: metricsAtual.particularRecebido,
            convenioRecebido: metricsAtual.convenioRecebido,
            
            meta: planning?.target || 0,
            metaPercent: planning?.target > 0 ? (metricsAtual.receita / planning.target) * 100 : 0,
            projecao,
            valorDiarioNecessario,
            
            // NOVO: Métricas de convênio integradas
            convenio: {
                receitaRealizada: convenioMetrics.receitaRealizada.total,     // Produção do mês
                aReceber: convenioMetrics.aReceber.total,                       // A receber do mês
                provisaoTotal: convenioMetrics.provisaoConvenio.total,          // Provisão acumulada até o mês
                provisaoAgendadas: convenioMetrics.provisaoAgendadas?.total || 0, // Provisão de agendadas futuras
                pipeline: convenioMetrics.pipelineFuturo.total,                 // Pipeline futuro
                ativos: convenioMetrics.ativos                                  // Pacotes e guias ativos
            },
            
            // NOVO: Crédito em pacotes (sessões pagas não utilizadas)
            creditoPacotes: {
                total: creditoPacotes.total,
                pacientes: creditoPacotes.detalhes
            },
            // NOVO: Métricas operacionais (funnel)
            leadsRecebidos: metricasOperacionais.leadsRecebidos,
            agendamentosRealizados: metricasOperacionais.agendamentosRealizados,
            avaliacoesRealizadas: metricasOperacionais.avaliacoesRealizadas,
            projetosFechados: metricasOperacionais.projetosFechados, // Agora só pacotes
            sessoesMes: metricasOperacionais.sessoesMes // NOVO: Sessões atendidas no mês
        };

        // Gerar insights
        const insights = FinancialInsightsEngine.generateInsights(metrics, variation, metricsComparativo);

        return {
            period: {
                month: parseInt(month),
                year: parseInt(year),
                startDate: periodoAtual.start,
                endDate: periodoAtual.end
            },
            comparisonPeriod: {
                month: periodoComparativo.month,
                year: periodoComparativo.year,
                startDate: periodoComparativo.start,
                endDate: periodoComparativo.end,
                type: compare
            },
            metrics,
            variation,
            insights,
            // NOVO: Dados completos de convênio para o frontend
            convenio: convenioMetrics
        };
    }

    /**
     * Calcula métricas para um período específico
     */
    async _calculateMetrics(periodo) {
        const { start, end, startDateTime, endDateTime } = periodo;

        // Agregações em paralelo - reutilizando lógica do cashflow.js
        const [
            receitasAgg,
            receitasPorTipo,
            despesasAgg,
            aReceberAgg,
            pagamentosPendentes
        ] = await Promise.all([
            // Receitas pagas (total)
            Payment.aggregate([
                {
                    $match: {
                        status: 'paid',
                        paymentDate: { $gte: start, $lte: end }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: '$amount' },
                        count: { $sum: 1 }
                    }
                }
            ]),

            // NOVO: Receitas separadas por tipo (particular vs convênio recebido)
            Payment.aggregate([
                {
                    $match: {
                        status: 'paid',
                        paymentDate: { $gte: start, $lte: end }
                    }
                },
                {
                    $group: {
                        _id: '$billingType',
                        total: { $sum: '$amount' },
                        count: { $sum: 1 }
                    }
                }
            ]),

            // Despesas pagas
            Expense.aggregate([
                {
                    $match: {
                        status: 'paid',
                        date: { $gte: start, $lte: end }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: '$amount' },
                        count: { $sum: 1 }
                    }
                }
            ]),

            // A receber (convênios pending_billing)
            Payment.aggregate([
                {
                    $match: {
                        status: 'paid',
                        billingType: 'convenio',
                        'insurance.status': 'pending_billing',
                        paymentDate: { $gte: start, $lte: end }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: { $ifNull: ['$insurance.grossAmount', '$amount'] } }
                    }
                }
            ]),

            // Pagamentos pendentes (não convênio)
            Payment.aggregate([
                {
                    $match: {
                        status: 'pending',
                        paymentDate: { $gte: start, $lte: end }
                    }
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: '$amount' }
                    }
                }
            ])
        ]);

        const receita = receitasAgg[0]?.total || 0;
        const despesas = despesasAgg[0]?.total || 0;
        const lucro = receita - despesas;
        const margem = receita > 0 ? lucro / receita : 0;

        // Caixa = receitas recebidas (já pagas)
        const caixa = receita;

        // A receber = convênios pending + pagamentos pendentes
        const aReceberConvenios = aReceberAgg[0]?.total || 0;
        const aReceberPendentes = pagamentosPendentes[0]?.total || 0;
        const aReceber = aReceberConvenios + aReceberPendentes;

        // NOVO: Separar receitas por tipo
        const particularRecebido = receitasPorTipo.find(r => r._id === 'particular')?.total || 0;
        const convenioRecebido = receitasPorTipo.find(r => r._id === 'convenio')?.total || 0;

        return {
            receita,
            despesas,
            particularRecebido,
            convenioRecebido,
            lucro,
            margem,
            caixa,
            aReceber,
            countReceitas: receitasAgg[0]?.count || 0,
            countDespesas: despesasAgg[0]?.count || 0
        };
    }

    /**
     * Calcula crédito remanescente em pacotes ativos
     * (sessões pagas mas não utilizadas)
     */
    async _getCreditoPacotes() {
        try {
            const pacotes = await Package.find({
                financialStatus: { $in: ['paid', 'partially_paid'] },
                status: { $in: ['active', 'in-progress'] }
            }).populate('patient', 'fullName');

            const detalhes = [];
            
            const total = pacotes.reduce((sum, pkg) => {
                const sessoesPagas = pkg.paidSessions || 0;
                const sessoesFeitas = pkg.sessionsDone || 0;
                const sessoesRemanescentes = Math.max(0, sessoesPagas - sessoesFeitas);
                const valor = sessoesRemanescentes * (pkg.sessionValue || 0);
                
                if (valor > 0 && sessoesRemanescentes > 0) {
                    detalhes.push({
                        pacoteId: pkg._id,
                        paciente: pkg.patient?.fullName || 'N/A',
                        sessoesRemanescentes,
                        valorPorSessao: pkg.sessionValue,
                        valorTotal: valor
                    });
                }
                
                return sum + valor;
            }, 0);

            // Ordenar por valor (maior primeiro)
            detalhes.sort((a, b) => b.valorTotal - a.valorTotal);

            return { total, detalhes };
        } catch (error) {
            console.error('Erro ao calcular crédito de pacotes:', error);
            return { total: 0, detalhes: [] };
        }
    }

    /**
     * Busca planejamento/meta do período
     */
    async _getPlanning(month, year) {
        try {
            const startOfMonth = moment(`${year}-${String(month).padStart(2, '0')}-01`)
                .tz(TIMEZONE)
                .startOf('month')
                .toDate();
            
            const endOfMonth = moment(startOfMonth).endOf('month').toDate();

            const planning = await Planning.findOne({
                startDate: { $lte: endOfMonth },
                endDate: { $gte: startOfMonth }
            }).sort({ createdAt: -1 });

            return planning ? {
                target: planning.target || 0,
                type: planning.type,
                id: planning._id
            } : null;
        } catch (error) {
            console.error('Erro ao buscar planning:', error);
            return null;
        }
    }

    /**
     * Calcula variações percentuais
     */
    _calculateVariations(atual, comparativo) {
        return {
            receita: FinancialInsightsEngine.calculateVariation(atual.receita, comparativo.receita),
            despesas: FinancialInsightsEngine.calculateVariation(atual.despesas, comparativo.despesas),
            lucro: FinancialInsightsEngine.calculateVariation(atual.lucro, comparativo.lucro),
            margem: (atual.margem - comparativo.margem) * 100 // Em pontos percentuais
        };
    }

    /**
     * Calcula projeção de faturamento
     */
    _calculateProjection(receitaAtual, month, year) {
        const hoje = moment().tz(TIMEZONE);
        const dataReferencia = moment(`${year}-${month}-01`).tz(TIMEZONE);
        
        // Se estiver consultando mês passado, não projeta
        if (dataReferencia.isBefore(hoje, 'month')) {
            return receitaAtual;
        }

        const diaAtual = hoje.date();
        const totalDiasMes = dataReferencia.endOf('month').date();

        return FinancialInsightsEngine.calculateProjection(receitaAtual, diaAtual, totalDiasMes);
    }

    /**
     * Retorna datas do período
     */
    _getPeriodDates(month, year) {
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const end = moment(`${year}-${String(month).padStart(2, '0')}-01`)
            .endOf('month')
            .format('YYYY-MM-DD');
        
        return {
            start,
            end,
            startDateTime: moment.tz(start, TIMEZONE).startOf('day').toDate(),
            endDateTime: moment.tz(end, TIMEZONE).endOf('day').toDate()
        };
    }

    /**
     * Retorna período de comparação
     */
    _getComparisonPeriod(month, year, compare) {
        let compMonth, compYear;
        const m = parseInt(month);
        const y = parseInt(year);

        switch (compare) {
            case 'previous':
                compMonth = m === 1 ? 12 : m - 1;
                compYear = m === 1 ? y - 1 : y;
                break;
            case 'lastYear':
                compMonth = m;
                compYear = y - 1;
                break;
            default:
                compMonth = m === 1 ? 12 : m - 1;
                compYear = m === 1 ? y - 1 : y;
        }

        return {
            month: compMonth,
            year: compYear,
            ...this._getPeriodDates(compMonth, compYear)
        };
    }

    /**
     * Calcula dias restantes no mês
     */
    _getRemainingDays(month, year) {
        const hoje = moment().tz(TIMEZONE);
        const dataReferencia = moment(`${year}-${String(month).padStart(2, '0')}-01`).tz(TIMEZONE);
        
        // Se não for mês atual, retorna 0
        if (!dataReferencia.isSame(hoje, 'month')) {
            return 0;
        }

        const totalDias = dataReferencia.endOf('month').date();
        const diaAtual = hoje.date();
        return Math.max(0, totalDias - diaAtual);
    }

    /**
     * Calcula métricas operacionais (funnel de vendas)
     * 1. Leads recebidos
     * 2. Agendamentos realizados (novos agendamentos - primeira consulta)
     * 3. Avaliações realizadas
     * 4. Projetos fechados (apenas Pacotes vendidos)
     * 5. Sessões do mês (total de sessões atendidas)
     */
    async _calculateMetricasOperacionais(periodo) {
        const { startDateTime, endDateTime } = periodo;

        try {
            // Executar contagens em paralelo
            const [
                leadsRecebidos,
                agendamentosRealizados,
                avaliacoesRealizadas,
                projetosFechados, // Só pacotes
                sessoesMes
            ] = await Promise.all([
                // 1. Leads recebidos (criados no período) - EXCLUINDO convertidos e perdidos
                Leads.countDocuments({
                    createdAt: { $gte: startDateTime, $lte: endDateTime },
                    status: { 
                        $nin: ['convertido', 'virou_paciente', 'perdido'] // Exclui leads já processados
                    }
                }),

                // 2. Novos agendamentos (avaliações = primeiras consultas)
                Appointment.countDocuments({
                    date: { $gte: periodo.start, $lte: periodo.end },
                    operationalStatus: { $nin: ['canceled'] },
                    serviceType: 'evaluation' // Só avaliações (primeira consulta)
                }),

                // 3. Avaliações realizadas (serviceType = evaluation e não canceladas)
                Appointment.countDocuments({
                    date: { $gte: periodo.start, $lte: periodo.end },
                    serviceType: 'evaluation',
                    operationalStatus: { $nin: ['canceled', 'missed'] }
                }),

                // 4. Projetos fechados = Pacotes vendidos/criados no período
                Package.countDocuments({
                    date: { $gte: startDateTime, $lte: endDateTime }
                    // Inclui todos os pacotes criados (representam projetos fechados)
                }),

                // 5. Sessões do mês = total de sessões atendidas (exclui avaliações)
                Appointment.countDocuments({
                    date: { $gte: periodo.start, $lte: periodo.end },
                    operationalStatus: { $nin: ['canceled', 'missed'] },
                    serviceType: { $in: ['session', 'package_session', 'individual_session', 'return', 'convenio_session'] }
                })
            ]);

            // Log para auditoria
            console.log('[FinancialOverview] Métricas Operacionais:', {
                periodo: `${periodo.start} a ${periodo.end}`,
                periodoISO: { start: startDateTime.toISOString(), end: endDateTime.toISOString() },
                leadsRecebidos,
                agendamentosRealizados,
                avaliacoesRealizadas,
                projetosFechados,
                sessoesMes
            });

            // AUDIT: Detalhamento de leads para verificação
            const leadsDetalhe = await Leads.aggregate([
                { 
                    $match: { 
                        createdAt: { $gte: startDateTime, $lte: endDateTime }
                    } 
                },
                { 
                    $group: { 
                        _id: '$status', 
                        count: { $sum: 1 } 
                    } 
                },
                { $sort: { count: -1 } }
            ]);
            console.log('[FinancialOverview] AUDIT - Leads por status:', leadsDetalhe);

            // AUDIT: Verificar se há leads sem interação (possíveis duplicados/teste)
            const leadsSemInteracao = await Leads.countDocuments({
                createdAt: { $gte: startDateTime, $lte: endDateTime },
                $or: [
                    { interactions: { $size: 0 } },
                    { interactions: { $exists: false } }
                ]
            });
            console.log('[FinancialOverview] AUDIT - Leads sem interação:', leadsSemInteracao);

            return {
                leadsRecebidos,
                agendamentosRealizados,
                avaliacoesRealizadas,
                projetosFechados,
                sessoesMes
            };

        } catch (error) {
            console.error('[FinancialOverview] Erro ao calcular métricas operacionais:', error);
            return {
                leadsRecebidos: 0,
                agendamentosRealizados: 0,
                avaliacoesRealizadas: 0,
                projetosFechados: 0,
                sessoesMes: 0
            };
        }
    }
}

export default new FinancialOverviewService();
