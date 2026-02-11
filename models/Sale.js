// models/Sale.js (Venda/Contrato Comercial)
import mongoose from 'mongoose';

const custoVariavelSchema = new mongoose.Schema({
    tipo: {
        type: String,
        enum: ['cmv', 'imposto_simples', 'imposto_pis', 'imposto_cofins',
            'imposto_irpj', 'imposto_csll', 'comissao', 'taxa_cartao',
            'embalagem', 'outro']
    },
    contaContabil: String,  // Ex: "2.1 Custo da Mercadoria Vendida"
    percentual: Number,
    valor: Number,
    descricao: String
}, { _id: false });

const provisionamentoMensalSchema = new mongoose.Schema({
    mesCompetencia: { type: String, required: true }, // "2026-02"
    valorProvisionado: { type: Number, required: true },
    valorRealizado: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ['pendente', 'parcial', 'concluido', 'cancelado'],
        default: 'pendente'
    },
    sessoesContabilizadas: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }],
    dataProvisionamento: { type: Date, default: Date.now }
}, { _id: false });

const saleSchema = new mongoose.Schema({
    // Vínculos
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Leads' },

    // Tipo de venda
    tipoVenda: {
        type: String,
        enum: ['pacote', 'sessao_avulsa', 'produto', 'servico', 'avaliacao'],
        required: true
    },

    // Referências
    package: { type: mongoose.Schema.Types.ObjectId, ref: 'Package' }, // Se for pacote
    produtoServico: { type: mongoose.Schema.Types.ObjectId, ref: 'ProdutoServico' },
    sessions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Session' }], // Sessões vinculadas

    // Datas
    dataVenda: { type: Date, default: Date.now },
    dataAgendamento: Date,
    mesCompetencia: { type: String, required: true }, // "2026-02" (mês da venda)

    // Status
    status: {
        type: String,
        enum: ['agendado', 'confirmado', 'realizado', 'cancelado', 'remarcado'],
        default: 'agendado'
    },

    // Valores
    valorBruto: { type: Number, required: true },
    desconto: { type: Number, default: 0 },
    valorLiquido: { type: Number, required: true },

    // Pagamento
    formaPagamento: {
        type: String,
        enum: ['dinheiro', 'pix', 'debito', 'credito_1x', 'credito_parcelado',
            'boleto', 'transferencia', 'convenio'],
        required: true
    },
    parcelas: { type: Number, default: 1 },
    bandeiraCartao: {
        type: String,
        enum: ['visa', 'mastercard', 'elo', 'hipercard', 'amex', 'diners', 'outros'],
        required: function () {
            return ['debito', 'credito_1x', 'credito_parcelado'].includes(this.formaPagamento);
        }
    },

    dadosCartao: {
        ultimosDigitos: String, // opcional, para identificação
        nsu: String,            // número do comprovante
        codigoAutorizacao: String
    },

    // Custos Variáveis Calculados (cache)
    custosVariaveis: [custoVariavelSchema],
    totalCustosVariaveis: { type: Number, default: 0 },

    // Provisionamento (para pacotes - reconhecimento mensal)
    provisionamento: [provisionamentoMensalSchema],

    // Se for pacote: controle de provisionamento
    pacoteInfo: {
        totalSessoes: Number,
        sessoesRealizadas: { type: Number, default: 0 },
        valorPorSessao: Number, // valorLiquido / totalSessoes
        saldoAProvisionar: Number
    },

    // Flags
    provisionamentoCalculado: { type: Boolean, default: false },
    custosCalculados: { type: Boolean, default: false },

    observacoes: String,
    usuarioCadastro: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Virtuals
saleSchema.virtual('margemContribuicao').get(function () {
    return this.valorLiquido - this.totalCustosVariaveis;
});

saleSchema.virtual('percentualMargem').get(function () {
    return this.valorLiquido > 0
        ? ((this.valorLiquido - this.totalCustosVariaveis) / this.valorLiquido * 100).toFixed(2)
        : 0;
});

// Método para calcular custos variáveis
saleSchema.methods.calcularCustosVariaveis = async function () {
    const ProdutoServico = mongoose.model('ProdutoServico');
    const TaxaCartao = mongoose.model('TaxaCartao');
    const ConfiguracaoFiscal = mongoose.model('ConfiguracaoFiscal');

    const custos = [];
    let total = 0;

    // 1. CMV (Custo da Mercadoria Vendida)
    const produto = await ProdutoServico.findById(this.produtoServico);
    if (produto && produto.custoMercadoria > 0) {
        // Se for pacote, multiplica pela quantidade de sessões
        const quantidade = this.tipoVenda === 'pacote' ? this.pacoteInfo?.totalSessoes || 1 : 1;
        const cmv = produto.custoMercadoria * quantidade;
        custos.push({
            tipo: 'cmv',
            contaContabil: '2.1 Custo da Mercadoria Vendida',
            valor: cmv,
            descricao: `CMV - ${produto.nome}`
        });
        total += cmv;
    }

    // 2. Impostos (buscar configuração fiscal vigente)
    const configFiscal = await ConfiguracaoFiscal.findOne({
        ativo: true,
        $or: [
            { 'vigencia.fim': { $exists: false } },
            { 'vigencia.fim': { $gte: new Date() } }
        ]
    }).sort({ 'vigencia.inicio': -1 });

    if (configFiscal) {
        if (configFiscal.regimeTributario === 'SIMPLES_NACIONAL') {
            const valorImposto = this.valorLiquido * (configFiscal.aliquotas.simples / 100);
            custos.push({
                tipo: 'imposto_simples',
                contaContabil: 'Simples (Federal)',
                percentual: configFiscal.aliquotas.simples,
                valor: valorImposto
            });
            total += valorImposto;
        } else {
            // Lucro Presumido
            const pis = this.valorLiquido * (configFiscal.aliquotas.pis / 100);
            const cofins = this.valorLiquido * (configFiscal.aliquotas.cofins / 100);
            const irpj = this.valorLiquido * (configFiscal.aliquotas.irpj / 100);
            const csll = this.valorLiquido * (configFiscal.aliquotas.csll / 100);

            custos.push(
                { tipo: 'imposto_pis', contaContabil: 'PIS', percentual: configFiscal.aliquotas.pis, valor: pis },
                { tipo: 'imposto_cofins', contaContabil: 'COFINS', percentual: configFiscal.aliquotas.cofins, valor: cofins },
                { tipo: 'imposto_irpj', contaContabil: 'IRPJ', percentual: configFiscal.aliquotas.irpj, valor: irpj },
                { tipo: 'imposto_csll', contaContabil: 'CSLL', percentual: configFiscal.aliquotas.csll, valor: csll }
            );
            total += pis + cofins + irpj + csll;
        }
    }

    // 3. Comissão do Profissional
    if (produto && produto.comissaoPercentual > 0) {
        const comissao = this.valorLiquido * (produto.comissaoPercentual / 100);
        custos.push({
            tipo: 'comissao',
            contaContabil: '2.4 Comissões',
            percentual: produto.comissaoPercentual,
            valor: comissao
        });
        total += comissao;
    }

    // 4. Taxa de Cartão (específica por bandeira)
    if (['debito', 'credito_1x', 'credito_parcelado'].includes(this.formaPagamento)) {
        const bandeira = this.bandeiraCartao || 'visa'; // visa, mastercard, elo, etc
        const parcelas = this.formaPagamento === 'credito_parcelado' ? this.parcelas : 1;
        const tipo = this.formaPagamento === 'debito' ? 'debito' : 'credito';

        const configTaxa = await TaxaCartao.findOne({ bandeira, ativo: true });

        if (configTaxa) {
            const taxaPercentual = configTaxa.getTaxa(tipo, parcelas);
            const valorTaxa = parseFloat((this.valorLiquido * (taxaPercentual / 100)).toFixed(2));

            custos.push({
                tipo: 'taxa_cartao',
                contaContabil: configTaxa.contaContabilPadrao,
                bandeira: bandeira.toUpperCase(),
                parcelas: tipo === 'debito' ? 1 : parcelas,
                percentual: taxaPercentual,
                valor: valorTaxa,
                descricao: `Taxa ${configTaxa.nomeExibicao} ${tipo} ${parcelas}x (${taxaPercentual}%)`
            });
            total += valorTaxa;
        }
    }
    // 5. Embalagem (se produto)
    if (produto && produto.usaEmbalagem && produto.custoEmbalagem > 0) {
        custos.push({
            tipo: 'embalagem',
            contaContabil: '2.6 Embalagens',
            valor: produto.custoEmbalagem
        });
        total += produto.custoEmbalagem;
    }

    this.custosVariaveis = custos;
    this.totalCustosVariaveis = parseFloat(total.toFixed(2));
    this.custosCalculados = true;

    return this.save();
};

// Método para provisionar receita (pacotes)
saleSchema.methods.provisionarReceita = async function (sessionId, dataRealizacao) {
    if (this.tipoVenda !== 'pacote') {
        // Se não for pacote, provisiona tudo no mês da venda
        const mes = this.mesCompetencia;
        this.provisionamento = [{
            mesCompetencia: mes,
            valorProvisionado: this.valorLiquido,
            valorRealizado: this.valorLiquido,
            status: 'concluido',
            dataProvisionamento: new Date()
        }];
        this.provisionamentoCalculado = true;
        return this.save();
    }

    // Para pacotes: provisiona proporcional por sessão
    const mesRealizacao = dataRealizacao.toISOString().slice(0, 7); // "2026-02"
    const valorPorSessao = this.pacoteInfo?.valorPorSessao || (this.valorLiquido / this.pacoteInfo.totalSessoes);

    // Verifica se já existe provisionamento para este mês
    let provMes = this.provisionamento.find(p => p.mesCompetencia === mesRealizacao);

    if (!provMes) {
        provMes = {
            mesCompetencia: mesRealizacao,
            valorProvisionado: 0,
            valorRealizado: 0,
            status: 'pendente',
            sessoesContabilizadas: []
        };
        this.provisionamento.push(provMes);
    }

    // Adiciona valor da sessão
    provMes.valorProvisionado += valorPorSessao;
    provMes.valorRealizado += valorPorSessao;
    provMes.sessoesContabilizadas.push(sessionId);

    // Atualiza contadores do pacote
    this.pacoteInfo.sessoesRealizadas += 1;
    this.pacoteInfo.saldoAProvisionar = this.valorLiquido -
        this.provisionamento.reduce((sum, p) => sum + p.valorRealizado, 0);

    // Atualiza status do provisionamento
    if (this.pacoteInfo.sessoesRealizadas >= this.pacoteInfo.totalSessoes) {
        provMes.status = 'concluido';
        this.provisionamentoCalculado = true;
    } else {
        provMes.status = this.pacoteInfo.saldoAProvisionar <= 0 ? 'concluido' : 'parcial';
    }

    // Recalcula custos proporcionais para esta sessão
    const proporcao = valorPorSessao / this.valorLiquido;
    const custosSessao = this.custosVariaveis.map(custo => ({
        ...custo,
        valor: parseFloat((custo.valor * proporcao).toFixed(2))
    }));

    await this.save();

    return {
        valorProvisionado: valorPorSessao,
        custosVariaveis: custosSessao,
        saldoRestante: this.pacoteInfo.saldoAProvisionar
    };
};

export default mongoose.model('Sale', saleSchema);