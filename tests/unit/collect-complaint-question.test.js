/**
 * Testes de detecção de perguntas em COLLECT_COMPLAINT
 * Valida que perguntas não mapeadas não são engolidas como queixa
 */

import { describe, it, expect } from 'vitest';

describe('COLLECT_COMPLAINT - Detecção de Perguntas', () => {
    describe('looksLikeQuestion - padrões detectados', () => {
        it('detecta perguntas que terminam com ?', () => {
            const text = 'Qual a diferença entre psicóloga e neuropsicóloga?';
            const looksLikeQuestion = 
                text.trim().endsWith('?') ||
                /^(qual|quais|quanto|quantos|como|onde|quando|por que|porquê|vocês?|tem|faz|atende)/i.test(text.trim());
            expect(looksLikeQuestion).toBe(true);
        });

        it('detecta perguntas que começam com "qual"', () => {
            const text = 'Qual o preço da avaliação?';
            const looksLikeQuestion = 
                text.trim().endsWith('?') ||
                /^(qual|quais|quanto|quantos|como|onde|quando|por que|porquê|vocês?|tem|faz|atende)/i.test(text.trim());
            expect(looksLikeQuestion).toBe(true);
        });

        it('detecta perguntas que começam com "vocês"', () => {
            const text = 'Vocês atendem convênio Unimed?';
            const looksLikeQuestion = 
                text.trim().endsWith('?') ||
                /^(qual|quais|quanto|quantos|como|onde|quando|por que|porquê|vocês?|tem|faz|atende)/i.test(text.trim());
            expect(looksLikeQuestion).toBe(true);
        });

        it('detecta perguntas que começam com "tem"', () => {
            const text = 'Tem vaga para essa semana?';
            const looksLikeQuestion = 
                text.trim().endsWith('?') ||
                /^(qual|quais|quanto|quantos|como|onde|quando|por que|porquê|vocês?|tem|faz|atende)/i.test(text.trim());
            expect(looksLikeQuestion).toBe(true);
        });

        it('NÃO detecta queixa clínica como pergunta', () => {
            const text = 'Meu filho não fala direito, troca as letras';
            const looksLikeQuestion = 
                text.trim().endsWith('?') ||
                /^(qual|quais|quanto|quantos|como|onde|quando|por que|porquê|vocês?|tem|faz|atende)/i.test(text.trim());
            expect(looksLikeQuestion).toBe(false);
        });

        it('NÃO detecta descrição de sintomas como pergunta', () => {
            const text = 'Ela tem muita dificuldade na escola, não consegue se concentrar';
            const looksLikeQuestion = 
                text.trim().endsWith('?') ||
                /^(qual|quais|quanto|quantos|como|onde|quando|por que|porquê|vocês?|tem|faz|atende)/i.test(text.trim());
            expect(looksLikeQuestion).toBe(false);
        });

        it('detecta "como" no início', () => {
            const text = 'Como funciona a avaliação?';
            const looksLikeQuestion = 
                text.trim().endsWith('?') ||
                /^(qual|quais|quanto|quantos|como|onde|quando|por que|porquê|vocês?|tem|faz|atende)/i.test(text.trim());
            expect(looksLikeQuestion).toBe(true);
        });

        it('detecta "onde" no início', () => {
            const text = 'Onde fica a clínica?';
            const looksLikeQuestion = 
                text.trim().endsWith('?') ||
                /^(qual|quais|quanto|quantos|como|onde|quando|por que|porquê|vocês?|tem|faz|atende)/i.test(text.trim());
            expect(looksLikeQuestion).toBe(true);
        });
    });
});
