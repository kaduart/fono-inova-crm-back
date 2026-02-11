// scripts/seedTaxasCartao.js
import TaxaCartao from '../models/TaxaCartao.js';

const taxasReais = [
    {
        bandeira: 'visa',
        nomeExibicao: 'Visa',
        debito: { taxa: 0.90, prazoRecebimento: 1 },
        credito: [
            { ateParcelas: 1, taxaPercentual: 1.85 },   // À vista
            { ateParcelas: 6, taxaPercentual: 2.29 },   // Até 6x
            { ateParcelas: 12, taxaPercentual: 2.53 }   // Até 12x
        ],
        cor: '#1A1F71'
    },
    {
        bandeira: 'mastercard',
        nomeExibicao: 'Mastercard',
        debito: { taxa: 0.90, prazoRecebimento: 1 },
        credito: [
            { ateParcelas: 1, taxaPercentual: 1.85 },
            { ateParcelas: 6, taxaPercentual: 2.29 },
            { ateParcelas: 12, taxaPercentual: 2.53 }
        ],
        cor: '#EB001B'
    },
    {
        bandeira: 'diners',
        nomeExibicao: 'Diners Club',
        debito: null, // N/A na imagem
        credito: [
            { ateParcelas: 1, taxaPercentual: 1.85 }
            // N/A para 6x e 12x conforme imagem
        ],
        cor: '#004E94'
    },
    {
        bandeira: 'elo',
        nomeExibicao: 'Elo',
        debito: { taxa: 1.45, prazoRecebimento: 1 },
        credito: [
            { ateParcelas: 1, taxaPercentual: 2.40 },
            { ateParcelas: 6, taxaPercentual: 2.94 },
            { ateParcelas: 12, taxaPercentual: 3.18 }
        ],
        cor: '#00A0E3'
    },
    {
        bandeira: 'amex',
        nomeExibicao: 'American Express',
        debito: null, // Geralmente não tem débito
        credito: [
            { ateParcelas: 1, taxaPercentual: 2.35 },
            { ateParcelas: 6, taxaPercentual: 2.89 },
            { ateParcelas: 12, taxaPercentual: 3.13 }
        ],
        cor: '#016FD0'
    }
];

async function seedTaxas() {
    for (const taxa of taxasReais) {
        await TaxaCartao.findOneAndUpdate(
            { bandeira: taxa.bandeira },
            taxa,
            { upsert: true, new: true }
        );
    }
    console.log('✅ Taxas de cartão atualizadas com dados reais da clínica');
}

export default seedTaxas;