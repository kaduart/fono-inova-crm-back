/**
 * 🧪 Testes das Correções em patientDataExtractor
 * Valida extração segura de idade, nomes, período
 */

import { describe, it, expect } from 'vitest';
import {
    extractAgeFromText,
    extractName,
    extractPeriodFromText,
    isValidPatientName
} from '../../utils/patientDataExtractor.js';

describe('✅ Correções - patientDataExtractor', () => {

    describe('🚨 FIX: Idade não extrai de contexto errado (ex: "1 sessão")', () => {
        
        it('"Quero agendar 1 sessão" → NÃO deve extrair idade', () => {
            const result = extractAgeFromText('Quero agendar 1 sessão');
            expect(result).toBeNull();
        });

        it('"Quero 20 sessões" → NÃO deve extrair idade 20', () => {
            const result = extractAgeFromText('Quero 20 sessões');
            expect(result).toBeNull();
        });

        it('"1" (apenas número) → DEVE extrair idade (resposta direta)', () => {
            // Número isolado é aceito como resposta direta à pergunta de idade
            const result = extractAgeFromText('1');
            expect(result).not.toBeNull();
            expect(result.age).toBe(1);
        });

        it('"20" (apenas número) → DEVE extrair idade (resposta direta)', () => {
            // Número isolado é aceito como resposta direta à pergunta de idade
            const result = extractAgeFromText('20');
            expect(result).not.toBeNull();
            expect(result.age).toBe(20);
        });

        it('"Minha filha tem 5 anos" → DEVE extrair idade', () => {
            const result = extractAgeFromText('Minha filha tem 5 anos');
            expect(result).not.toBeNull();
            expect(result.age).toBe(5);
            expect(result.unit).toBe('anos');
        });

        it('"Ela tem 8 anos" → DEVE extrair idade', () => {
            const result = extractAgeFromText('Ela tem 8 anos');
            expect(result).not.toBeNull();
            expect(result.age).toBe(8);
        });

        it('"criança de 7 anos" → DEVE extrair idade', () => {
            const result = extractAgeFromText('criança de 7 anos');
            expect(result).not.toBeNull();
            expect(result.age).toBe(7);
        });

        it('"20 anos" → DEVE extrair idade 20', () => {
            const result = extractAgeFromText('20 anos');
            expect(result).not.toBeNull();
            expect(result.age).toBe(20);
        });
    });

    describe('🆕 FIX: Suporte a bebês (dias e meses)', () => {
        
        it('"7 dias" → DEVE extrair idade com unidade dias', () => {
            const result = extractAgeFromText('Meu bebê tem 7 dias');
            expect(result).not.toBeNull();
            expect(result.age).toBe(7);
            expect(result.unit).toBe('dias');
        });

        it('"10 meses" → DEVE extrair idade com unidade meses', () => {
            const result = extractAgeFromText('Criança de 10 meses');
            expect(result).not.toBeNull();
            expect(result.age).toBe(10);
            expect(result.unit).toBe('meses');
        });

        it('"recém-nascido de 15 dias" → DEVE extrair idade', () => {
            const result = extractAgeFromText('recém-nascido de 15 dias');
            expect(result).not.toBeNull();
            expect(result.age).toBe(15);
            expect(result.unit).toBe('dias');
        });
    });

    describe('✅ FIX: Validação de nomes requer 2+ palavras', () => {
        
        it('"Contato WhatsApp" → DEVE ser rejeitado', () => {
            expect(isValidPatientName('Contato WhatsApp')).toBe(false);
        });

        it('"whatsapp" → DEVE ser rejeitado (1 palavra)', () => {
            expect(isValidPatientName('whatsapp')).toBe(false);
        });

        it('"João Silva" → DEVE ser aceito', () => {
            expect(isValidPatientName('João Silva')).toBe(true);
        });

        it('"Ana Laura" → DEVE ser aceito', () => {
            expect(isValidPatientName('Ana Laura')).toBe(true);
        });

        it('"Maria" (1 palavra) → DEVE ser rejeitado', () => {
            // Requer pelo menos 2 palavras
            expect(isValidPatientName('Maria')).toBe(false);
        });

        it('"Ana" (1 palavra) → DEVE ser rejeitado', () => {
            // Requer pelo menos 2 palavras
            expect(isValidPatientName('Ana')).toBe(false);
        });
    });

    describe('🕐 FIX: Período - manhã NÃO detecta psicologia', () => {
        
        it('"manhã" → DEVE extrair período manhã', () => {
            const result = extractPeriodFromText('Prefiro de manhã');
            expect(result).toBe('manha');
        });

        it('"manha" → DEVE extrair período manhã', () => {
            const result = extractPeriodFromText('Quero pela manha');
            expect(result).toBe('manha');
        });

        it('"tarde" → DEVE extrair período tarde', () => {
            const result = extractPeriodFromText('De tarde é melhor');
            expect(result).toBe('tarde');
        });

        it('"noite" → DEVE extrair período noite', () => {
            const result = extractPeriodFromText('A noite prefiro');
            expect(result).toBe('noite');
        });
    });
});
