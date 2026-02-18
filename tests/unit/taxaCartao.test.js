/**
 * Testes Unitários - TaxaCartao Model
 * 
 * Estes testes garantem que o cálculo de taxas de cartão está correto
 * e servem como documentação dos valores esperados.
 * 
 * ⚠️ CRÍTICO: Se estes testes falharem, os cálculos financeiros estão errados!
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import TaxaCartao from '../../models/TaxaCartao.js';

// Configuração de teste
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/clinica_test';

describe('TaxaCartao Model', () => {
    beforeAll(async () => {
        await mongoose.connect(MONGODB_URI);
        await TaxaCartao.deleteMany({});
        
        // Seed com dados reais da clínica
        await TaxaCartao.create([
            {
                bandeira: 'visa',
                nomeExibicao: 'Visa',
                debito: { taxa: 0.90, prazoRecebimento: 1 },
                credito: [
                    { ateParcelas: 1, taxaPercentual: 1.85 },
                    { ateParcelas: 6, taxaPercentual: 2.29 },
                    { ateParcelas: 12, taxaPercentual: 2.53 }
                ]
            },
            {
                bandeira: 'mastercard',
                nomeExibicao: 'Mastercard',
                debito: { taxa: 0.90, prazoRecebimento: 1 },
                credito: [
                    { ateParcelas: 1, taxaPercentual: 1.85 },
                    { ateParcelas: 6, taxaPercentual: 2.29 },
                    { ateParcelas: 12, taxaPercentual: 2.53 }
                ]
            },
            {
                bandeira: 'elo',
                nomeExibicao: 'Elo',
                debito: { taxa: 1.45, prazoRecebimento: 1 },
                credito: [
                    { ateParcelas: 1, taxaPercentual: 2.40 },
                    { ateParcelas: 6, taxaPercentual: 2.94 },
                    { ateParcelas: 12, taxaPercentual: 3.18 }
                ]
            },
            {
                bandeira: 'amex',
                nomeExibicao: 'American Express',
                debito: null,
                credito: [
                    { ateParcelas: 1, taxaPercentual: 2.35 },
                    { ateParcelas: 6, taxaPercentual: 2.89 },
                    { ateParcelas: 12, taxaPercentual: 3.13 }
                ]
            }
        ]);
    });

    afterAll(async () => {
        await mongoose.disconnect();
    });

    describe('getTaxa() - Débito', () => {
        it('Visa débito deve retornar 0.90%', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'visa' });
            expect(taxa.getTaxa('debito')).toBe(0.90);
        });

        it('Mastercard débito deve retornar 0.90%', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'mastercard' });
            expect(taxa.getTaxa('debito')).toBe(0.90);
        });

        it('Elo débito deve retornar 1.45%', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'elo' });
            expect(taxa.getTaxa('debito')).toBe(1.45);
        });

        it('Amex débito deve retornar 0 (não disponível)', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'amex' });
            expect(taxa.getTaxa('debito')).toBe(0);
        });
    });

    describe('getTaxa() - Crédito à vista (1x)', () => {
        it('Visa crédito 1x deve retornar 1.85%', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'visa' });
            expect(taxa.getTaxa('credito', 1)).toBe(1.85);
        });

        it('Mastercard crédito 1x deve retornar 1.85%', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'mastercard' });
            expect(taxa.getTaxa('credito', 1)).toBe(1.85);
        });

        it('Elo crédito 1x deve retornar 2.40%', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'elo' });
            expect(taxa.getTaxa('credito', 1)).toBe(2.40);
        });

        it('Amex crédito 1x deve retornar 2.35%', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'amex' });
            expect(taxa.getTaxa('credito', 1)).toBe(2.35);
        });
    });

    describe('getTaxa() - Crédito parcelado', () => {
        it('Visa crédito 3x deve retornar 2.29% (faixa até 6x)', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'visa' });
            expect(taxa.getTaxa('credito', 3)).toBe(2.29);
        });

        it('Visa crédito 6x deve retornar 2.29% (limite da faixa)', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'visa' });
            expect(taxa.getTaxa('credito', 6)).toBe(2.29);
        });

        it('Visa crédito 9x deve retornar 2.53% (faixa até 12x)', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'visa' });
            expect(taxa.getTaxa('credito', 9)).toBe(2.53);
        });

        it('Visa crédito 12x deve retornar 2.53% (limite da faixa)', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'visa' });
            expect(taxa.getTaxa('credito', 12)).toBe(2.53);
        });

        it('Elo crédito 6x deve retornar 2.94%', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'elo' });
            expect(taxa.getTaxa('credito', 6)).toBe(2.94);
        });
    });

    describe('Cálculos de valor com taxas', () => {
        it('Valor de R$ 100 em Visa débito deve ter taxa de R$ 0.90', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'visa' });
            const percentual = taxa.getTaxa('debito');
            const valor = 100;
            const valorTaxa = (valor * percentual) / 100;
            expect(valorTaxa).toBe(0.90);
        });

        it('Valor de R$ 250 em Visa crédito 1x deve ter taxa de R$ 4.625', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'visa' });
            const percentual = taxa.getTaxa('credito', 1);
            const valor = 250;
            const valorTaxa = (valor * percentual) / 100;
            expect(valorTaxa).toBe(4.625);
        });

        it('Valor de R$ 500 em Elo crédito 6x deve ter taxa de R$ 14.70', async () => {
            const taxa = await TaxaCartao.findOne({ bandeira: 'elo' });
            const percentual = taxa.getTaxa('credito', 6);
            const valor = 500;
            const valorTaxa = (valor * percentual) / 100;
            expect(valorTaxa).toBe(14.70);
        });
    });
});
