// models/ProdutoServico.js (Catálogo com custos)
import mongoose from 'mongoose';

const produtoServicoSchema = new mongoose.Schema({
    nome: { type: String, required: true },
    descricao: String,
    tipo: {
        type: String,
        enum: ['pacote', 'sessao_avulsa', 'produto', 'servico', 'avaliacao'],
        required: true
    },
    categoria: {
        type: String,
        enum: ['facial', 'corporal', 'capilar', 'depilacao', 'massagem',
            'fonoaudiologia', 'psicologia', 'terapia_ocupacional', 'fisioterapia',
            'psicomotricidade', 'musicoterapia', 'psicopedagogia', 'produto'],
        required: true
    },

    // Custos para cálculo de margem
    custoMercadoria: { type: Number, default: 0 },    // CMV - Custo da Mercadoria Vendida
    custoEmbalagem: { type: Number, default: 0 },
    usaEmbalagem: { type: Boolean, default: false },

    // Comissões
    comissaoPercentual: { type: Number, default: 10 }, // 10%
    comissaoFixa: { type: Number, default: 0 },

    // Valores
    valorVenda: { type: Number, required: true },
    duracaoMinutos: { type: Number, default: 40 },

    // Estoque (se produto)
    estoqueMinimo: { type: Number, default: 0 },
    estoqueAtual: { type: Number, default: 0 },

    ativo: { type: Boolean, default: true }
}, { timestamps: true });

export default mongoose.model('ProdutoServico', produtoServicoSchema);