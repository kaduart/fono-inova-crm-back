// services/provisionamentoCompletoService.js
import moment from 'moment-timezone';
import Expense from '../models/Expense.js'; // Seus custos fixos
import Sale from '../models/Sale.js';

class ProvisionamentoCompletoService {



    /**
     * Gera relatório analítico igual à planilha
     */
    async gerarRelatorioAnalitico(mes, ano) {
        const mesCompetencia = `${ano}-${String(mes).padStart(2, '0')}`;
        const startDate = moment(`${mesCompetencia}-01`).startOf('month').toDate();
        const endDate = moment(startDate).endOf('month').toDate();

        // 1. Buscar todas as vendas do mês (por data de venda)
        const vendas = await Sale.find({
            $or: [
                { mesCompetencia: mesCompetencia },
                { dataVenda: { $gte: startDate, $lte: endDate } }
            ],
            status: { $ne: 'cancelado' }
        })
            .populate('patient', 'fullName')
            .populate('doctor', 'fullName')
            .populate('package')
            .populate('produtoServico')
            .lean();

        // 2. Buscar custos fixos do mês
        const custosFixos = await Expense.find({
            date: { $gte: startDate, $lte: endDate },
            status: 'paid'
        }).lean();

        const totalCustosFixos = custosFixos.reduce((sum, c) => sum + c.amount, 0);

        // 3. Processar dados analíticos
        const analitico = vendas.map((venda, index) => {
            const isPacote = venda.tipoVenda === 'pacote';
            const categoria = venda.produtoServico?.categoria || 'Não categorizado';

            // Calcular custos específicos
            const cmv = venda.custosVariaveis?.find(c => c.tipo === 'cmv')?.valor || 0;
            const impostos = venda.custosVariaveis
                ?.filter(c => c.tipo.startsWith('imposto'))
                .reduce((sum, c) => sum + c.valor, 0) || 0;
            const comissao = venda.custosVariaveis?.find(c => c.tipo === 'comissao')?.valor || 0;
            const taxaCartao = venda.custosVariaveis?.find(c => c.tipo === 'taxa_cartao')?.valor || 0;
            const embalagem = venda.custosVariaveis?.find(c => c.tipo === 'embalagem')?.valor || 0;

            const totalCV = venda.totalCustosVariaveis || 0;
            const margemContrib = venda.valorLiquido - totalCV;

            return {
                ID_Venda: venda._id.toString().slice(-6),
                Data_Venda: moment(venda.dataVenda).format('YYYY-MM-DD'),
                Mes: moment(venda.dataVenda).format('MMMM'),
                Ano: ano,
                Cliente: venda.patient?.fullName || 'N/A',
                Tipo_Produto: isPacote ? 'Pacote' : 'Sessão Avulsa',
                Categoria: categoria,
                Produto_Servico: venda.produtoServico?.nome || venda.package?.sessionType || 'N/A',
                Pacote: isPacote ? `Pacote ${venda.pacoteInfo?.totalSessoes} Sessões` : '-',
                Qtd_Sessoes_Total: isPacote ? venda.pacoteInfo?.totalSessoes : 1,
                Qtd_Sessoes_Realizadas: isPacote ? venda.pacoteInfo?.sessoesRealizadas : (venda.status === 'realizado' ? 1 : 0),
                Valor_Bruto: venda.valorBruto,
                Desconto: venda.desconto,
                Valor_Liquido: venda.valorLiquido,
                Forma_Pagamento: this.formatarFormaPagamento(venda.formaPagamento),
                Parcelas: venda.parcelas,
                Status: venda.status,
                Data_Sessao: venda.dataAgendamento ? moment(venda.dataAgendamento).format('YYYY-MM-DD') : '',
                CMV: cmv,
                Impostos: impostos,
                Comissao: comissao,
                Taxa_Cartao: taxaCartao,
                Embalagem: embalagem,
                Total_CV: totalCV,
                Margem_Contrib: margemContrib,
                Profissional: venda.doctor?.fullName || 'N/A'
            };
        });

        // 4. Consolidar por mês
        const resumoMes = this.consolidarPorMes(vendas, totalCustosFixos);

        // 5. Consolidar por categoria
        const resumoCategoria = this.consolidarPorCategoria(analitico);

        // 6. Pacotes em andamento
        const pacotesAndamento = await this.getPacotesEmAndamento();

        // 7. Dashboard
        const dashboard = this.gerarDashboard(resumoMes, analitico);

        return {
            baseDados: analitico,
            faturamentoMes: resumoMes,
            faturamentoCategoria: resumoCategoria,
            pacotesAndamento,
            dashboard
        };
    }

    formatarFormaPagamento(fp) {
        const map = {
            'dinheiro': 'Dinheiro',
            'pix': 'PIX',
            'debito': 'Débito',
            'credito_1x': 'Crédito',
            'credito_parcelado': 'Crédito',
            'boleto': 'Boleto',
            'transferencia': 'Transferência'
        };
        return map[fp] || fp;
    }

    consolidarPorMes(vendas, custosFixos) {
        const meses = Array.from({ length: 12 }, (_, i) => ({
            Mes: moment().month(i).format('MMMM'),
            'Qtd Vendas': 0,
            'Faturamento Bruto': 0,
            'Descontos': 0,
            'Faturamento Líquido': 0,
            'CMV': 0,
            'Impostos': 0,
            'Comissões': 0,
            'Taxas Cartão': 0,
            'Outros CV': 0,
            'Total CV': 0,
            'Margem Contrib.': 0,
            '% Margem': 0
        }));

        vendas.forEach(v => {
            const mes = moment(v.dataVenda).month();
            const cv = v.totalCustosVariaveis || 0;

            meses[mes]['Qtd Vendas'] += 1;
            meses[mes]['Faturamento Bruto'] += v.valorBruto;
            meses[mes]['Descontos'] += v.desconto;
            meses[mes]['Faturamento Líquido'] += v.valorLiquido;
            meses[mes]['Total CV'] += cv;
            meses[mes]['Margem Contrib.'] += (v.valorLiquido - cv);
        });

        // Calcular percentuais
        meses.forEach(m => {
            if (m['Faturamento Líquido'] > 0) {
                m['% Margem'] = ((m['Margem Contrib.'] / m['Faturamento Líquido']) * 100).toFixed(2);
                m['% CV'] = ((m['Total CV'] / m['Faturamento Líquido']) * 100).toFixed(2);
            }
        });

        // Adicionar linha TOTAL
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

        total['% Margem'] = total['Faturamento Líquido'] > 0
            ? ((total['Margem Contrib.'] / total['Faturamento Líquido']) * 100).toFixed(2)
            : 0;
        total['Lucro Operacional'] = total['Margem Contrib.'] - total['Custos Fixos'];

        return [...meses, total];
    }

    consolidarPorCategoria(analitico) {
        const categorias = {};

        analitico.forEach(item => {
            const cat = item.Categoria;
            if (!categorias[cat]) {
                categorias[cat] = {
                    Categoria: cat,
                    'Qtd Vendas': 0,
                    'Ticket Médio': 0,
                    'Faturamento Bruto': 0,
                    'Descontos': 0,
                    'Faturamento Líquido': 0,
                    'Total CV': 0,
                    'Margem Contrib.': 0,
                    '% Margem': 0
                };
            }

            categorias[cat]['Qtd Vendas'] += 1;
            categorias[cat]['Faturamento Bruto'] += item.Valor_Bruto;
            categorias[cat]['Descontos'] += item.Desconto;
            categorias[cat]['Faturamento Líquido'] += item.Valor_Liquido;
            categorias[cat]['Total CV'] += item.Total_CV;
            categorias[cat]['Margem Contrib.'] += item.Margem_Contrib;
        });

        // Calcular ticket médio e percentuais
        Object.values(categorias).forEach(cat => {
            cat['Ticket Médio'] = cat['Qtd Vendas'] > 0
                ? (cat['Faturamento Bruto'] / cat['Qtd Vendas']).toFixed(2)
                : 0;
            cat['% Margem'] = cat['Faturamento Líquido'] > 0
                ? ((cat['Margem Contrib.'] / cat['Faturamento Líquido']) * 100).toFixed(2)
                : 0;
            cat['% Participação'] = 0; // Calcular depois em relação ao total
        });

        return Object.values(categorias);
    }

    async getPacotesEmAndamento() {
        const vendasPacote = await Sale.find({
            tipoVenda: 'pacote',
            status: { $ne: 'cancelado' },
            $expr: { $lt: ['$pacoteInfo.sessoesRealizadas', '$pacoteInfo.totalSessoes'] }
        })
            .populate('patient', 'fullName')
            .populate('package')
            .lean();

        return vendasPacote.map((v, index) => {
            const realizadas = v.pacoteInfo?.sessoesRealizadas || 0;
            const total = v.pacoteInfo?.totalSessoes || 1;
            const percentual = ((realizadas / total) * 100).toFixed(0);
            const valorPorSessao = v.valorLiquido / total;

            return {
                ID: index + 1,
                'Data Venda': moment(v.dataVenda).format('YYYY-MM-DD'),
                Cliente: v.patient?.fullName,
                Pacote: `Pacote ${total} Sessões`,
                Categoria: v.produtoServico?.categoria || 'N/A',
                'Valor Total': v.valorLiquido,
                'Total Sessões': total,
                Realizadas: realizadas,
                Restantes: total - realizadas,
                '% Concluído': percentual / 100, // Para formato Excel
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
                ? (vendasRealizadas.reduce((s, v) => s + v.Valor_Liquido, 0) / vendasRealizadas.length).toFixed(2)
                : 0,
            'TOTAL DE VENDAS': analitico.length
        };
    }

    /**
     * Exporta para Excel no formato exato da planilha
     */
    async exportarExcel(mes, ano) {
        const dados = await this.gerarRelatorioAnalitico(mes, ano);

        // Aqui você integraria com biblioteca exceljs ou xlsx
        // Retornando estrutura pronta para exportação

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