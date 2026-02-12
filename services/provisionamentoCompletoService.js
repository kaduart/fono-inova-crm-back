// services/provisionamentoCompletoService.js
import moment from 'moment-timezone';
import Expense from '../models/Expense.js';
import Sale from '../models/Sale.js';

class ProvisionamentoCompletoService {

    /**
     * Gera relatório analítico igual à planilha usando Aggregation Pipelines
     */
    async gerarRelatorioAnalitico(mes, ano) {
        const mesCompetencia = `${ano}-${String(mes).padStart(2, '0')}`;
        const startDate = moment(`${mesCompetencia}-01`).startOf('month').toDate();
        const endDate = moment(startDate).endOf('month').toDate();

        const [aggResults, custosFixosResults] = await Promise.all([
            Sale.aggregate([
                {
                    $match: {
                        $or: [
                            { mesCompetencia: mesCompetencia },
                            { dataVenda: { $gte: startDate, $lte: endDate } }
                        ],
                        status: { $ne: 'cancelado' }
                    }
                },
                {
                    $facet: {
                        baseDados: [
                            { $lookup: { from: 'patients', localField: 'patient', foreignField: '_id', as: 'p' } },
                            { $lookup: { from: 'doctors', localField: 'doctor', foreignField: '_id', as: 'd' } },
                            { $lookup: { from: 'produtoservicos', localField: 'produtoServico', foreignField: '_id', as: 'prod' } },
                            { $lookup: { from: 'packages', localField: 'package', foreignField: '_id', as: 'pkg' } },
                            { $unwind: { path: '$p', preserveNullAndEmptyArrays: true } },
                            { $unwind: { path: '$d', preserveNullAndEmptyArrays: true } },
                            { $unwind: { path: '$prod', preserveNullAndEmptyArrays: true } },
                            { $unwind: { path: '$pkg', preserveNullAndEmptyArrays: true } },
                            {
                                $project: {
                                    _id: 1,
                                    dataVenda: 1,
                                    valorBruto: 1,
                                    desconto: 1,
                                    valorLiquido: 1,
                                    formaPagamento: 1,
                                    parcelas: 1,
                                    status: 1,
                                    totalCustosVariaveis: 1,
                                    custosVariaveis: 1,
                                    pacoteInfo: 1,
                                    cliente: '$p.fullName',
                                    profissional: '$d.fullName',
                                    categoria: { $ifNull: ['$prod.categoria', 'Não categorizado'] },
                                    produtoNome: { $ifNull: ['$prod.nome', '$pkg.sessionType', 'N/A'] }
                                }
                            }
                        ],
                        resumoCategoria: [
                            { $lookup: { from: 'produtoservicos', localField: 'produtoServico', foreignField: '_id', as: 'prod' } },
                            { $unwind: { path: '$prod', preserveNullAndEmptyArrays: true } },
                            {
                                $group: {
                                    _id: { $ifNull: ['$prod.categoria', 'Não categorizado'] },
                                    qtdVendas: { $sum: 1 },
                                    bruto: { $sum: '$valorBruto' },
                                    liquido: { $sum: '$valorLiquido' },
                                    totalCV: { $sum: '$totalCustosVariaveis' },
                                    margem: { $sum: { $subtract: ['$valorLiquido', { $ifNull: ['$totalCustosVariaveis', 0] }] } }
                                }
                            }
                        ]
                    }
                }
            ]),
            Expense.aggregate([
                { $match: { date: { $gte: startDate, $lte: endDate }, status: 'paid' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ])
        ]);

        const baseDadosAgg = aggResults[0].baseDados || [];
        const totalCustosFixos = custosFixosResults[0]?.total || 0;

        // 1. Processar dados analíticos (Base de Dados)
        const analitico = baseDadosAgg.map(venda => {
            const isPacote = venda.pacoteInfo ? true : false;
            const getCV = (tipo) => venda.custosVariaveis?.find(c => c.tipo === tipo)?.valor || 0;
            const impostos = venda.custosVariaveis?.filter(c => c.tipo.startsWith('imposto')).reduce((s, c) => s + (c.valor || 0), 0) || 0;

            return {
                ID_Venda: venda._id.toString().slice(-6),
                Data_Venda: moment(venda.dataVenda).format('YYYY-MM-DD'),
                Mes: moment(venda.dataVenda).format('MMMM'),
                Ano: ano,
                Cliente: venda.cliente || 'N/A',
                Tipo_Produto: isPacote ? 'Pacote' : 'Sessão Avulsa',
                Categoria: venda.categoria,
                Produto_Servico: venda.produtoNome,
                Pacote: isPacote ? `Pacote ${venda.pacoteInfo?.totalSessoes} Sessões` : '-',
                Qtd_Sessoes_Total: isPacote ? venda.pacoteInfo?.totalSessoes : 1,
                Qtd_Sessoes_Realizadas: isPacote ? venda.pacoteInfo?.sessoesRealizadas : (venda.status === 'realizado' ? 1 : 0),
                Valor_Bruto: venda.valorBruto || 0,
                Desconto: venda.desconto || 0,
                Valor_Liquido: venda.valorLiquido || 0,
                Forma_Pagamento: this.formatarFormaPagamento(venda.formaPagamento),
                Parcelas: venda.parcelas || 1,
                Status: venda.status,
                CMV: getCV('cmv'),
                Impostos: impostos,
                Comissao: getCV('comissao'),
                Taxa_Cartao: getCV('taxa_cartao'),
                Embalagem: getCV('embalagem'),
                Total_CV: venda.totalCustosVariaveis || 0,
                Margem_Contrib: (venda.valorLiquido || 0) - (venda.totalCustosVariaveis || 0),
                Profissional: venda.profissional || 'N/A'
            };
        });

        // 2. Consolidar por Categoria
        const faturamentoCategoria = (aggResults[0].resumoCategoria || []).map(cat => ({
            Categoria: cat._id,
            'Qtd Vendas': cat.qtdVendas,
            'Ticket Médio': cat.qtdVendas > 0 ? (cat.bruto / cat.qtdVendas).toFixed(2) : 0,
            'Faturamento Bruto': cat.bruto || 0,
            'Faturamento Líquido': cat.liquido || 0,
            'Total CV': cat.totalCV || 0,
            'Margem Contrib.': cat.margem || 0,
            '% Margem': cat.liquido > 0 ? ((cat.margem / cat.liquido) * 100).toFixed(2) : 0
        }));

        // 3. Consolidar por Mês
        const faturamentoMes = this.consolidarPorMes(baseDadosAgg, totalCustosFixos);

        return {
            baseDados: analitico,
            faturamentoMes: faturamentoMes,
            faturamentoCategoria: faturamentoCategoria,
            pacotesAndamento: await this.getPacotesEmAndamento(),
            dashboard: this.gerarDashboard(faturamentoMes, analitico)
        };
    }

    formatarFormaPagamento(fp) {
        const map = {
            'dinheiro': 'Dinheiro', 'pix': 'PIX', 'debito': 'Débito',
            'credito_1x': 'Crédito', 'credito_parcelado': 'Crédito',
            'boleto': 'Boleto', 'transferencia': 'Transferência'
        };
        return map[fp] || fp;
    }

    consolidarPorMes(baseDadosAgg, custosFixos) {
        const meses = Array.from({ length: 12 }, (_, i) => ({
            Mes: moment().month(i).format('MMMM'),
            'Qtd Vendas': 0, 'Faturamento Bruto': 0, 'Descontos': 0, 'Faturamento Líquido': 0, 'Total CV': 0, 'Margem Contrib.': 0, '% Margem': 0
        }));

        baseDadosAgg.forEach(v => {
            const mes = moment(v.dataVenda).month();
            meses[mes]['Qtd Vendas'] += 1;
            meses[mes]['Faturamento Bruto'] += (v.valorBruto || 0);
            meses[mes]['Descontos'] += (v.desconto || 0);
            meses[mes]['Faturamento Líquido'] += (v.valorLiquido || 0);
            meses[mes]['Total CV'] += (v.totalCustosVariaveis || 0);
            meses[mes]['Margem Contrib.'] += ((v.valorLiquido || 0) - (v.totalCustosVariaveis || 0));
        });

        meses.forEach(m => {
            if (m['Faturamento Líquido'] > 0) {
                m['% Margem'] = ((m['Margem Contrib.'] / m['Faturamento Líquido']) * 100).toFixed(2);
            }
        });

        const total = {
            Mes: 'TOTAL ANO',
            'Qtd Vendas': meses.reduce((s, m) => s + m['Qtd Vendas'], 0),
            'Faturamento Bruto': meses.reduce((s, m) => s + m['Faturamento Bruto'], 0),
            'Descontos': meses.reduce((s, m) => s + m['Descontos'], 0),
            'Faturamento Líquido': meses.reduce((s, m) => s + m['Faturamento Líquido'], 0),
            'Total CV': meses.reduce((s, m) => s + m['Total CV'], 0),
            'Margem Contrib.': meses.reduce((s, m) => s + m['Margem Contrib.'], 0),
            'Custos Fixos': custosFixos,
            'Lucro Operacional': 0
        };

        total['% Margem'] = total['Faturamento Líquido'] > 0 ? ((total['Margem Contrib.'] / total['Faturamento Líquido']) * 100).toFixed(2) : 0;
        total['Lucro Operacional'] = total['Margem Contrib.'] - total['Custos Fixos'];

        return [...meses, total];
    }

    async getPacotesEmAndamento() {
        const vendasPacote = await Sale.aggregate([
            {
                $match: {
                    tipoVenda: 'pacote',
                    status: { $ne: 'cancelado' },
                    $expr: { $lt: [{ $ifNull: ['$pacoteInfo.sessoesRealizadas', 0] }, { $ifNull: ['$pacoteInfo.totalSessoes', 1] }] }
                }
            },
            { $lookup: { from: 'patients', localField: 'patient', foreignField: '_id', as: 'p' } },
            { $unwind: { path: '$p', preserveNullAndEmptyArrays: true } }
        ]);

        return vendasPacote.map((v, index) => {
            const realizadas = v.pacoteInfo?.sessoesRealizadas || 0;
            const total = v.pacoteInfo?.totalSessoes || 1;
            const valorPorSessao = (v.valorLiquido || 0) / total;

            return {
                ID: index + 1,
                'Data Venda': v.dataVenda ? moment(v.dataVenda).format('YYYY-MM-DD') : moment().format('YYYY-MM-DD'),
                Cliente: v.p?.fullName || 'N/A',
                Pacote: `Pacote ${total} Sessões`,
                'Valor Total': v.valorLiquido || 0,
                'Total Sessões': total,
                Realizadas: realizadas,
                Restantes: total - realizadas,
                '% Concluído': (realizadas / total).toFixed(2),
                'Valor Provisionado': valorPorSessao * realizadas,
                'A Provisionar': valorPorSessao * (total - realizadas)
            };
        });
    }

    gerarDashboard(resumoMes, analitico) {
        const totalAno = resumoMes.find(m => m.Mes === 'TOTAL ANO') || {};
        const vendasRealizadas = analitico.filter(a => a.Status === 'realizado');

        return {
            'FATURAMENTO TOTAL': totalAno['Faturamento Líquido'] || 0,
            'MARGEM DE CONTRIBUIÇÃO': totalAno['Margem Contrib.'] || 0,
            '% MARGEM': totalAno['% Margem'] || 0,
            'TICKET MÉDIO': vendasRealizadas.length > 0
                ? (vendasRealizadas.reduce((s, v) => s + (v.Valor_Liquido || 0), 0) / vendasRealizadas.length).toFixed(2)
                : 0,
            'TOTAL DE VENDAS': analitico.length
        };
    }

    async exportarExcel(mes, ano) {
        const dados = await this.gerarRelatorioAnalitico(mes, ano);
        return {
            abas: [
                { nome: 'Base de Dados', dados: dados.baseDados },
                { nome: 'Faturamento por Mês', dados: dados.faturamentoMes },
                { nome: 'Faturamento por Categoria', dados: dados.faturamentoCategoria },
                { nome: 'Pacotes em Andamento', dados: dados.pacotesAndamento },
                { nome: 'Dashboard', dados: [dados.dashboard] }
            ]
        };
    }
}

export default new ProvisionamentoCompletoService();