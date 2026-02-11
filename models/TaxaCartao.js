// models/TaxaCartao.js (Atualizado)
import mongoose from 'mongoose';

const faixaParcelaSchema = new mongoose.Schema({
    ateParcelas: { type: Number, required: true },  // 1, 6, 12
    taxaPercentual: { type: Number, required: true } // 1.85, 2.29, 2.53
}, { _id: false });

const taxaCartaoSchema = new mongoose.Schema({
    bandeira: {
        type: String,
        enum: ['visa', 'mastercard', 'elo', 'hipercard', 'amex', 'diners', 'outros'],
        required: true
    },

    nomeExibicao: { type: String, required: true }, // "Visa", "Mastercard", "Elo"

    // Taxas Débito (geralmente 1x)
    debito: {
        taxa: { type: Number, required: true },      // 0.90, 1.45
        prazoRecebimento: { type: Number, default: 1 } // dias
    },

    // Taxas Crédito (múltiplas faixas)
    credito: [faixaParcelaSchema], // [{ateParcelas: 1, taxa: 1.85}, {ateParcelas: 6, taxa: 2.29}]

    // Configurações
    ativo: { type: Boolean, default: true },
    contaContabilPadrao: { type: String, default: '2.5 Taxa de Cobrança Cartão de Crédito' },

    // Identificação visual (para o frontend)
    cor: String,  // hex color
    icone: String // URL ou classe CSS

}, { timestamps: true });

// Índice para busca rápida
taxaCartaoSchema.index({ bandeira: 1, ativo: 1 });

// Método para calcular taxa baseado no número de parcelas
taxaCartaoSchema.methods.getTaxa = function (tipo, parcelas = 1) {
    if (tipo === 'debito') {
        return this.debito?.taxa || 0;
    }

    // Crédito: encontra a faixa correta
    if (!this.credito || this.credito.length === 0) return 0;

    // Ordena por parcelas e encontra a maior faixa que comporta o número de parcelas
    const faixas = this.credito.sort((a, b) => a.ateParcelas - b.ateParcelas);
    const faixa = faixas.find(f => parcelas <= f.ateParcelas);

    return faixa ? faixa.taxaPercentual : faixas[faixas.length - 1].taxaPercentual;
};

export default mongoose.model('TaxaCartao', taxaCartaoSchema);