/**
 * 🔄 TESTES DE FLUXO DE TRIAGEM
 * 
 * Esses testes verificam que o fluxo de triagem funciona corretamente
 * sem depender de conexão com MongoDB
 */

import { describe, it, expect } from 'vitest';
import { extractName, extractAgeFromText, extractPeriodFromText } from '../../utils/patientDataExtractor.js';

describe('🔄 TRIAGE FLOW', () => {
    
    describe('Extração sequencial de dados do paciente', () => {
        
        it('Deve extrair nome e idade de múltiplas crianças na mesma mensagem', () => {
            const msg = 'Maria Luísa 7 anos José neto 5 anos Catarina 3 anos';
            
            const nome = extractName(msg);
            const idade = extractAgeFromText(msg);
            
            // Deve extrair o primeiro nome completo
            expect(nome).toBe('Maria Luísa');
            // Deve extrair a primeira idade
            expect(idade).toEqual({ age: 7, unit: 'anos' });
        });

        it('Deve detectar período mesmo com erro de digitação Dmanha/Dtarde', () => {
            const casos = [
                { input: 'Dmanha', expected: 'manha' },
                { input: 'dmanha', expected: 'manha' },
                { input: 'Dtarde', expected: 'tarde' },
                { input: 'dtarde', expected: 'tarde' },
                { input: 'Dnoite', expected: 'noite' },
            ];

            casos.forEach(({ input, expected }) => {
                const result = extractPeriodFromText(input);
                expect(result).toBe(expected);
            });
        });

        it('Deve extrair nome mesmo quando vem depois de "me chamo"', () => {
            const casos = [
                { input: 'me chamo Ana Paula', expected: 'Ana Paula' },
                { input: 'meu nome é João Silva', expected: 'João Silva' },
                { input: 'nome: Maria Luísa', expected: 'Maria Luísa' },
                { input: 'paciente - Pedro Henrique', expected: 'Pedro Henrique' },
            ];

            casos.forEach(({ input, expected }) => {
                const result = extractName(input);
                expect(result).toBe(expected);
            });
        });
    });

    describe('Resiliência a variações de input', () => {
        
        it('Deve lidar com diferentes formas de especificar período', () => {
            const variacoesManha = [
                'manha', 'manhã', 'Manhã', 'MANHA',
                'de manhã', 'pela manhã', 'na manhã',
                'Dmanha', 'dmanha'
            ];

            variacoesManha.forEach(input => {
                const result = extractPeriodFromText(input);
                expect(result).toBe('manha');
            });
        });

        it('Deve lidar com diferentes formas de especificar idade', () => {
            const casos = [
                { input: '7 anos', expected: { age: 7, unit: 'anos' } },
                { input: 'tem 7 anos', expected: { age: 7, unit: 'anos' } },
                { input: '3 meses', expected: { age: 3, unit: 'meses' } },
                { input: 'com 10 anos', expected: { age: 10, unit: 'anos' } },
            ];

            casos.forEach(({ input, expected }) => {
                const result = extractAgeFromText(input);
                expect(result).toEqual(expected);
            });
        });

        it('Deve retornar null para nome inválido ou incompleto', () => {
            const casos = [
                '7 anos',  // só idade
                'Pedro',     // só primeiro nome
                '12345',    // só números
                '',         // vazio
            ];

            casos.forEach(input => {
                const result = extractName(input);
                expect(result).toBeNull();
            });
        });
    });

    describe('Simulação de fluxo completo de triagem', () => {
        
        it('Fluxo: usuário responde tudo de uma vez (período + nome + idade)', () => {
            // Caso real: usuário manda nome com idade, e período separado ou junto
            const msgNome = 'Maria Luísa 7 anos';
            const msgPeriodo = 'Quero de manhã';
            
            const dadosExtraidos = {
                periodo: extractPeriodFromText(msgPeriodo),
                nome: extractName(msgNome),
                idade: extractAgeFromText(msgNome)
            };
            
            expect(dadosExtraidos.periodo).toBe('manha');
            expect(dadosExtraidos.nome).toBe('Maria Luísa');
            expect(dadosExtraidos.idade).toEqual({ age: 7, unit: 'anos' });
            
            // Se todos os dados foram extraídos, não precisa perguntar nada
            const dadosCompletos = dadosExtraidos.periodo && 
                                   dadosExtraidos.nome && 
                                   dadosExtraidos.idade !== null;
            expect(dadosCompletos).toBe(true);
        });

        it('Fluxo: usuário responde apenas período (nome/idade faltando)', () => {
            const msgPeriodo = 'tarde';
            
            const periodo = extractPeriodFromText(msgPeriodo);
            const nome = extractName(msgPeriodo);
            const idade = extractAgeFromText(msgPeriodo);
            
            expect(periodo).toBe('tarde');
            expect(nome).toBeNull();
            expect(idade).toBeNull();
            
            // Precisa perguntar nome e idade
            const precisaNome = !nome;
            const precisaIdade = !idade;
            expect(precisaNome).toBe(true);
            expect(precisaIdade).toBe(true);
        });

        it('Fluxo: usuário responde nome com erro de digitação mobile (Dmanha)', () => {
            const msg = 'Dmanha';
            const msgNome = 'Pedro Henrique 5 anos';
            
            const dadosExtraidos = {
                periodo: extractPeriodFromText(msg),
                nome: extractName(msgNome),
                idade: extractAgeFromText(msgNome)
            };
            
            // Deve normalizar Dmanha → manha
            expect(dadosExtraidos.periodo).toBe('manha');
            expect(dadosExtraidos.nome).toBe('Pedro Henrique');
            expect(dadosExtraidos.idade).toEqual({ age: 5, unit: 'anos' });
        });

        it('Fluxo: múltiplas mensagens para completar dados', () => {
            // Mensagem 1: Só o período com erro de digitação
            const msg1 = 'Dmanha';
            const periodo = extractPeriodFromText(msg1);
            expect(periodo).toBe('manha');
            
            // Mensagem 2: Nome e idade de múltiplas crianças
            const msg2 = 'Maria Luísa 7 anos José neto 5 anos';
            const nome = extractName(msg2);
            const idade = extractAgeFromText(msg2);
            expect(nome).toBe('Maria Luísa');
            expect(idade).toEqual({ age: 7, unit: 'anos' });
            
            // Agora temos dados completos da primeira criança
            // O sistema pode perguntar sobre as outras crianças depois
        });
    });
});

console.log('🔄 Testes de fluxo de triagem carregados');
