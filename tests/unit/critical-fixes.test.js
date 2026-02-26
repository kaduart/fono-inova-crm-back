/**
 * 🧪 TESTES UNITÁRIOS CRÍTICOS
 * 
 * Esses testes garantem que as correções não quebrem:
 * 1. Carregamento do triageStep
 * 2. Extração de nome com idade
 * 3. Detecção de período (incluindo erros de digitação)
 * 4. Variáveis definidas corretamente
 */

import { describe, it, expect } from 'vitest';
import { extractName, extractAgeFromText, extractPeriodFromText } from '../../utils/patientDataExtractor.js';

describe('🎯 CRITICAL FIXES', () => {
    
    describe('extractName - Deve extrair nome mesmo com idade na mensagem', () => {
        const testCases = [
            {
                input: 'Maria Luísa 7 anos José neto 5 anos Catarina 3 anos',
                expected: 'Maria Luísa',
                description: 'Múltiplas crianças com idades - pega primeiro nome'
            },
            {
                input: 'João Silva 10 anos',
                expected: 'João Silva',
                description: 'Nome simples seguido de idade'
            },
            {
                input: 'Ana Maria 3 meses',
                expected: 'Ana Maria',
                description: 'Nome composto com meses'
            },
            {
                input: 'Pedro 5',
                expected: null, // Muito curto, não é nome completo
                description: 'Só primeiro nome sem sobrenome'
            },
            {
                input: 'Maria Luísa',
                expected: 'Maria Luísa',
                description: 'Nome sem idade (caso base)'
            }
        ];

        testCases.forEach(({ input, expected, description }) => {
            it(`✅ ${description}: "${input}" → "${expected}"`, () => {
                const result = extractName(input);
                expect(result).toBe(expected);
            });
        });
    });

    describe('extractPeriodFromText - Deve detectar período mesmo com erros de digitação', () => {
        const testCases = [
            {
                input: 'Dmanha',
                expected: 'manha',
                description: 'Erro comum mobile: D grudado no início'
            },
            {
                input: 'dmanha',
                expected: 'manha',
                description: 'dmanha minúsculo'
            },
            {
                input: 'Dtarde',
                expected: 'tarde',
                description: 'D grudado em tarde'
            },
            {
                input: 'Manhã',
                expected: 'manha',
                description: 'Manhã correto com acento'
            },
            {
                input: 'manha',
                expected: 'manha',
                description: 'manha sem acento'
            },
            {
                input: 'de manhã',
                expected: 'manha',
                description: 'de manhã com espaço'
            },
            {
                input: 'pela manhã',
                expected: 'manha',
                description: 'pela manhã'
            },
            {
                input: 'tarde',
                expected: 'tarde',
                description: 'tarde simples'
            },
            {
                input: 'TARDE',
                expected: 'tarde',
                description: 'TARDE maiúsculo'
            }
        ];

        testCases.forEach(({ input, expected, description }) => {
            it(`✅ ${description}: "${input}" → "${expected}"`, () => {
                const result = extractPeriodFromText(input);
                expect(result).toBe(expected);
            });
        });
    });

    describe('extractAgeFromText - Deve extrair idade corretamente', () => {
        const testCases = [
            {
                input: 'Maria 7 anos',
                expected: { age: 7, unit: 'anos' },
                description: 'Idade em anos'
            },
            {
                input: 'João 3 meses',
                expected: { age: 3, unit: 'meses' },
                description: 'Idade em meses'
            },
            {
                input: 'tem 10 anos',
                expected: { age: 10, unit: 'anos' },
                description: 'tem X anos'
            },
            {
                input: '5 anos',
                expected: { age: 5, unit: 'anos' },
                description: 'Só número e unidade'
            }
        ];

        testCases.forEach(({ input, expected, description }) => {
            it(`✅ ${description}: "${input}" → ${JSON.stringify(expected)}`, () => {
                const result = extractAgeFromText(input);
                expect(result).toEqual(expected);
            });
        });
    });

    describe('🔒 Variáveis definidas - Não deve ter erros de "text is not defined"', () => {
        it('Deve garantir que todas as funções usem parâmetros corretos', () => {
            // Este teste verifica se as funções estão definidas e aceitam os parâmetros esperados
            expect(typeof extractName).toBe('function');
            expect(typeof extractAgeFromText).toBe('function');
            expect(typeof extractPeriodFromText).toBe('function');
            
            // Verifica que as funções não lançam erros de variável não definida
            expect(() => extractName('teste')).not.toThrow();
            expect(() => extractAgeFromText('10 anos')).not.toThrow();
            expect(() => extractPeriodFromText('manha')).not.toThrow();
        });
    });
});

console.log('🧪 Testes críticos carregados');
