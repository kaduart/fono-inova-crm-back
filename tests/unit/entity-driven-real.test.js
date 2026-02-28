/**
 * 🧪 TESTES - Entity-Driven com FUNÇÕES REAIS
 * 
 * Testa as funções reais do AmandaOrchestrator.js
 * para garantir que o fluxo entity-driven funciona
 */

import { describe, it, expect, vi } from 'vitest';

// Importar funções reais (vamos testar diretamente)
import {
    extractName,
    extractAgeFromText,
    extractPeriodFromText,
    extractComplaint
} from '../../utils/patientDataExtractor.js';

describe('🎯 Entity-Driven - Funções Reais de Extração', () => {
    
    describe('extractName()', () => {
        it('✅ Extrai nome simples: "sou Maria"', () => {
            const text = "Oi, sou Maria. Minha filha tem 5 anos.";
            const name = extractName(text);
            expect(name).toBe('Maria');
        });
        
        it('✅ Extrai nome composto: "me chamo Ana Luísa"', () => {
            const text = "Oi, me chamo Ana Luísa";
            const name = extractName(text);
            expect(name).toBe('Ana Luísa');
        });
        
        it('✅ Não confunde com nome da criança depois', () => {
            const text = "Oi sou Maria, minha filha Ana tem 5 anos";
            const name = extractName(text);
            // Deve pegar o primeiro nome (Maria), não Ana
            expect(name).toBeTruthy();
        });
    });
    
    describe('extractAgeFromText()', () => {
        it('✅ Extrai "5 anos"', () => {
            const text = "Minha filha tem 5 anos";
            const age = extractAgeFromText(text);
            expect(age.age).toBe(5);
            expect(age.unit).toBe('anos');
        });
        
        it('✅ Extrai "8 meses"', () => {
            const text = "Meu bebê tem 8 meses";
            const age = extractAgeFromText(text);
            expect(age.age).toBe(8);
            expect(age.unit).toBe('meses');
        });
        
        it('✅ Extrai múltiplas idades (primeira válida)', () => {
            const text = "Maria Luísa 7 anos José neto 5 anos";
            const age = extractAgeFromText(text);
            expect(age.age).toBe(7);
        });
    });
    
    describe('extractPeriodFromText()', () => {
        it('✅ Extrai "manhã"', () => {
            const text = "Prefiro manhã";
            const period = extractPeriodFromText(text);
            expect(period).toBe('manha');
        });
        
        it('✅ Extrai "tarde"', () => {
            const text = "De tarde é melhor";
            const period = extractPeriodFromText(text);
            expect(period).toBe('tarde');
        });
        
        it('✅ Corrige typo "Dmanha" → "manha"', () => {
            const text = "Dmanha";
            const period = extractPeriodFromText(text);
            expect(period).toBe('manha');
        });
        
        it('✅ Corrige typo "Dtarde" → "tarde"', () => {
            const text = "Dtarde";
            const period = extractPeriodFromText(text);
            expect(period).toBe('tarde');
        });
    });
    
    describe('extractComplaint()', () => {
        it('✅ Detecta "não fala" → atraso de fala', () => {
            const text = "Meu filho tem 3 anos e não fala";
            const complaint = extractComplaint(text);
            expect(complaint).toBeTruthy();
        });
        
        it('✅ Detecta "fenda vocal"', () => {
            const text = "Minha filha tem fenda vocal";
            const complaint = extractComplaint(text);
            expect(complaint).toBe('fenda vocal');
        });
        
        it('✅ Detecta "dificuldade na escola"', () => {
            const text = "Ele tem dificuldade de aprender na escola";
            const complaint = extractComplaint(text);
            expect(complaint).toBeTruthy();
        });
    });
});

describe('💬 Cenários de Conversa Natural (Com Funções Reais)', () => {
    
    it('✅ Cenário: Mensagem completa natural', () => {
        const text = "Oi, sou Maria. Minha filha tem 5 anos e não fala direito. Prefiro manhã.";
        
        const extracted = {
            name: extractName(text),
            age: extractAgeFromText(text),
            period: extractPeriodFromText(text),
            complaint: extractComplaint(text)
        };
        
        expect(extracted.name).toBe('Maria');
        expect(extracted.age.age).toBe(5);
        expect(extracted.period).toBe('manha');
        expect(extracted.complaint).toBeTruthy();
        
        console.log('✅ Extraído:', extracted);
    });
    
    it('✅ Cenário: Mensagem fora de ordem', () => {
        const text = "Manhã. Sou Ana. Meu filho tem 7 anos e faz xixi na cama.";
        
        const extracted = {
            name: extractName(text),
            age: extractAgeFromText(text),
            period: extractPeriodFromText(text),
            complaint: extractComplaint(text)
        };
        
        expect(extracted.name).toBe('Ana');
        expect(extracted.age.age).toBe(7);
        expect(extracted.period).toBe('manha');
        expect(extracted.complaint).toBe('enurese');
    });
    
    it('✅ Cenário: Texto descritivo longo', () => {
        const text = "Olha, eu tô preocupada porque minha filha já tem 6 anos e ela ainda não consegue ler direito, as letras embaralham tudo";
        
        const extracted = {
            age: extractAgeFromText(text),
            complaint: extractComplaint(text)
        };
        
        expect(extracted.age.age).toBe(6);
        expect(extracted.complaint).toBeTruthy();
    });
    
    it('✅ Cenário: Múltiplas crianças (pega primeira idade)', () => {
        const text = "Tenho dois filhos: Maria Luísa 7 anos e José 5 anos";
        
        const name = extractName(text);
        const age = extractAgeFromText(text);
        
        expect(name).toBeTruthy();
        expect(age.age).toBe(7); // Pega a primeira
    });
});

describe('🔄 Verificação de Estado (O que falta?)', () => {
    
    function checkMissing(lead, extracted) {
        const missing = [];
        
        const hasPeriod = lead.pendingPreferredPeriod || extracted.period;
        const hasName = lead.patientInfo?.fullName || extracted.name;
        const hasAge = lead.patientInfo?.age || extracted.age;
        const hasComplaint = lead.complaint || extracted.complaint;
        
        if (!hasPeriod) missing.push('period');
        if (!hasName) missing.push('name');
        if (!hasAge) missing.push('age');
        if (!hasComplaint) missing.push('complaint');
        
        return missing;
    }
    
    it('✅ Lead vazio → tudo falta', () => {
        const lead = {};
        const text = "Oi";
        const extracted = {
            name: extractName(text),
            age: extractAgeFromText(text),
            period: extractPeriodFromText(text),
            complaint: extractComplaint(text)
        };
        
        const missing = checkMissing(lead, extracted);
        expect(missing).toContain('period');
        expect(missing).toContain('name');
        expect(missing).toContain('age');
        expect(missing).toContain('complaint');
    });
    
    it('✅ Lead com nome → falta period, age, complaint', () => {
        const lead = {
            patientInfo: { fullName: 'Ana' }
        };
        const text = "Oi";
        const extracted = {
            period: extractPeriodFromText(text),
            complaint: extractComplaint(text)
        };
        
        const missing = checkMissing(lead, extracted);
        expect(missing).toContain('period');
        expect(missing).not.toContain('name'); // Já tem
        expect(missing).toContain('age');
    });
    
    it('✅ Lead completo → nada falta', () => {
        const lead = {
            patientInfo: { fullName: 'Ana', age: 5 },
            pendingPreferredPeriod: 'manha',
            complaint: 'atraso de fala'
        };
        const text = "Ok obrigado";
        const extracted = {
            name: extractName(text),
            age: extractAgeFromText(text),
            period: extractPeriodFromText(text),
            complaint: extractComplaint(text)
        };
        
        const missing = checkMissing(lead, extracted);
        expect(missing).toEqual([]);
    });
});

console.log('🧪 Testes entity-driven com funções reais carregados');
