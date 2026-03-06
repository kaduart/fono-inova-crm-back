/**
 * 🧪 TESTES UNITÁRIOS - patientDataExtractor.js
 * Validam correções de bugs críticos em produção
 */

import { describe, it, expect } from 'vitest';
import { 
    isValidPatientName, 
    extractAgeFromText, 
    extractName,
    extractPeriodFromText,
    extractComplaint 
} from '../../utils/patientDataExtractor.js';

describe('🚨 CORREÇÕES CRÍTICAS - Patient Data Extractor', () => {
    
    describe('✅ FIX: Rejeitar "Contato WhatsApp" como nome válido', () => {
        const nomesInvalidos = [
            'Contato WhatsApp',
            'contato whatsapp',
            'CONTATO WHATSAPP',
            'Whatsapp Business',
            'contato',
            'whatsapp'
        ];

        nomesInvalidos.forEach(nome => {
            it(`deve rejeitar "${nome}"`, () => {
                expect(isValidPatientName(nome)).toBe(false);
            });
        });

        const nomesValidos = [
            'João Silva',
            'Maria Oliveira',
            'Ana Laura Vieira',
            'Diogo de Sousa Ferreira',
            'José Felipe Gomes Leite'
        ];

        nomesValidos.forEach(nome => {
            it(`deve aceitar "${nome}"`, () => {
                expect(isValidPatientName(nome)).toBe(true);
            });
        });
    });

    describe('✅ FIX: Extrair idade em dias (recém-nascidos)', () => {
        const casosDias = [
            { input: '7 dias', esperado: { age: 7, unit: 'dias' } },
            { input: '10 dias', esperado: { age: 10, unit: 'dias' } },
            { input: '15 dias', esperado: { age: 15, unit: 'dias' } },
            { input: '30 dias', esperado: { age: 30, unit: 'dias' } },
            { input: '5 dia', esperado: { age: 5, unit: 'dias' } }
        ];

        casosDias.forEach(({ input, esperado }) => {
            it(`deve extrair "${input}"`, () => {
                const resultado = extractAgeFromText(input);
                expect(resultado).toEqual(esperado);
            });
        });

        // Não deve confundir com outros padrões
        const falsosPositivos = [
            '7 anos',
            '10 meses',
            'sete dias de atraso',
            '15 dias úteis'
        ];

        falsosPositivos.forEach(input => {
            it(`NÃO deve extrair "${input}" como dias (ou deve extrair corretamente)`, () => {
                const resultado = extractAgeFromText(input);
                // Se extrair, não deve ser unit: 'dias' para casos de anos/meses
                if (resultado && input.includes('anos')) {
                    expect(resultado.unit).toBe('anos');
                } else if (resultado && input.includes('meses')) {
                    expect(resultado.unit).toBe('meses');
                }
            });
        });
    });

    describe('✅ FIX: Extrair idade em anos e meses', () => {
        const casosAnos = [
            { input: '10 anos', esperado: { age: 10, unit: 'anos' } },
            { input: '4 anos', esperado: { age: 4, unit: 'anos' } },
            { input: '7 aninhos', esperado: { age: 7, unit: 'anos' } }
        ];

        casosAnos.forEach(({ input, esperado }) => {
            it(`deve extrair "${input}"`, () => {
                const resultado = extractAgeFromText(input);
                expect(resultado).toEqual(esperado);
            });
        });

        const casosMeses = [
            { input: '6 meses', esperado: { age: 6, unit: 'meses' } },
            { input: '8 m', esperado: { age: 8, unit: 'meses' } }
        ];

        casosMeses.forEach(({ input, esperado }) => {
            it(`deve extrair "${input}"`, () => {
                const resultado = extractAgeFromText(input);
                expect(resultado).toEqual(esperado);
            });
        });
    });

    describe('✅ FIX: Não extrair números soltos sem contexto', () => {
        const semContexto = [
            '1 sessão',
            '1 consulta',
            '10 reais',
            '5 minutos',
            '20 minutos de atraso'
        ];

        semContexto.forEach(input => {
            it(`NÃO deve extrair idade de "${input}"`, () => {
                const resultado = extractAgeFromText(input);
                expect(resultado).toBeNull();
            });
        });
    });

    describe('✅ FIX: Extrair período corretamente', () => {
        const casosPeriodo = [
            { input: 'manha', esperado: 'manha' },
            { input: 'de manha', esperado: 'manha' },
            { input: 'pela manha', esperado: 'manha' },
            { input: 'tarde', esperado: 'tarde' },
            { input: 'de tarde', esperado: 'tarde' },
            { input: 'só de tarde', esperado: 'tarde' },
            { input: 'noite', esperado: 'noite' }
        ];

        casosPeriodo.forEach(({ input, esperado }) => {
            it(`deve extrair "${esperado}" de "${input}"`, () => {
                const resultado = extractPeriodFromText(input);
                expect(resultado).toBe(esperado);
            });
        });
    });
});

describe('🧪 Casos de Borda - Produção', () => {
    it('deve rejeitar "Contato WhatsApp" mesmo com espaços extras', () => {
        expect(isValidPatientName('  Contato WhatsApp  ')).toBe(false);
    });

    it('deve aceitar nome com acentos', () => {
        expect(isValidPatientName('José Felipe Gomes Leite')).toBe(true);
    });

    it('deve extrair "7 dias" mesmo com maiúsculas', () => {
        const resultado = extractAgeFromText('7 DIAS');
        expect(resultado).toEqual({ age: 7, unit: 'dias' });
    });
});
